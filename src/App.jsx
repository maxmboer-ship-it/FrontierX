import React, { useState, useMemo } from "react";
import { track } from "@vercel/analytics";
import * as math from "mathjs";
import {
  Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ComposedChart, Area, AreaChart, PieChart, Pie, Cell,
} from "recharts";

/* ═══════════════ MATH CORE ═══════════════ */

function buildCov(assets, corr) {
  const n = assets.length, S = [];
  for (let i = 0; i < n; i++) {
    S.push([]);
    for (let j = 0; j < n; j++) {
      // Defensive: a short/ragged corr row must degrade to a default, never throw.
      // Throwing here unmounts the whole app and renders a blank page.
      const row = corr[Math.min(i, j)];
      const raw = row ? row[Math.max(i, j)] : undefined;
      const rho = i === j ? 1 : (isFinite(raw) ? raw : 0.35);
      S[i].push(rho * (assets[i].sigma / 100) * (assets[j].sigma / 100));
    }
  }
  return S;
}
function portStats(w, mu, S) {
  const ret = w.reduce((s, wi, i) => s + wi * mu[i], 0);
  let v = 0;
  for (let i = 0; i < w.length; i++)
    for (let j = 0; j < w.length; j++) v += w[i] * w[j] * S[i][j];
  return { ret, sigma: Math.sqrt(Math.max(v, 0)) };
}
function solveUnconstrained(mu, S, rf) {
  try {
    const Sinv = math.inv(S);
    const ones = mu.map(() => 1);
    const excess = mu.map((m) => m - rf);
    const tRaw = math.multiply(Sinv, excess);
    const tSum = tRaw.reduce((a, b) => a + b, 0);
    if (!(tSum > 1e-9)) return null;
    const mRaw = math.multiply(Sinv, ones);
    const mSum = mRaw.reduce((a, b) => a + b, 0);
    return { wTan: tRaw.map((x) => x / tSum), wMin: mRaw.map((x) => x / mSum) };
  } catch { return null; }
}
function solveLongOnly(mu, S, rf, n) {
  let bestTan = null, bestSh = -Infinity, bestMin = null, bestV = Infinity;
  const randW = () => {
    const e = Array.from({ length: n }, () => -Math.log(Math.random()));
    const s = e.reduce((a, b) => a + b, 0);
    return e.map((x) => x / s);
  };
  for (let k = 0; k < 6000; k++) {
    const w = randW();
    const { ret, sigma } = portStats(w, mu, S);
    if (sigma > 1e-9 && (ret - rf) / sigma > bestSh) { bestSh = (ret - rf) / sigma; bestTan = w; }
    if (sigma * sigma < bestV) { bestV = sigma * sigma; bestMin = w; }
  }
  const refine = (start, score) => {
    let w = [...start], step = 0.08;
    for (let it = 0; it < 400; it++) {
      const i = Math.floor(Math.random() * n), j = Math.floor(Math.random() * n);
      if (i === j) continue;
      const d = (Math.random() - 0.5) * step;
      const w2 = [...w];
      w2[i] = Math.min(1, Math.max(0, w2[i] + d));
      w2[j] = Math.min(1, Math.max(0, w2[j] - d));
      const s = w2.reduce((a, b) => a + b, 0);
      const w3 = w2.map((x) => x / s);
      if (score(w3) > score(w)) w = w3;
      if (it % 100 === 99) step *= 0.6;
    }
    return w;
  };
  const sh = (w) => { const p = portStats(w, mu, S); return p.sigma > 1e-9 ? (p.ret - rf) / p.sigma : -Infinity; };
  const nv = (w) => -portStats(w, mu, S).sigma;
  return { wTan: refine(bestTan, sh), wMin: refine(bestMin, nv) };
}
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function monteCarloContrib(ret, sigma, years, paths, start, monthly) {
  const steps = years * 12;
  const mMu = Math.log(1 + Math.max(-0.95, ret)) / 12 - (sigma * sigma) / 24;
  const mSig = sigma / Math.sqrt(12);
  const all = Array.from({ length: paths }, () => start);
  const yearly = [];
  for (let t = 1; t <= steps; t++) {
    for (let p = 0; p < paths; p++) all[p] = all[p] * Math.exp(mMu + mSig * gauss()) + monthly;
    if (t % 12 === 0) yearly.push([...all].sort((a, b) => a - b));
  }
  const pick = (arr, q) => arr[Math.min(arr.length - 1, Math.floor(q * arr.length))];
  const series = yearly.map((sorted, yi) => ({
    year: yi + 1,
    p5: pick(sorted, 0.05), p50: pick(sorted, 0.5), p95: pick(sorted, 0.95),
  }));
  const final = yearly[yearly.length - 1];
  const contributed = start + monthly * steps;
  return {
    series, median: pick(final, 0.5), p5: pick(final, 0.05), p95: pick(final, 0.95),
    probLoss: final.filter((x) => x < contributed).length / final.length,
    contributed,
  };
}
function monteCarlo(ret, sigma, years, paths, start) {
  const steps = years * 12;
  const mMu = Math.log(1 + Math.max(-0.95, ret)) / 12 - (sigma * sigma) / 24;
  const mSig = sigma / Math.sqrt(12);
  const all = Array.from({ length: paths }, () => start);
  const yearly = [];
  for (let t = 1; t <= steps; t++) {
    for (let p = 0; p < paths; p++) all[p] *= Math.exp(mMu + mSig * gauss());
    if (t % 12 === 0) yearly.push([...all].sort((a, b) => a - b));
  }
  const pick = (arr, q) => arr[Math.min(arr.length - 1, Math.floor(q * arr.length))];
  const series = yearly.map((sorted, yi) => ({
    year: yi + 1,
    p5: pick(sorted, 0.05), p25: pick(sorted, 0.25), p50: pick(sorted, 0.5),
    p75: pick(sorted, 0.75), p95: pick(sorted, 0.95),
  }));
  const final = yearly[yearly.length - 1];
  return {
    series, median: pick(final, 0.5), p5: pick(final, 0.05), p95: pick(final, 0.95),
    probLoss: final.filter((x) => x < start).length / final.length,
  };
}
function quantInsights(assets, corr, model, rf, A) {
  const out = [];
  const w = model.tan.w, n = w.length;
  const hhi = w.reduce((s, x) => s + x * x, 0);
  const effN = 1 / hhi;
  out.push({ tag: "Concentration", text: `Effective positions: ${effN.toFixed(1)} of ${n} (HHI ${hhi.toFixed(2)}). ${effN < n * 0.5 ? "The solution is loading into the highest-Sharpe inputs; small E[r] changes will materially move the weights." : "Weight is well distributed across the book."}` });
  const shorts = assets.filter((_, i) => w[i] < -0.001);
  if (shorts.length) out.push({ tag: "Shorts", text: `The unconstrained solution shorts ${shorts.map((a) => a.name).join(", ")}. Registered accounts are long-only; the long-only constraint removes these positions.` });
  const wAbs = w.map(Math.abs);
  const sAbs = wAbs.reduce((a, b) => a + b, 0);
  const wavgVol = wAbs.map((x) => x / sAbs).reduce((s, wi, i) => s + wi * (assets[i].sigma / 100), 0);
  const dr = wavgVol / model.tan.sigma;
  out.push({ tag: "Diversification", text: `Diversification ratio ${dr.toFixed(2)}. ${dr > 1.3 ? "Sub-unit correlations are producing meaningful volatility reduction." : "Limited diversification benefit is present at these correlation inputs."}` });
  let sum = 0, cnt = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { sum += corr[i][j]; cnt++; }
  out.push({ tag: "Correlation", text: `Average pairwise ρ = ${(cnt ? sum / cnt : 0).toFixed(2)}. Historically, equity correlations have risen toward 0.7–0.9 in drawdowns, which compresses modeled diversification benefits.` });
  const var95 = model.tan.ret - 1.645 * model.tan.sigma;
  out.push({ tag: "Tail risk", text: `Sharpe ${model.tan.sharpe.toFixed(2)}. Parametric 1-in-20 year outcome: ${(var95 * 100).toFixed(1)}%. Empirical return distributions have fatter tails than the normal assumption.` });
  const yStar = (model.tan.ret - rf) / (A * model.tan.sigma * model.tan.sigma);
  out.push({ tag: "Sizing", text: `At A=${A}, the model's risky allocation y* = ${(Math.min(yStar, 2) * 100).toFixed(0)}%${yStar > 1 ? "; values above 100% imply leverage" : ", with the remainder at the risk-free rate"}.` });
  return out;
}

/* ═══════════════ AI SAFEGUARD LAYER ═══════════════
   Three independent layers:
   1. Prompt contract — observation-only rules, banned imperatives, no invented figures
   2. Output filter  — regex screen rejects any item containing advice language
   3. UI framing     — every item badged Strength/Consideration/Flag + persistent disclaimer
*/

const ADVICE_PATTERNS = [
  /\byou (should|ought to|need to|must|could consider)\b/i,
  /\b(should|ought to) (buy|sell|add|trim|hold|reduce|increase|exit|rebalance)\b/i,
  /\b(buy|sell|purchase|accumulate|liquidate|divest|offload)\b/i,
  /\bwe (recommend|suggest|advise)\b/i,
  /\bi (recommend|suggest|advise)\b/i,
  /\brecommend(ed|ation)?\b/i,
  /\bconsider (buying|selling|adding|trimming|reducing|increasing|exiting|switching)\b/i,
  /\b(add|trim|reduce|increase|cut|raise) (the |your )?(position|exposure|allocation|weight)\b/i,
  /\btake profits?\b/i,
  /\brebalance (into|out of|toward)\b/i,
  /\b(good|bad|great|poor) (buy|investment|time to)\b/i,
  /\bworth (buying|adding|holding|selling)\b/i,
];
function violatesAdviceRules(text) {
  return ADVICE_PATTERNS.some((rx) => rx.test(text));
}
function filterAiItems(items) {
  const passed = [], withheld = [];
  for (const it of items || []) {
    const full = `${it.title || ""} ${it.body || ""}`;
    const validType = ["strength", "consideration", "flag"].includes(it.type);
    if (validType && !violatesAdviceRules(full)) passed.push(it);
    else withheld.push(it);
  }
  return { passed, withheldCount: withheld.length };
}

const AI_PROMPT_RULES = `You are an analytical observation engine reviewing a mean-variance model output. You are NOT an advisor. Hard rules:
1. OBSERVATIONS ONLY. Describe what the data shows. Never tell the user to do anything. No imperatives, no recommendations, no "should", no buy/sell/add/trim/reduce/hold language, no "consider doing X".
2. Every observation is one of three types: "strength" (a structural positive visible in the data), "consideration" (a limitation or sensitivity of the model), "flag" (a risk pattern visible in the inputs, e.g. shared factor exposure two holdings likely have in common).
3. NO INVENTED FIGURES. Only cite numbers present in the supplied data. For company characteristics, state only broad, widely-known qualitative attributes (sector, general business model) and hedge with "is generally associated with" if not certain. If you do not recognize a ticker, say the model treats it only through its supplied statistics — do not guess what it is.
4. Neutral, descriptive register. "The two largest weights likely share interest-rate sensitivity" is acceptable. "Diversify away from rate-sensitive names" is forbidden.
5. Respond ONLY with valid JSON, no markdown fences, no preamble. Schema: {"items":[{"type":"strength|consideration|flag","title":"...","body":"..."}]} with exactly 4-5 items, body max 3 sentences.`;

/* ═══════════════ DEFAULTS ═══════════════ */

const DEFAULT_ASSETS = [
  { name: "VST", er: 14, sigma: 38, amount: 5000 },
  { name: "NVDA", er: 16, sigma: 42, amount: 8000 },
  { name: "BN.TO", er: 12, sigma: 28, amount: 6000 },
  { name: "MEQ.TO", er: 10, sigma: 24, amount: 3000 },
  { name: "ATD.TO", er: 9, sigma: 20, amount: 3000 },
];
const defaultCorr = (n) => {
  const c = [];
  for (let i = 0; i < n; i++) { c.push([]); for (let j = 0; j < n; j++) c[i].push(i === j ? 1 : 0.35); }
  return c;
};
/* Always returns a well-formed n×n matrix, preserving whatever valid values
   `raw` had. Restored state can disagree with the asset count (e.g. a book
   saved with 8 holdings against a 5×5 matrix), and an undersized matrix makes
   buildCov read past the end and throw during render — which unmounts the app
   and shows a blank page. Normalizing on load makes that unrepresentable. */
const normalizeCorr = (raw, n) => {
  const c = [];
  for (let i = 0; i < n; i++) {
    c.push([]);
    for (let j = 0; j < n; j++) {
      if (i === j) { c[i].push(1); continue; }
      const v = raw && raw[i] != null ? Number(raw[i][j]) : NaN;
      c[i].push(isFinite(v) ? Math.max(-0.99, Math.min(0.99, v)) : 0.35);
    }
  }
  return c;
};
const sanitizeAssets = (raw) => {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const out = raw.slice(0, 30).map((a, i) => {
    const src = a && typeof a === "object" ? a : {};
    const sigma = Number(src.sigma), er = Number(src.er), amount = Number(src.amount);
    return {
      name: typeof src.name === "string" && src.name ? src.name : "ASSET" + (i + 1),
      er: isFinite(er) ? er : 8,
      sigma: isFinite(sigma) ? Math.max(1, Math.abs(sigma)) : 20,
      amount: isFinite(amount) ? Math.max(0, amount) : 0,
    };
  });
  return out.length >= 2 ? out : null;
};
const sanitizeHoldings = (raw) => {
  if (!Array.isArray(raw) || !raw.length) return null;
  return raw.slice(0, 10).map((h, i) => {
    const src = h && typeof h === "object" ? h : {};
    const amount = Number(src.amount);
    return {
      name: typeof src.name === "string" ? src.name : "Company " + String.fromCharCode(65 + i),
      amount: isFinite(amount) ? Math.max(0, amount) : 0,
      risk: ["low", "med", "high"].indexOf(src.risk) >= 0 ? src.risk : "med",
    };
  });
};
// Single source of truth for the Pro price — keep in sync with the Stripe Price object.
const PRO_PRICE = "$7.99";
const PRO_PRICE_MO = PRO_PRICE + "/mo";

// Basic mode: plain-language risk presets instead of E[r]/σ inputs
const RISK_PRESETS = {
  low: { label: "Steady", desc: "Utilities, staples, big banks", er: 6, sigma: 15 },
  med: { label: "Balanced", desc: "Large established companies", er: 9, sigma: 24 },
  high: { label: "Aggressive", desc: "Tech, growth, small caps", er: 13, sigma: 40 },
};
const DEFAULT_BASIC = [
  { name: "Company A", amount: 5000, risk: "med" },
  { name: "Company B", amount: 3000, risk: "high" },
  { name: "Company C", amount: 2000, risk: "low" },
];

/* ═══════════════ STOCK LIBRARY ═══════════════
   Reference set: full S&P 500 (constituent snapshot, early 2026) + TSX Composite
   majors + FTSE 100 + DAX + CAC 40 + wider Europe + Nikkei majors + Asia-Pacific
   + global ETFs (~800 securities). Vol = annualized volatility CLASS estimate
   assigned by sector/profile — an editable starting point, not live data.
   Index membership drifts and stats move: AT DEPLOY, swap searchLibrary() for a
   market-data API (FMP, Polygon, Twelve Data) for live coverage of everything else.
*/
const GROUPS = [
// ————— S&P 500 · Information Technology —————
["US · Mega Tech",27,"AAPL~Apple;MSFT~Microsoft;ORCL~Oracle;IBM~IBM;CSCO~Cisco;ACN~Accenture;ADBE~Adobe;CRM~Salesforce;INTU~Intuit;NOW~ServiceNow"],
["US · Semis",42,"NVDA~NVIDIA;AMD~Advanced Micro Devices;AVGO~Broadcom;MU~Micron;AMAT~Applied Materials;LRCX~Lam Research;KLAC~KLA;ADI~Analog Devices;TXN~Texas Instruments;QCOM~Qualcomm;NXPI~NXP Semiconductors;MCHP~Microchip;ON~ON Semiconductor;MPWR~Monolithic Power;TER~Teradyne;SWKS~Skyworks;INTC~Intel;FSLR~First Solar;ENPH~Enphase;SMCI~Super Micro"],
["US · Software",34,"SNPS~Synopsys;CDNS~Cadence;PANW~Palo Alto Networks;CRWD~CrowdStrike;FTNT~Fortinet;ADSK~Autodesk;WDAY~Workday;PTC~PTC;TYL~Tyler Technologies;GEN~Gen Digital;VRSN~VeriSign;GDDY~GoDaddy;AKAM~Akamai;EPAM~EPAM Systems;JKHY~Jack Henry"],
["US · High-Beta Tech",52,"PLTR~Palantir;TSLA~Tesla;COIN~Coinbase;DASH~DoorDash;ABNB~Airbnb;UBER~Uber"],
["US · Hardware & IT",26,"ANET~Arista Networks;MSI~Motorola Solutions;ROP~Roper;TEL~TE Connectivity;APH~Amphenol;GLW~Corning;HPQ~HP;HPE~HP Enterprise;DELL~Dell;CDW~CDW;IT~Gartner;CTSH~Cognizant;KEYS~Keysight;ZBRA~Zebra;FFIV~F5;NTAP~NetApp;STX~Seagate;WDC~Western Digital;TDY~Teledyne;TRMB~Trimble;JBL~Jabil"],
// ————— S&P 500 · Communication Services —————
["US · Comm & Media",29,"GOOGL~Alphabet A;GOOG~Alphabet C;META~Meta Platforms;NFLX~Netflix;DIS~Disney;CMCSA~Comcast;CHTR~Charter;WBD~Warner Bros Discovery;EA~Electronic Arts;TTWO~Take-Two;OMC~Omnicom;IPG~Interpublic;FOXA~Fox A;FOX~Fox B;NWSA~News Corp A;NWS~News Corp B;LYV~Live Nation;MTCH~Match Group;PARA~Paramount Skydance"],
["US · Telecom",19,"T~AT&T;VZ~Verizon;TMUS~T-Mobile"],
// ————— S&P 500 · Health Care —————
["US · Pharma",20,"LLY~Eli Lilly;JNJ~Johnson & Johnson;ABBV~AbbVie;MRK~Merck;PFE~Pfizer;BMY~Bristol Myers;AMGN~Amgen;GILD~Gilead;ZTS~Zoetis;VTRS~Viatris;OGN~Organon"],
["US · Biotech",40,"VRTX~Vertex;REGN~Regeneron;MRNA~Moderna;BIIB~Biogen;INCY~Incyte;EXAS~Exact Sciences"],
["US · MedTech & Life Sci",22,"TMO~Thermo Fisher;ABT~Abbott;DHR~Danaher;ISRG~Intuitive Surgical;SYK~Stryker;BSX~Boston Scientific;MDT~Medtronic;BDX~Becton Dickinson;EW~Edwards Lifesciences;IDXX~IDEXX;A~Agilent;IQV~IQVIA;RMD~ResMed;GEHC~GE HealthCare;MTD~Mettler-Toledo;WST~West Pharma;STE~Steris;WAT~Waters;BAX~Baxter;HOLX~Hologic;PODD~Insulet;DXCM~Dexcom;ALGN~Align;CRL~Charles River;TECH~Bio-Techne;RVTY~Revvity;ZBH~Zimmer Biomet;COO~Cooper Companies;SOLV~Solventum;LH~Labcorp;DGX~Quest Diagnostics"],
["US · Health Services",24,"UNH~UnitedHealth;ELV~Elevance;CI~Cigna;CVS~CVS Health;MCK~McKesson;COR~Cencora;CAH~Cardinal Health;HCA~HCA Healthcare;CNC~Centene;HUM~Humana;MOH~Molina;UHS~Universal Health;THC~Tenet;DVA~DaVita"],
// ————— S&P 500 · Financials —————
["US · Banks",26,"JPM~JPMorgan Chase;BAC~Bank of America;WFC~Wells Fargo;C~Citigroup;USB~US Bancorp;PNC~PNC;TFC~Truist;COF~Capital One;KEY~KeyCorp;RF~Regions;CFG~Citizens;HBAN~Huntington;FITB~Fifth Third;MTB~M&T Bank;STT~State Street;BK~BNY;NTRS~Northern Trust"],
["US · Capital Markets",28,"GS~Goldman Sachs;MS~Morgan Stanley;SCHW~Charles Schwab;BLK~BlackRock;KKR~KKR;BX~Blackstone;APO~Apollo;TROW~T Rowe Price;BEN~Franklin;IVZ~Invesco;AMP~Ameriprise;RJF~Raymond James;MSCI~MSCI;NDAQ~Nasdaq;ICE~Intercontinental Exchange;CME~CME Group;CBOE~Cboe;MKTX~MarketAxess;FDS~FactSet;MCO~Moody's;SPGI~S&P Global;HOOD~Robinhood"],
["US · Payments & Fintech",23,"V~Visa;MA~Mastercard;AXP~American Express;PYPL~PayPal;FI~Fiserv;FIS~FIS;GPN~Global Payments;SYF~Synchrony"],
["US · Insurance",19,"BRK-B~Berkshire Hathaway;PGR~Progressive;CB~Chubb;MMC~Marsh McLennan;AON~Aon;AJG~Gallagher;MET~MetLife;AIG~AIG;PRU~Prudential;AFL~Aflac;ALL~Allstate;TRV~Travelers;HIG~Hartford;WTW~WTW;BRO~Brown & Brown;EG~Everest;CINF~Cincinnati Financial;L~Loews;GL~Globe Life;AIZ~Assurant;WRB~WR Berkley;ACGL~Arch Capital;PFG~Principal;ERIE~Erie Indemnity"],
// ————— S&P 500 · Consumer Discretionary —————
["US · Consumer Discretionary",28,"AMZN~Amazon;HD~Home Depot;MCD~McDonald's;BKNG~Booking;LOW~Lowe's;TJX~TJX;SBUX~Starbucks;NKE~Nike;CMG~Chipotle;ORLY~O'Reilly;AZO~AutoZone;MAR~Marriott;HLT~Hilton;GM~General Motors;F~Ford;YUM~Yum Brands;DRI~Darden;ROST~Ross;DG~Dollar General;DLTR~Dollar Tree;BBY~Best Buy;EBAY~eBay;DECK~Deckers;LULU~Lululemon;RL~Ralph Lauren;TPR~Tapestry;GRMN~Garmin;EXPE~Expedia;POOL~Pool Corp;KMX~CarMax;APTV~Aptiv;GPC~Genuine Parts;ULTA~Ulta;WSM~Williams-Sonoma;TSCO~Tractor Supply;HAS~Hasbro;MHK~Mohawk;DHI~DR Horton;LEN~Lennar;PHM~PulteGroup;NVR~NVR"],
["US · Travel & Casinos",36,"RCL~Royal Caribbean;CCL~Carnival;NCLH~Norwegian;LVS~Las Vegas Sands;WYNN~Wynn;MGM~MGM;CZR~Caesars;DAL~Delta;UAL~United Airlines;LUV~Southwest;AAL~American Airlines"],
// ————— S&P 500 · Consumer Staples —————
["US · Staples",15,"WMT~Walmart;PG~Procter & Gamble;COST~Costco;KO~Coca-Cola;PEP~PepsiCo;PM~Philip Morris;MO~Altria;MDLZ~Mondelez;CL~Colgate;TGT~Target;KMB~Kimberly-Clark;GIS~General Mills;KDP~Keurig Dr Pepper;MNST~Monster;STZ~Constellation Brands;HSY~Hershey;KR~Kroger;SYY~Sysco;ADM~ADM;KHC~Kraft Heinz;CHD~Church & Dwight;MKC~McCormick;CLX~Clorox;CAG~Conagra;CPB~Campbell's;HRL~Hormel;SJM~JM Smucker;TSN~Tyson;TAP~Molson Coors;BG~Bunge;LW~Lamb Weston;EL~Estée Lauder;BF-B~Brown-Forman;CASY~Casey's"],
// ————— S&P 500 · Energy —————
["US · Energy",30,"XOM~Exxon Mobil;CVX~Chevron;COP~ConocoPhillips;EOG~EOG Resources;SLB~Schlumberger;MPC~Marathon Petroleum;PSX~Phillips 66;VLO~Valero;WMB~Williams;OKE~ONEOK;KMI~Kinder Morgan;OXY~Occidental;FANG~Diamondback;DVN~Devon;HAL~Halliburton;BKR~Baker Hughes;CTRA~Coterra;EQT~EQT;APA~APA;TRGP~Targa;EXE~Expand Energy"],
// ————— S&P 500 · Industrials —————
["US · Industrials",24,"GE~GE Aerospace;CAT~Caterpillar;RTX~RTX;UNP~Union Pacific;HON~Honeywell;ETN~Eaton;BA~Boeing;DE~Deere;LMT~Lockheed Martin;UPS~UPS;ADP~ADP;PH~Parker Hannifin;TT~Trane;GD~General Dynamics;NOC~Northrop Grumman;ITW~Illinois Tool Works;EMR~Emerson;CSX~CSX;NSC~Norfolk Southern;FDX~FedEx;WM~Waste Management;RSG~Republic Services;PCAR~PACCAR;CMI~Cummins;JCI~Johnson Controls;GWW~Grainger;FAST~Fastenal;URI~United Rentals;PWR~Quanta;AME~AMETEK;ROK~Rockwell;OTIS~Otis;CARR~Carrier;DOV~Dover;XYL~Xylem;HWM~Howmet;TDG~TransDigm;AXON~Axon;VRSK~Verisk;CTAS~Cintas;PAYX~Paychex;LDOS~Leidos;LHX~L3Harris;HUBB~Hubbell;IR~Ingersoll Rand;WAB~Wabtec;EFX~Equifax;BR~Broadridge;ODFL~Old Dominion;JBHT~JB Hunt;CHRW~CH Robinson;EXPD~Expeditors;GEV~GE Vernova;DAY~Dayforce;SNA~Snap-on;SWK~Stanley Black & Decker;PNR~Pentair;ALLE~Allegion;MAS~Masco;AOS~A O Smith;IEX~IDEX;NDSN~Nordson;ROL~Rollins;HII~Huntington Ingalls;TXT~Textron;GNRC~Generac;MMM~3M;VLTO~Veralto"],
// ————— S&P 500 · Materials —————
["US · Materials",27,"LIN~Linde;SHW~Sherwin-Williams;APD~Air Products;ECL~Ecolab;FCX~Freeport-McMoRan;NEM~Newmont;CTVA~Corteva;DOW~Dow;DD~DuPont;PPG~PPG;NUE~Nucor;VMC~Vulcan;MLM~Martin Marietta;IP~International Paper;PKG~Packaging Corp;AVY~Avery Dennison;BALL~Ball;AMCR~Amcor;CF~CF Industries;MOS~Mosaic;ALB~Albemarle;FMC~FMC;IFF~IFF;LYB~LyondellBasell;STLD~Steel Dynamics;SW~Smurfit Westrock;EMN~Eastman"],
// ————— S&P 500 · Real Estate —————
["US · REITs",20,"PLD~Prologis;AMT~American Tower;EQIX~Equinix;WELL~Welltower;SPG~Simon Property;PSA~Public Storage;O~Realty Income;DLR~Digital Realty;CCI~Crown Castle;CBRE~CBRE;VICI~VICI;EXR~Extra Space;AVB~AvalonBay;EQR~Equity Residential;VTR~Ventas;IRM~Iron Mountain;SBAC~SBA Comm;WY~Weyerhaeuser;INVH~Invitation Homes;MAA~Mid-America;ESS~Essex;KIM~Kimco;REG~Regency;DOC~Healthpeak;UDR~UDR;CPT~Camden;HST~Host Hotels;BXP~BXP;FRT~Federal Realty;ARE~Alexandria"],
// ————— S&P 500 · Utilities —————
["US · Utilities",16,"NEE~NextEra;SO~Southern;DUK~Duke;SRE~Sempra;AEP~AEP;D~Dominion;EXC~Exelon;XEL~Xcel;PEG~PSEG;ED~Con Edison;PCG~PG&E;WEC~WEC;AWK~American Water;DTE~DTE;ES~Eversource;AEE~Ameren;PPL~PPL;ATO~Atmos;CNP~CenterPoint;CMS~CMS;FE~FirstEnergy;LNT~Alliant;EVRG~Evergy;NI~NiSource;AES~AES;PNW~Pinnacle West"],
["US · Power (High Vol)",38,"CEG~Constellation Energy;VST~Vistra;NRG~NRG;TLN~Talen"],
// ————— Canada · TSX —————
["CA · Banks",17,"RY.TO~Royal Bank of Canada;TD.TO~TD Bank;BNS.TO~Scotiabank;BMO.TO~Bank of Montreal;CM.TO~CIBC;NA.TO~National Bank;EQB.TO~EQB"],
["CA · Financials & Insurance",20,"MFC.TO~Manulife;SLF.TO~Sun Life;GWO.TO~Great-West Life;IFC.TO~Intact;POW.TO~Power Corp;FFH.TO~Fairfax;X.TO~TMX Group;IGM.TO~IGM Financial;ONEX.TO~Onex"],
["CA · Energy",30,"SU.TO~Suncor;CNQ.TO~Canadian Natural;CVE.TO~Cenovus;IMO.TO~Imperial Oil;TOU.TO~Tourmaline;ARX.TO~ARC Resources;WCP.TO~Whitecap;MEG.TO~MEG Energy;BTE.TO~Baytex;PPL.TO~Pembina"],
["CA · Pipelines & Utilities",16,"ENB.TO~Enbridge;TRP.TO~TC Energy;FTS.TO~Fortis;EMA.TO~Emera;H.TO~Hydro One;CU.TO~Canadian Utilities;AQN.TO~Algonquin;CPX.TO~Capital Power;BLX.TO~Boralex;NPI.TO~Northland Power"],
["CA · Materials & Gold",32,"AEM.TO~Agnico Eagle;ABX.TO~Barrick;WPM.TO~Wheaton PM;FNV.TO~Franco-Nevada;K.TO~Kinross;LUN.TO~Lundin Mining;FM.TO~First Quantum;TECK-B.TO~Teck;NTR.TO~Nutrien;CCO.TO~Cameco;IVN.TO~Ivanhoe;ELD.TO~Eldorado;BTO.TO~B2Gold"],
["CA · Industrials & Rails",20,"CNR.TO~CN Railway;CP.TO~CPKC;WCN.TO~Waste Connections;TFII.TO~TFI International;WSP.TO~WSP Global;STN.TO~Stantec;CAE.TO~CAE;GFL.TO~GFL Environmental;TIH.TO~Toromont;FTT.TO~Finning;BBD-B.TO~Bombardier;AC.TO~Air Canada"],
["CA · Tech",34,"SHOP.TO~Shopify;CSU.TO~Constellation Software;OTEX.TO~OpenText;KXS.TO~Kinaxis;DSG.TO~Descartes;GIB-A.TO~CGI;LSPD.TO~Lightspeed;BB.TO~BlackBerry"],
["CA · Consumer & Telecom",18,"ATD.TO~Couche-Tard;L.TO~Loblaw;MRU.TO~Metro;DOL.TO~Dollarama;QSR.TO~Restaurant Brands;SAP.TO~Saputo;EMP-A.TO~Empire;ATZ.TO~Aritzia;GIL.TO~Gildan;T.TO~Telus;BCE.TO~BCE;RCI-B.TO~Rogers;CCA.TO~Cogeco;TRI.TO~Thomson Reuters"],
["CA · Real Estate & Alt Assets",25,"BN.TO~Brookfield Corp;BAM.TO~Brookfield Asset Mgmt;BIP-UN.TO~Brookfield Infra;BEP-UN.TO~Brookfield Renewable;MEQ.TO~Mainstreet Equity;CAR-UN.TO~CAPREIT;REI-UN.TO~RioCan;GRT-UN.TO~Granite REIT;CIGI.TO~Colliers;FSV.TO~FirstService"],
["CA · High Growth",45,"PRL.TO~Propel Holdings;GSY.TO~goeasy;CLS.TO~Celestica;WELL.TO~WELL Health;HUT.TO~Hut 8"],
// ————— UK · FTSE 100 —————
["UK · Large Cap",22,"SHEL.L~Shell;AZN.L~AstraZeneca;HSBA.L~HSBC;ULVR.L~Unilever;BP.L~BP;GSK.L~GSK;RIO.L~Rio Tinto;REL.L~RELX;DGE.L~Diageo;BATS.L~BAT;LSEG.L~London Stock Exchange;NG.L~National Grid;BARC.L~Barclays;LLOY.L~Lloyds;VOD.L~Vodafone;PRU.L~Prudential plc;RR.L~Rolls-Royce;BA.L~BAE Systems;TSCO.L~Tesco;CPG.L~Compass;EXPN.L~Experian;III.L~3i Group;AHT.L~Ashtead;ANTO.L~Antofagasta;GLEN.L~Glencore;STAN.L~Standard Chartered;IMB.L~Imperial Brands;SGE.L~Sage;SSE.L~SSE;CNA.L~Centrica;AAL.L~Anglo American;WTB.L~Whitbread;NXT.L~Next;SGRO.L~Segro;HLN.L~Haleon;SN.L~Smith & Nephew;IAG.L~IAG;RKT.L~Reckitt;ABF.L~AB Foods;SMIN.L~Smiths Group"],
// ————— Germany · DAX —————
["DE · DAX",24,"SAP.DE~SAP;SIE.DE~Siemens;ALV.DE~Allianz;DTE.DE~Deutsche Telekom;AIR.DE~Airbus;MUV2.DE~Munich Re;BMW.DE~BMW;MBG.DE~Mercedes-Benz;VOW3.DE~Volkswagen;BAS.DE~BASF;BAYN.DE~Bayer;ADS.DE~Adidas;DBK.DE~Deutsche Bank;DB1.DE~Deutsche Börse;IFX.DE~Infineon;RWE.DE~RWE;EOAN.DE~E.ON;DHL.DE~DHL Group;HEN3.DE~Henkel;MRK.DE~Merck KGaA;FRE.DE~Fresenius;HEI.DE~Heidelberg Materials;RHM.DE~Rheinmetall;CON.DE~Continental;ZAL.DE~Zalando;SHL.DE~Siemens Healthineers;ENR.DE~Siemens Energy;HNR1.DE~Hannover Re;VNA.DE~Vonovia;BEI.DE~Beiersdorf"],
// ————— France · CAC 40 —————
["FR · CAC 40",24,"MC.PA~LVMH;OR.PA~L'Oréal;TTE.PA~TotalEnergies;SAN.PA~Sanofi;AIR.PA~Airbus (Paris);SU.PA~Schneider Electric;BNP.PA~BNP Paribas;AI.PA~Air Liquide;CS.PA~AXA;DG.PA~Vinci;SAF.PA~Safran;EL.PA~EssilorLuxottica;RI.PA~Pernod Ricard;KER.PA~Kering;CAP.PA~Capgemini;ENGI.PA~Engie;ORA.PA~Orange;GLE.PA~Société Générale;ACA.PA~Crédit Agricole;HO.PA~Thales;DSY.PA~Dassault Systèmes;RMS.PA~Hermès;STLA~Stellantis;BN.PA~Danone;VIE.PA~Veolia;SGO.PA~Saint-Gobain;LR.PA~Legrand;PUB.PA~Publicis;ML.PA~Michelin"],
// ————— Europe · Other —————
["EU · Switzerland & Nordics",20,"NESN.SW~Nestlé;ROG.SW~Roche;NOVN.SW~Novartis;UBSG.SW~UBS;ZURN.SW~Zurich Insurance;ABBN.SW~ABB;CFR.SW~Richemont;LONN.SW~Lonza;SIKA.SW~Sika;GIVN.SW~Givaudan;NOVO-B.CO~Novo Nordisk;DSV.CO~DSV;MAERSK-B.CO~Maersk;EQNR.OL~Equinor;ATCO-A.ST~Atlas Copco;VOLV-B.ST~Volvo;INVE-B.ST~Investor AB;ERIC-B.ST~Ericsson;NDA-SE.ST~Nordea"],
["EU · Netherlands Italy Spain",24,"ASML.AS~ASML;INGA.AS~ING;PHIA.AS~Philips;ADYEN.AS~Adyen;HEIA.AS~Heineken;WKL.AS~Wolters Kluwer;PRX.AS~Prosus;ENEL.MI~Enel;ISP.MI~Intesa Sanpaolo;UCG.MI~UniCredit;ENI.MI~Eni;RACE.MI~Ferrari;STM.MI~STMicroelectronics;G.MI~Generali;SAN.MC~Santander;BBVA.MC~BBVA;IBE.MC~Iberdrola;ITX.MC~Inditex;TEF.MC~Telefónica;REP.MC~Repsol"],
// ————— Japan · Nikkei majors —————
["JP · Large Cap",22,"7203.T~Toyota;6758.T~Sony;8306.T~MUFG;9984.T~SoftBank Group;6861.T~Keyence;8035.T~Tokyo Electron;9983.T~Fast Retailing;6501.T~Hitachi;7974.T~Nintendo;4063.T~Shin-Etsu Chemical;6098.T~Recruit;8058.T~Mitsubishi Corp;8001.T~Itochu;8031.T~Mitsui & Co;9432.T~NTT;9433.T~KDDI;4519.T~Chugai Pharma;4568.T~Daiichi Sankyo;6902.T~Denso;7267.T~Honda;7011.T~Mitsubishi Heavy;6367.T~Daikin;8766.T~Tokio Marine;8316.T~SMFG;8411.T~Mizuho;6954.T~Fanuc;6981.T~Murata;7741.T~Hoya;4661.T~Oriental Land;2914.T~Japan Tobacco"],
// ————— Asia-Pacific & Emerging —————
["Asia · China ADRs",40,"BABA~Alibaba;PDD~PDD Holdings;JD~JD.com;BIDU~Baidu;NTES~NetEase;TCEHY~Tencent ADR;NIO~NIO;LI~Li Auto;XPEV~XPeng;TME~Tencent Music;BEKE~KE Holdings"],
["Asia · Taiwan Korea India",28,"TSM~Taiwan Semiconductor;UMC~United Micro;005930.KS~Samsung Electronics;000660.KS~SK Hynix;INFY~Infosys ADR;WIT~Wipro ADR;HDB~HDFC Bank ADR;IBN~ICICI Bank ADR;RELIANCE.NS~Reliance Industries;TCS.NS~Tata Consultancy"],
["AU · ASX Majors",22,"BHP.AX~BHP;CBA.AX~Commonwealth Bank;CSL.AX~CSL;NAB.AX~NAB;WBC.AX~Westpac;ANZ.AX~ANZ;WES.AX~Wesfarmers;MQG.AX~Macquarie;WDS.AX~Woodside;FMG.AX~Fortescue;TLS.AX~Telstra;RIO.AX~Rio Tinto (ASX);WOW.AX~Woolworths;GMG.AX~Goodman Group"],
// ————— ETFs —————
["ETF · US Broad",15,"SPY~SPDR S&P 500;VOO~Vanguard S&P 500;IVV~iShares S&P 500;VTI~Vanguard Total Market;DIA~SPDR Dow;RSP~Equal-Weight S&P;SCHD~Schwab Dividend;VIG~Vanguard Div Growth;VYM~Vanguard High Div"],
["ETF · Growth & Sector",21,"QQQ~Invesco Nasdaq-100;IWM~iShares Russell 2000;VGT~Vanguard Tech;XLK~Tech Select;XLF~Financials Select;XLE~Energy Select;XLV~Health Care Select;XLI~Industrials Select;SMH~VanEck Semis;SOXX~iShares Semis;ARKK~ARK Innovation"],
["ETF · International",16,"VEA~Vanguard Dev Markets;VWO~Vanguard Emerging;IEFA~iShares Core EAFE;IEMG~iShares Core EM;EFA~iShares EAFE;VXUS~Vanguard Intl;EWJ~iShares Japan;EWU~iShares UK;EWG~iShares Germany;FXI~iShares China;INDA~iShares India"],
["ETF · Canada",13,"XIC.TO~iShares Core TSX;XIU.TO~iShares TSX 60;VFV.TO~Vanguard S&P 500 CAD;ZSP.TO~BMO S&P 500;XEQT.TO~iShares All-Equity;VEQT.TO~Vanguard All-Equity;VGRO.TO~Vanguard Growth;XGRO.TO~iShares Growth;VDY.TO~Vanguard CA Dividend;XEI.TO~iShares CA Dividend;XDIV.TO~iShares Quality Div"],
["ETF · Bonds & Gold",8,"AGG~iShares Core US Bond;BND~Vanguard Total Bond;TLT~iShares 20Y Treasury;ZAG.TO~BMO Aggregate Bond;XBB.TO~iShares CA Bond;XSB.TO~iShares Short Bond;GLD~SPDR Gold;IAU~iShares Gold"],
["ETF · Gold Miners & Crypto",38,"GDX~VanEck Gold Miners;XGD.TO~iShares Gold Miners;IBIT~iShares Bitcoin;FBTC~Fidelity Bitcoin;ETHA~iShares Ethereum"],
];
const LIB = GROUPS.flatMap(([sec, vol, s]) =>
  s.split(";").map((e) => {
    const [t2, n2] = e.split("~");
    return { t: t2, n: n2, sec, vol };
  })
);

// er estimate derived from vol class — editable placeholder, not a forecast
const erFromVol = (vol) => (vol < 8 ? 4 : vol < 18 ? 7 : vol < 28 ? 9 : vol < 40 ? 11 : 13);
const riskFromVol = (vol) => (vol < 20 ? "low" : vol < 30 ? "med" : "high");

// ADAPTER: swap this for an API call at deploy for full-market coverage
function searchLibrary(q) {
  const s = q.trim().toUpperCase();
  if (!s) return [];
  const starts = LIB.filter((x) => x.t.startsWith(s));
  const names = LIB.filter((x) => !x.t.startsWith(s) && x.n.toUpperCase().includes(s));
  return [...starts, ...names].slice(0, 8);
}

function TickerInput({ value, onChange, onSelect, width = 130, bold = true }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const [remote, setRemote] = useState([]);
  const [fetching, setFetching] = useState(false);
  const inputRef = React.useRef(null);
  const timerRef = React.useRef(null);
  const local = searchLibrary(value);
  const seen = new Set(local.map((x) => x.t));
  const results = [...local, ...remote.filter((x) => !seen.has(x.t))].slice(0, 8);
  const measure = () => {
    if (inputRef.current) setRect(inputRef.current.getBoundingClientRect());
  };
  const queueRemote = (q) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!q || q.trim().length < 2) { setRemote([]); return; }
    timerRef.current = setTimeout(async () => {
      try {
        const r = await fetch("/api/claude?search=" + encodeURIComponent(q.trim()));
        const data = await r.json();
        setRemote(data.results || []);
      } catch (e) { setRemote([]); }
    }, 350);
  };
  const pick = async (r) => {
    setOpen(false);
    setFetching(true);
    let vol = r.vol != null ? r.vol : 30;
    let beta = null;
    try {
      const resp = await fetch("/api/claude?capm=" + encodeURIComponent(r.t));
      const data = await resp.json();
      if (data.vol) vol = data.vol;
      if (typeof data.beta === "number") beta = data.beta;
    } catch (e) {}
    setFetching(false);
    onSelect({ ...r, vol, beta });
  };
  const DROP_H = 236;
  const flipUp = rect && window.innerHeight - rect.bottom < DROP_H && rect.top > DROP_H;
  const dropStyle = rect ? {
    position: "fixed",
    left: Math.min(rect.left, Math.max(8, window.innerWidth - 258)),
    ...(flipUp ? { bottom: window.innerHeight - rect.top + 2 } : { top: rect.bottom + 2 }),
    zIndex: 1000, width: 250, maxHeight: DROP_H, overflowY: "auto",
    background: T.band2, border: `1px solid ${T.ruleDark}`, borderRadius: T.radiusMd,
    boxShadow: T.shadow, overflow: "hidden",
  } : null;
  return (
    <div style={{ position: "relative", display: "inline-block", width }}>
      <input ref={inputRef} value={fetching ? value + " …" : value}
        onChange={(e) => { const v = e.target.value; onChange(v); queueRemote(v); measure(); setOpen(true); }}
        onFocus={() => { measure(); setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 160)}
        placeholder="Any ticker or name"
        style={{ width: "100%", padding: "8px 11px", border: `1px solid ${T.ruleDark}`, borderRadius: T.radiusMd, fontFamily: T.ui, fontSize: 13, fontWeight: bold ? 700 : 500, color: T.ink, background: T.surface, outline: "none", boxSizing: "border-box" }} />
      {open && results.length > 0 && dropStyle && (
        <div style={{ ...dropStyle, padding: 6 }}>
          {results.map((r) => (
            <div key={r.t}
              onMouseDown={(e) => { e.preventDefault(); pick(r); }}
              style={{ padding: "8px 10px", borderRadius: T.radiusSm, cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = T.surface)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
              <div style={{ minWidth: 0 }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: T.ink }}>{r.t}</span>
                <span style={{ fontSize: 11.5, color: T.sub, marginLeft: 7 }}>{r.n}</span>
              </div>
              <span style={{ fontSize: 10, color: T.faint, whiteSpace: "nowrap" }}>{r.vol != null ? r.sec + " · σ~" + r.vol + "%" : r.sec + " · live"}</span>
            </div>
          ))}
          <div style={{ padding: "6px 10px", fontSize: 10, color: T.faint }}>Live results pull a year of prices to estimate volatility · always editable.</div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════ DESIGN TOKENS — sharp editorial light ═══════════════ */

const T = {
  paper: "#030712",        // page base
  band: "#111827",         // elevated card
  band2: "#161F2E",        // slightly higher elevation (nested/highlighted cards)
  surface: "#1F2937",      // inputs / cells
  ink: "#F5F7FA",
  sub: "#9CA3AF",
  faint: "#6B7280",
  rule: "#1F2937",
  ruleDark: "#31404F",
  green: "#10B981",        // primary — emerald
  greenDeep: "#059669",
  greenLight: "#34D399",
  sage: "#7C9A8E",         // secondary accent
  steel: "#60A5FA",        // chart / info accent
  copper: "#FBBF24",       // amber highlight
  pink: "#F472B6",         // "you are here" — reserved for the user's own portfolio
  red: "#F87171",          // down / negative
  goldBg: "rgba(251,191,36,0.09)",
  goldBorder: "rgba(251,191,36,0.32)",
  ui: "'Open Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  disp: "'Open Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  mono: "'Open Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  radius: 20,     // modals, hero art
  radiusLg: 16,   // panels / pricing cards
  radiusMd: 10,   // buttons / inputs / stat cards
  radiusSm: 8,    // small chips / table cells
  pill: 999,      // pill buttons, badges, segmented controls
  shadow: "0 1px 2px rgba(0,0,0,.3), 0 20px 44px -16px rgba(0,0,0,.6)",
  shadowSm: "0 1px 2px rgba(0,0,0,.25), 0 8px 20px -8px rgba(0,0,0,.45)",
};
const PALETTE = [T.green, T.steel, T.copper, "#A78BFA", T.red, "#2DD4BF", "#FACC15", "#94A3B8", "#F472B6", T.greenLight];

/* isFinite() coerces before testing, so isFinite(null) and isFinite("5") are
   both true — which sends a null straight into .toFixed() and takes the whole
   app down. Every formatter below tests the type first. */
const isNum = (v) => typeof v === "number" && isFinite(v);
const pct = (v, d = 1) => (isNum(v) ? (v * 100).toFixed(d) + "%" : "—");
const num = (v, d = 2) => (isNum(v) ? v.toFixed(d) : "—");
const money = (v) => (isNum(v) ? "$" + Math.round(v).toLocaleString() : "—");
// Statement figures run to the hundreds of billions — scale them so a table stays readable.
const bigMoney = (v) => {
  if (!isNum(v)) return "—";
  const s = v < 0 ? "−" : "", a = Math.abs(v);
  if (a >= 1e12) return s + (a / 1e12).toFixed(2) + "T";
  if (a >= 1e9) return s + (a / 1e9).toFixed(1) + "B";
  if (a >= 1e6) return s + (a / 1e6).toFixed(0) + "M";
  if (a >= 1e3) return s + (a / 1e3).toFixed(0) + "K";
  return s + a.toFixed(0);
};
const label = { fontFamily: T.ui, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.11em", color: T.sub };

/* Numeric input.
   Held as raw text while focused so half-typed states ("", "-", "1.") survive
   instead of being round-tripped through parseFloat on every keystroke — that
   round-trip is what used to strand a leading zero ("05000"), since an
   unchanged parsed value means React never rewrites the DOM. Selecting on
   focus means typing replaces the existing figure rather than appending to it.
   type=text + inputMode=decimal drops the spinner arrows, which were eating
   ~17px of an already-tight box and clipping longer amounts. */
function Field({ value, onChange, w = 58 }) {
  const [draft, setDraft] = useState(null);
  const shown = draft !== null ? draft : String(value == null ? 0 : value);
  return (
    <input type="text" inputMode="decimal" value={shown}
      onFocus={(e) => { setDraft(String(value == null ? 0 : value)); e.target.select(); }}
      onChange={(e) => {
        const raw = e.target.value;
        if (!/^-?\d*\.?\d*$/.test(raw)) return; // ignore keystrokes that aren't part of a number
        setDraft(raw);
        const n = parseFloat(raw);
        if (isFinite(n)) onChange(n); // partial input ("", "-", ".") just waits for blur
      }}
      onBlur={() => {
        const n = parseFloat(draft === null ? "" : draft);
        onChange(isFinite(n) ? n : 0);
        setDraft(null);
      }}
      style={{ width: w, padding: "6px 9px", border: `1px solid ${T.ruleDark}`, borderRadius: T.radiusMd, fontFamily: T.ui, fontVariantNumeric: "tabular-nums", fontSize: 13, color: T.ink, background: T.surface, textAlign: "right", outline: "none", boxSizing: "border-box" }} />
  );
}
function Btn({ children, onClick, primary, small, wide, pill, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      fontFamily: T.ui, fontSize: small ? 12.5 : 14.5, fontWeight: 700,
      padding: small ? "8px 16px" : "13px 26px", borderRadius: pill ? T.pill : T.radiusMd,
      cursor: disabled ? "default" : "pointer",
      border: primary ? "none" : `1.5px solid ${T.ruleDark}`,
      background: primary ? `linear-gradient(180deg, ${T.greenLight}, ${T.green})` : "transparent",
      color: primary ? "#04140D" : T.ink,
      opacity: disabled ? 0.5 : 1,
      boxShadow: primary ? "0 6px 18px -6px rgba(16,185,129,0.55)" : "none",
      width: wide ? "100%" : "auto",
      transition: "transform .12s ease, box-shadow .12s ease",
    }}>{children}</button>
  );
}
function Hint({ children }) {
  return (
    <div style={{ fontSize: 12.5, color: T.sub, lineHeight: 1.6, marginBottom: 14, padding: "9px 14px", background: "rgba(255,255,255,0.03)", borderRadius: T.radiusSm }}>
      {children}
    </div>
  );
}
function Panel({ title, right, children, band }) {
  return (
    <div style={{
      background: band ? T.band2 : T.band,
      border: `1px solid ${band ? T.goldBorder : T.rule}`,
      borderRadius: T.radiusLg, boxShadow: T.shadowSm, marginBottom: 20, overflow: "hidden",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: `1px solid ${T.rule}`, flexWrap: "wrap", gap: 8 }}>
        <span style={{ ...label, color: T.ink, fontSize: 11.5 }}>{title}</span>{right}
      </div>
      <div style={{ padding: 20 }}>{children}</div>
    </div>
  );
}
function StatRow({ items, cols = "repeat(auto-fit, minmax(150px, 1fr))" }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: cols, gap: 12, marginBottom: 20 }}>
      {items.map((k, i) => (
        <div key={i} style={{ background: T.band, border: `1px solid ${T.rule}`, borderRadius: T.radiusMd, padding: "14px 16px", boxShadow: T.shadowSm }}>
          <div style={{ ...label, fontSize: 9.5, marginBottom: 6 }}>{k.l}</div>
          <div style={{ fontFamily: T.ui, fontSize: 20, fontWeight: 800, color: k.c || T.ink, fontVariantNumeric: "tabular-nums" }}>{k.v}</div>
        </div>
      ))}
    </div>
  );
}
// Soft blurred gradient blobs — echoes the reference site's animated hero background.
function HeroArt() {
  const blobs = [
    { c: T.green, top: "-8%", left: "6%", size: 340, dur: "22s", delay: "0s" },
    { c: T.steel, top: "18%", left: "62%", size: 300, dur: "26s", delay: "-6s" },
    { c: T.sage, top: "48%", left: "22%", size: 260, dur: "19s", delay: "-3s" },
  ];
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      {blobs.map((b, i) => (
        <div key={i} className="fx-blob" style={{
          position: "absolute", top: b.top, left: b.left, width: b.size, height: b.size,
          borderRadius: "50%", background: b.c, opacity: 0.28, filter: "blur(70px)",
          animationDuration: b.dur, animationDelay: b.delay,
        }} />
      ))}
    </div>
  );
}
/* Recharts Scatter shape: a dot with a soft halo, so the two points that matter
   most (where you are, where you'd be) read above the frontier's own markers. */
const haloDot = (fill, r = 8) => (props) => {
  const { cx, cy } = props || {};
  if (!isFinite(cx) || !isFinite(cy)) return null;
  return (
    <g style={{ pointerEvents: "none" }}>
      <circle cx={cx} cy={cy} r={r + 5} fill={fill} opacity={0.22} />
      <circle cx={cx} cy={cy} r={r} fill={fill} stroke={T.paper} strokeWidth={2.5} />
    </g>
  );
};
function TypeBadge({ type }) {
  const map = {
    strength: { t: "Strength", bg: "rgba(16,185,129,0.14)", c: T.green },
    consideration: { t: "Consideration", bg: "rgba(96,165,250,0.14)", c: T.steel },
    flag: { t: "Flag", bg: "rgba(251,191,36,0.16)", c: T.copper },
  };
  const m = map[type] || map.consideration;
  return <span style={{ fontFamily: T.ui, fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", background: m.bg, color: m.c, padding: "4px 10px", borderRadius: T.pill }}>{m.t}</span>;
}

// Luhn checksum for demo card validation
function luhnValid(numStr) {
  const d = numStr.replace(/\D/g, "");
  if (d.length < 15 || d.length > 16) return false;
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let x = parseInt(d[i], 10);
    if (alt) { x *= 2; if (x > 9) x -= 9; }
    sum += x; alt = !alt;
  }
  return sum % 10 === 0;
}

const SCENARIOS = {
  base: { name: "Base", fn: (a, c, rf) => ({ a, c, rf }) },
  crisis: { name: "Crisis", fn: (a, c, rf) => ({ a: a.map((x) => ({ ...x, er: x.er - 8, sigma: x.sigma * 1.5 })), c: c.map((row, i) => row.map((v, j) => (i === j ? 1 : 0.85))), rf }) },
  rates: { name: "Rate shock", fn: (a, c, rf) => ({ a: a.map((x) => ({ ...x, er: x.er - 3 })), c, rf: rf + 2 }) },
  boom: { name: "Risk-on", fn: (a, c, rf) => ({ a: a.map((x) => ({ ...x, er: x.er + 4 })), c: c.map((row, i) => row.map((v, j) => (i === j ? 1 : Math.max(-0.9, v - 0.15)))), rf }) },
};

/* ═══════════════ VALUATION CORE ═══════════════
   Reported financials come from the API as { key: [{year, v}] }. Everything
   below turns those facts into a normalized annual history, derives *default*
   assumptions from that history, and runs the discounting. The projection is
   a model, not data — every assumption it uses is surfaced and editable. */

const svArr = (s, k) => (s && s[k]) || [];
const avgOf = (a) => { const f = a.filter(isFinite); return f.length ? f.reduce((x, y) => x + y, 0) / f.length : NaN; };
// Working-capital swings are spiky enough that one odd year distorts a mean.
const medOf = (a) => {
  const f = a.filter(isFinite).sort((x, y) => x - y);
  if (!f.length) return NaN;
  const m = Math.floor(f.length / 2);
  return f.length % 2 ? f[m] : (f[m - 1] + f[m]) / 2;
};
const fin = (v, d = null) => (typeof v === "number" && isFinite(v) ? v : d);

/* A free-cash-flow DCF assumes capex and working capital drive value. For banks,
   insurers and REITs that assumption breaks down — deposits and float read as
   "debt", and there is no meaningful unlevered cash flow. Say so rather than
   printing a confident negative number. */
const DCF_UNSUITABLE = /financial|bank|insurance|capital markets|real estate|reit|asset management/i;
function dcfSuitability(fund, defaults) {
  const sector = (fund.quote && fund.quote.sector) || "";
  const industry = (fund.quote && fund.quote.industry) || "";
  if (DCF_UNSUITABLE.test(sector) || DCF_UNSUITABLE.test(industry)) {
    return { ok: false, why: `${sector || industry} businesses fund themselves with deposits, float or leverage that this model reads as debt. A free-cash-flow DCF is the wrong tool here — the multiples and returns below are the meaningful part.` };
  }
  if (!(defaults.ebitMargin > 0.005)) {
    return { ok: false, why: "This company reports no meaningful operating margin in the periods available, so a discounted cash-flow projection has nothing dependable to build on." };
  }
  if (!(defaults.shares > 0) || !(defaults.rev0 > 0)) {
    return { ok: false, why: "Share count or revenue is missing from the reported data, so a per-share value cannot be computed." };
  }
  return { ok: true, why: null };
}

function buildHistory(series) {
  const years = svArr(series, "TotalRevenue").map((p) => p.year);
  const at = (k, yr) => { const hit = svArr(series, k).find((p) => p.year === yr); return hit ? hit.v : null; };
  const pick = (yr, ...keys) => { for (const k of keys) { const v = at(k, yr); if (v != null) return v; } return null; };
  return years.map((yr) => {
    const rev = at("TotalRevenue", yr);
    const ebit = pick(yr, "EBIT", "OperatingIncome");
    const pretax = at("PretaxIncome", yr);
    const tax = at("TaxProvision", yr);
    const capexRaw = at("CapitalExpenditure", yr);
    return {
      year: yr, rev, ebit,
      ebitda: at("EBITDA", yr), ni: at("NetIncome", yr), pretax, tax,
      da: pick(yr, "ReconciledDepreciation", "DepreciationAndAmortization"),
      // Yahoo reports capex as a negative cash-flow line; we want the outflow magnitude.
      capex: capexRaw == null ? null : Math.abs(capexRaw),
      // ChangeInWorkingCapital is already signed as a cash-flow effect
      // (negative = working capital consumed cash), so investment = −value.
      nwcInv: at("ChangeInWorkingCapital", yr) == null ? null : -at("ChangeInWorkingCapital", yr),
      ca: at("CurrentAssets", yr), cl: at("CurrentLiabilities", yr),
      debt: at("TotalDebt", yr),
      cash: pick(yr, "CashCashEquivalentsAndShortTermInvestments", "CashAndCashEquivalents"),
      equity: at("StockholdersEquity", yr), shares: at("OrdinarySharesNumber", yr),
      interest: at("InterestExpense", yr), invCap: at("InvestedCapital", yr),
      fcf: at("FreeCashFlow", yr), ocf: at("OperatingCashFlow", yr),
      // TaxRateForCalcs comes back as 0 from this feed, so always derive it.
      taxRate: (pretax && tax != null && pretax > 0) ? tax / pretax : null,
    };
  });
}

function deriveDefaults(fund, hist, rf, mrp) {
  const q = fund.quote || {};
  const n = hist.length;
  const last = hist[n - 1] || {};
  const tail = hist.slice(-3);
  const ratio = (f) => avgOf(tail.map((h) => (h.rev > 0 ? f(h) / h.rev : NaN)));
  const clamp = (v, lo, hi, dflt) => (isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt);

  /* Provenance. Every input below is either computed from a reported line or,
     when that line is absent, filled with a generic constant. A filled-in
     constant is not this company's data and must never pass as if it were, so
     each one is recorded here and surfaced in the panel. */
  const reported = (k) => hist.some((h) => h[k] != null);
  const sourced = {
    growth: reported("rev"),
    ebitMargin: reported("ebit"),
    ebitdaMargin: reported("ebitda"),
    daPct: reported("da"),
    capexPct: reported("capex"),
    nwcPct: reported("ca") && reported("cl"),
    taxRate: hist.some((h) => h.taxRate != null),
    kd: reported("interest") && reported("debt"),
    beta: q.beta != null,
    shares: q.shares != null || reported("shares"),
    exitMult: q.evToEbitda != null,
  };

  // Revenue growth, measured three ways. A single CAGR anchored on whatever
  // year the feed happens to start with is not enough — 2022 was a cyclical
  // peak for energy and a COVID peak for vaccine makers, and anchoring there
  // extrapolates a decline forever. The panel shows all three and says which
  // one it used.
  let cagr = NaN;
  const first = hist.find((h) => h.rev > 0);
  if (first && last.rev > 0 && last.year > first.year) {
    cagr = Math.pow(last.rev / first.rev, 1 / (last.year - first.year)) - 1;
  }
  const yoyAll = [];
  for (let i = 1; i < n; i++) {
    if (hist[i - 1].rev > 0 && hist[i].rev > 0) yoyAll.push(hist[i].rev / hist[i - 1].rev - 1);
  }
  const yoyLatest = yoyAll.length ? yoyAll[yoyAll.length - 1] : NaN;
  const yoyMedian = medOf(yoyAll);
  // Take the middle of three measures rather than trusting any one of them.
  // A CAGR is hostage to whichever year the feed starts with (2022 was a
  // cyclical peak for energy and a COVID peak for vaccine makers); the latest
  // year-over-year is hostage to one year; the median ignores a real trend.
  // The median of the three is robust to any single one being distorted.
  const measures = [cagr, yoyLatest, yoyMedian].filter(isFinite);
  const chosen = medOf(measures);
  const spread = measures.length > 1 ? Math.max(...measures) - Math.min(...measures) : 0;
  const measuresDisagree = spread > 0.10;
  const growthClamped = isFinite(chosen) && (chosen > 0.45 || chosen < -0.15);

  // Effective rates swing wildly on one-off credits and settlements. A rate
  // outside a plausible band says more about a single year's tax accounting
  // than about the cash taxes a going concern will pay, so fall back to the
  // statutory rate rather than discounting a 5%-taxed company forever.
  const STATUTORY_TAX = 0.21;
  const effTax = avgOf(tail.map((h) => h.taxRate));
  const taxImplausible = !isFinite(effTax) || effTax < 0.10 || effTax > 0.45;
  const taxRate = taxImplausible ? STATUTORY_TAX : effTax;

  const debt = fin(last.debt, fin(q.totalDebt, 0)) || 0;
  const cash = fin(last.cash, fin(q.totalCash, 0)) || 0;
  const shares = fin(q.shares, fin(last.shares, null));

  // Raw historical betas are noisy and mean-revert toward the market. Applying
  // the standard Blume 2/3–1/3 adjustment (what Bloomberg publishes as
  // "adjusted beta") stops a low trailing beta from producing a 4% WACC on a
  // large-cap — Exxon's raw beta prints at 0.16, which no desk would use.
  const betaRaw = clamp(fin(q.beta), -0.5, 4, 1);
  const beta = 0.67 * betaRaw + 0.33;

  // Cost of debt from what the company actually pays, not a guess.
  const kdRaw = avgOf(tail.map((h) => (h.interest && h.debt > 0 ? h.interest / h.debt : NaN)));
  const kd = clamp(kdRaw, 0.01, 0.15, 0.05);

  // A single-factor CAPM hands back a 4–5% cost of equity for low-beta names
  // (Exxon's trailing beta is genuinely ~0.2 over this window), which is below
  // what any practitioner would use to discount equity. Floor the equity risk
  // contribution at 300bp over the risk-free rate, and floor the blended WACC
  // at 6%. Both are disclosed in the panel and both remain editable.
  const KE_FLOOR_SPREAD = 0.03, WACC_FLOOR = 0.06;
  const keRaw = rf / 100 + beta * (mrp / 100);
  const keFloorVal = rf / 100 + KE_FLOOR_SPREAD;
  const keFloored = keRaw < keFloorVal;
  const ke = Math.max(keRaw, keFloorVal);

  const mcap = fin(q.marketCap, shares && fund.price ? shares * fund.price : null);
  const E = mcap || 0, D = debt;
  const waccRaw = E + D > 0 ? (E / (E + D)) * ke + (D / (E + D)) * kd * (1 - taxRate) : ke;
  const waccFloored = waccRaw < WACC_FLOOR;
  const wacc = Math.max(waccRaw, WACC_FLOOR);

  return {
    growth: clamp(chosen, -0.15, 0.45, 0.05),
    growthCagr: cagr, growthYoyLatest: yoyLatest, growthYoyMedian: yoyMedian,
    growthClamped, measuresDisagree, spread,
    periods: n, taxImplausible, effTax, betaRaw, keFloored, waccFloored, keRaw, waccRaw,
    sourced, unsourced: Object.keys(sourced).filter((k) => !sourced[k]),
    tg: 0.025,
    years: 10, // standard explicit period; short horizons load too much onto terminal value
    ebitMargin: clamp(ratio((h) => h.ebit), -0.5, 0.75, 0.15),
    ebitdaMargin: clamp(ratio((h) => h.ebitda), -0.5, 0.85, 0.2),
    taxRate,
    daPct: clamp(ratio((h) => h.da), 0, 0.5, 0.05),
    capexPct: clamp(ratio((h) => h.capex), 0, 0.6, 0.05),
    // Working capital as a *level* ratio (can be negative — Apple and Coca-Cola
    // both run negative NWC, where growth releases cash rather than consuming it).
    // The projection applies this to the change in revenue, not the level.
    nwcPct: clamp(medOf(tail.map((h) => (h.rev > 0 && h.ca != null && h.cl != null ? (h.ca - h.cl) / h.rev : NaN))), -0.5, 0.6, 0.05),
    wacc: clamp(wacc, 0.03, 0.30, 0.09),
    ke: clamp(ke, 0.03, 0.35, 0.09),
    kd, beta, taxRateSrc: taxRate,
    rev0: fin(last.rev, fin(q.revenue, null)),
    ebitda0: fin(last.ebitda, fin(q.ebitda, null)),
    netDebt: debt - cash, debt, cash, shares,
    exitMult: clamp(fin(q.evToEbitda), 3, 40, 10),
    termMode: "gordon",
  };
}

/* Projects FCFF and FCFE side by side off one set of operating assumptions,
   so the levered and unlevered answers are internally consistent. */
function runDCF(a) {
  if (!a || !isFinite(a.rev0) || a.rev0 <= 0 || !isFinite(a.shares) || a.shares <= 0) return null;
  const yrs = Math.max(1, Math.min(15, Math.round(a.years)));
  const rows = [];
  let rev = a.rev0, debt = a.debt || 0;
  for (let t = 1; t <= yrs; t++) {
    // Growth fades linearly from the starting rate to the terminal rate.
    const g = yrs === 1 ? a.tg : a.growth + (a.tg - a.growth) * ((t - 1) / (yrs - 1));
    const prevRev = rev;
    rev *= 1 + g;
    const ebit = rev * a.ebitMargin;
    const nopat = ebit * (1 - a.taxRate);
    const da = rev * a.daPct, capex = rev * a.capexPct;
    // Working capital is only invested (or released) as revenue changes.
    const nwc = a.nwcPct * (rev - prevRev);
    const fcff = nopat + da - capex - nwc;
    // Debt is held at a constant share of revenue, so net borrowing funds growth.
    const newDebt = debt * (1 + g), netBorrow = newDebt - debt;
    const interest = debt * a.kd;
    const ni = (ebit - interest) * (1 - a.taxRate);
    const fcfe = ni + da - capex - nwc + netBorrow;
    debt = newDebt;
    rows.push({ t, g, rev, ebit, nopat, da, capex, nwc, fcff, ni, interest, netBorrow, fcfe, ebitda: ebit + da });
  }
  const lastRow = rows[yrs - 1];
  const disc = (r) => rows.map((x) => 1 / Math.pow(1 + r, x.t));

  const termAt = (r, flow) => {
    if (a.termMode === "exit") return lastRow.ebitda * a.exitMult;
    if (!(r > a.tg)) return NaN; // Gordon is undefined once growth meets the discount rate
    return (flow * (1 + a.tg)) / (r - a.tg);
  };

  // ── Unlevered: FCFF @ WACC → enterprise value → equity
  const dfU = disc(a.wacc);
  const pvU = rows.reduce((s, x, i) => s + x.fcff * dfU[i], 0);
  const tvU = termAt(a.wacc, lastRow.fcff);
  const pvTvU = isFinite(tvU) ? tvU / Math.pow(1 + a.wacc, yrs) : NaN;
  const ev = pvU + pvTvU;
  const eqU = ev - a.netDebt;
  const psU = eqU / a.shares;

  // ── Levered: FCFE @ cost of equity → equity value directly
  const dfL = disc(a.ke);
  const pvL = rows.reduce((s, x, i) => s + x.fcfe * dfL[i], 0);
  // An exit multiple prices the whole firm, so back out debt to keep it an equity figure.
  const tvLraw = a.termMode === "exit" ? lastRow.ebitda * a.exitMult - debt : termAt(a.ke, lastRow.fcfe);
  const pvTvL = isFinite(tvLraw) ? tvLraw / Math.pow(1 + a.ke, yrs) : NaN;
  const eqL = pvL + pvTvL;
  const psL = eqL / a.shares;

  return {
    rows, ev, equityU: eqU, perShareU: psU, pvExplicitU: pvU, pvTermU: pvTvU,
    equityL: eqL, perShareL: psL, pvExplicitL: pvL, pvTermL: pvTvL,
    termPctU: isFinite(pvTvU) && ev ? pvTvU / ev : NaN,
    termPctL: isFinite(pvTvL) && eqL ? pvTvL / eqL : NaN,
  };
}

/* What revenue growth would today's share price have to be assuming?
   Returns { g } when the price is reachable, or { beyond: "above"|"below" }
   when even the extremes of the search range cannot get there — that is a real
   answer about the price, not a failure, so report it as one. */
const RDCF_LO = -0.50, RDCF_HI = 1.50;
function reverseDCF(a, price) {
  if (!isFinite(price) || price <= 0) return null;
  const f = (g) => {
    const r = runDCF({ ...a, growth: g });
    return r && isFinite(r.perShareU) ? r.perShareU - price : NaN;
  };
  let lo = RDCF_LO, hi = RDCF_HI;
  let flo = f(lo), fhi = f(hi);
  if (!isFinite(flo) || !isFinite(fhi)) return null;
  if (flo > 0) return { beyond: "below" };   // even a shrinking business is worth more than this
  if (fhi < 0) return { beyond: "above" };   // even extreme growth cannot justify the price
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2, fm = f(mid);
    if (!isFinite(fm)) return null;
    if (flo * fm <= 0) hi = mid; else { lo = mid; flo = fm; }
  }
  return { g: (lo + hi) / 2 };
}

/* ═══════════════ APP ═══════════════ */

/* Analytics: never let a blocked/absent tracker throw into React. */
const ev = (name, props) => { try { track(name, props); } catch (e) {} };

function FrontierApp() {
  const [view, setView] = useState("landing");
  const [mode, setMode] = useState("basic"); // basic | advanced
  const [plan, setPlanRaw] = useState(() => { try { return localStorage.getItem("fx_plan") || "free"; } catch (e) { return "free"; } });
  const setPlan = (p) => { setPlanRaw(p); try { localStorage.setItem("fx_plan", p); } catch (e) {} };
  React.useEffect(() => {
    try {
      const FRIEND_KEYS = ["FX-A7K2","FX-B4M9","FX-C1R6","FX-D8T3","FX-E5W7","FX-F2N4","FX-G9J1","FX-H6P8","FX-J3L5","FX-K7Q2"];
      const k = new URLSearchParams(window.location.search).get("key");
      if (k && FRIEND_KEYS.indexOf(k.toUpperCase()) >= 0) setPlan("pro");
    } catch (e) {}
  }, []);
  // One event per screen the visitor actually lands on, so the funnel
  // landing → basic/advanced → paywall → checkout is visible in Vercel.
  React.useEffect(() => {
    ev("screen", { screen: view === "app" ? "app:" + mode : view, plan });
  }, [view, mode, plan]);
  const [mktLoading, setMktLoading] = useState(false);
  const [mktNote, setMktNote] = useState(null);
  // n×n flags: which correlations were actually measured vs still placeholder.
  const [corrReal, setCorrReal] = useState(null);
  const fetchMarketData = async () => {
    setMktLoading(true); setMktNote(null);
    ev("market_data_fetch", { assets: assets.length });
    try {
      const syms = assets.map((a) => a.name).join(",");
      const r = await fetch("/api/claude?corr=" + encodeURIComponent(syms));
      const d = await r.json();
      const MRP = 5.5;
      if (d.vols || d.betas) setAssets(assets.map((a, i) => {
        const next = { ...a };
        if (d.vols && d.vols[i]) next.sigma = d.vols[i];
        if (d.betas && typeof d.betas[i] === "number") next.er = Math.round((rf + d.betas[i] * MRP) * 10) / 10;
        return next;
      }));
      if (d.corr) {
        const n = assets.length;
        const c = normalizeCorr(corr, n);
        // Track which pairs came back with real data so the placeholders that
        // remain can be marked rather than passing as measured correlations.
        const real = Array.from({ length: n }, () => Array(n).fill(false));
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            const v = d.corr[i] && d.corr[i][j];
            if (typeof v === "number" && isFinite(v)) {
              c[i][j] = Math.round(v * 100) / 100;
              real[i][j] = true; real[j][i] = true;
            }
          }
        }
        setCorr(c);
        setCorrReal(real);
      }
      const miss = (d.missing && d.missing.length) ? " No data for: " + d.missing.join(", ") + "." : "";
      const bl = (d.betas && d.betas.some((b) => typeof b === "number"))
        ? " Betas vs " + (d.benchmark || "SPY") + ": " + assets.map((a, i) => a.name + " " + (d.betas[i] != null ? d.betas[i].toFixed(2) : "n/a")).join(", ") + "."
        : "";
      const warn = d.note ? " " + d.note : "";
      setMktNote("Dividend-adjusted, in " + (d.currency || "native currency") + ". σ, ρ and β computed from " + (d.points || 0) + " weekly observations (per asset). E[r] set by CAPM: rf + β × 5.5% market risk premium." + bl + miss + warn);
    } catch (e) {
      setMktNote("Couldn't reach market data.");
    } finally { setMktLoading(false); }
  };
  const [showPaywall, setShowPaywall] = useState(false);
  const [showCheckout, setShowCheckout] = useState(null); // "advanced" | "pro" | null
  const [ckEmail, setCkEmail] = useState("");
  const [ckCard, setCkCard] = useState("");
  const [ckExp, setCkExp] = useState("");
  const [ckCvc, setCkCvc] = useState("");
  const [ckErr, setCkErr] = useState(null);
  const [trialEnds, setTrialEnds] = useState(null);
  React.useEffect(() => { if (showPaywall) ev("paywall_opened", { plan }); }, [showPaywall, plan]);
  React.useEffect(() => { if (showCheckout) ev("checkout_opened", { tier: String(showCheckout) }); }, [showCheckout]);

  // basic-mode state — restored from the same saved book (it was persisted but
  // never read back, so Basic mode always reset to empty on reload).
  const [bHoldings, setBHoldings] = useState(() => {
    try {
      const b = JSON.parse(localStorage.getItem("fx_book") || "null");
      return (b && sanitizeHoldings(b.bHoldings)) || [{ name: "", amount: 0, risk: "med" }];
    } catch (e) { return [{ name: "", amount: 0, risk: "med" }]; }
  });
  const [bYears, setBYears] = useState(10);
  const [bMonthly, setBMonthly] = useState(0);

  // advanced-mode state
  const savedBook = (() => { try { return JSON.parse(localStorage.getItem("fx_book") || "null"); } catch (e) { return null; } })();
  const initAssets = (savedBook && sanitizeAssets(savedBook.assets)) || DEFAULT_ASSETS;
  const [assets, setAssets] = useState(initAssets);
  // Sized from the restored assets, not DEFAULT_ASSETS — a saved book with more
  // than 5 holdings previously left this matrix too small and crashed the render.
  const [corr, setCorr] = useState(() => normalizeCorr(savedBook && savedBook.corr, initAssets.length));
  const [rf, setRf] = useState(savedBook && isFinite(Number(savedBook.rf)) ? Number(savedBook.rf) : 3.5);
  const [A, setA] = useState(savedBook && isFinite(Number(savedBook.A)) ? Number(savedBook.A) : 4);
  const [longOnly, setLongOnly] = useState(true);
  const [scenario, setScenario] = useState("base");
  const [mcYears, setMcYears] = useState(10);
  const [mcStart, setMcStart] = useState(25000);
  const [mcSeed, setMcSeed] = useState(0);

  const [briefTicker, setBriefTicker] = useState(null);
  const [briefData, setBriefData] = useState(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [briefErr, setBriefErr] = useState(null);
  const [aiItems, setAiItems] = useState(null);
  const [aiWithheld, setAiWithheld] = useState(0);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState(null);

  const n = assets.length;
  const isPro = plan === "pro";
  const isAdv = plan !== "free"; // advanced trial or pro
  // Position along the frontier: w(t) = t·wTangency + (1−t)·wMinVar.
  // 0 = minimum variance, 1 = maximum Sharpe. Same parameterization the
  // frontier curve itself is drawn from, so the marker always sits on the line.
  const [frontierT, setFrontierT] = useState(1);

  /* ---- valuation (Pro) ---- */
  const [valSym, setValSym] = useState("");
  const [valData, setValData] = useState(null);
  const [valLoading, setValLoading] = useState(false);
  const [valErr, setValErr] = useState(null);
  // User edits layered over the history-derived defaults; null = use the default.
  const [valOv, setValOv] = useState({});
  const loadValuation = async (sym) => {
    const s = String(sym || "").trim().toUpperCase();
    if (!s) return;
    setValLoading(true); setValErr(null); setValData(null); setValOv({});
    ev("valuation_run", { symbol: s });
    try {
      const r = await fetch("/api/claude?fund=" + encodeURIComponent(s));
      const d = await r.json();
      if (d.crashed) { setValErr("The data service failed on that request. Try again in a moment."); }
      else if (d.throttled && !d.haveStatements) {
        setValErr((d.notes && d.notes[0]) || "The market data provider is rate-limiting requests. Wait a moment and try again.");
      }
      else if (!d.haveStatements) {
        setValErr((d.notes && d.notes[0]) || ("No company financials are published for " + s + "."));
        setValData(d);
      } else setValData(d);
    } catch (e) {
      setValErr("Couldn't reach the financial data service.");
    } finally { setValLoading(false); }
  };

  React.useEffect(() => {
    try { localStorage.setItem("fx_book", JSON.stringify({ assets, corr, rf, A, bHoldings })); } catch (e) {}
  }, [assets, corr, rf, A, bHoldings]);

  /* Pull real volatilities, betas and correlations whenever the set of tickers
     changes. Without this the model silently runs on a 0.35 placeholder
     correlation for every pair until someone happens to press the button, and
     a newly added holding reintroduces the placeholder. Keyed on the ticker
     list alone — σ and E[r] write back into `assets`, so keying on the whole
     array would loop. */
  const tickerKey = assets.map((a) => String(a.name || "").trim().toUpperCase()).join(",");
  const lastFetchedRef = React.useRef(null);
  React.useEffect(() => {
    const syms = tickerKey.split(",").filter(Boolean);
    if (syms.length < 2 || tickerKey === lastFetchedRef.current) return;
    const t = setTimeout(() => { lastFetchedRef.current = tickerKey; fetchMarketData(); }, 800);
    return () => clearTimeout(t);
  }, [tickerKey]);

  /* ---- shared model runners ---- */
  const [rev, setRev] = useState(0);
  const inputSnap = JSON.stringify([assets, corr, rf, A, longOnly, mcYears, mcStart]);
  const [appliedSnap, setAppliedSnap] = useState(inputSnap);
  const dirty = inputSnap !== appliedSnap;
  const applyInputs = () => setRev((r) => r + 1);
  React.useEffect(() => { setAppliedSnap(inputSnap); }, [rev]);

  const runModel = (aRaw, c, rfPct) => {
    // sanitize: volatility floor of 1% prevents singular covariance from zero-vol input
    const a = aRaw.map((x) => ({ ...x, sigma: Math.max(1, Math.abs(x.sigma) || 1) }));
    const mu = a.map((x) => x.er / 100);
    const S = buildCov(a, c);
    const rfd = rfPct / 100;
    const sol = longOnly ? solveLongOnly(mu, S, rfd, a.length) : solveUnconstrained(mu, S, rfd);
    if (!sol) return null;
    const tan = { w: sol.wTan, ...portStats(sol.wTan, mu, S) };
    const minv = { w: sol.wMin, ...portStats(sol.wMin, mu, S) };
    tan.sharpe = (tan.ret - rfd) / tan.sigma;
    // reject numerically invalid solutions (e.g. inconsistent correlation matrix)
    const bad = [tan.ret, tan.sigma, tan.sharpe, minv.sigma, ...tan.w, ...minv.w].some((x) => !isFinite(x));
    if (bad || tan.sigma <= 0) return null;
    return { tan, minv, mu, S, rfd };
  };
  const base = useMemo(() => runModel(assets, corr, rf), [rev]);
  const scen = useMemo(() => {
    if (scenario === "base" || !base) return null;
    const { a, c, rf: r2 } = SCENARIOS[scenario].fn(assets, corr, rf);
    return runModel(a, c, r2);
  }, [scenario, base, rev]);

  const chart = useMemo(() => {
    if (!base) return null;
    const { tan, minv, mu, S, rfd } = base;
    const frontier = [];
    const range = longOnly ? [0, 1.001, 0.05] : [-1.2, 2.6, 0.04];
    for (let t = range[0]; t <= range[1]; t += range[2]) {
      const w = tan.w.map((wi, i) => t * wi + (1 - t) * minv.w[i]);
      const p = portStats(w, mu, S);
      frontier.push({ x: p.sigma * 100, y: p.ret * 100 });
    }
    frontier.sort((a, b) => a.x - b.x);
    const calMaxX = Math.max(tan.sigma * 100 * 1.6, 5);
    const cal = [{ x: 0, y: rf }, { x: calMaxX, y: rf + tan.sharpe * calMaxX }];
    const yStar = (tan.ret - rfd) / (A * tan.sigma * tan.sigma);
    const yC = Math.max(0, Math.min(yStar, 2));
    return { frontier, cal, yStar, complete: { ret: rfd + yC * (tan.ret - rfd), sigma: yC * tan.sigma }, assetPts: assets.map((a) => ({ x: a.sigma, y: a.er, name: a.name })) };
  }, [base, rev]);

  const mc = useMemo(() => (base ? monteCarlo(base.tan.ret, base.tan.sigma, mcYears, 500, Math.max(1, mcStart)) : null),
    [base, mcSeed, rev]);

  const current = useMemo(() => {
    if (!base) return null;
    const amts = assets.map((a) => Math.max(0, Number(a.amount) || 0));
    const tot = amts.reduce((x, y) => x + y, 0);
    if (tot <= 0) return null;
    const w = amts.map((x) => x / tot);
    const pp = portStats(w, base.mu, base.S);
    const sh = (pp.ret - base.rfd) / pp.sigma;
    return { w, tot, ret: pp.ret, sigma: pp.sigma, sharpe: sh, gap: base.tan.sharpe - sh };
  }, [base, rev]);

  /* The point on the frontier the user has selected, plus the weight changes
     that separate it from what they actually hold. Purely a comparison of two
     weightings — no transaction sizing, to stay inside the app's descriptive-only
     framing. */
  const tBounds = longOnly ? [0, 1] : [-1.2, 2.6];
  const tClamped = Math.max(tBounds[0], Math.min(tBounds[1], frontierT));
  const target = useMemo(() => {
    if (!base) return null;
    const { tan, minv, mu, S, rfd } = base;
    const w = tan.w.map((wi, i) => tClamped * wi + (1 - tClamped) * minv.w[i]);
    const p = portStats(w, mu, S);
    if (!isFinite(p.ret) || !isFinite(p.sigma) || p.sigma <= 0) return null;
    return {
      w, ret: p.ret, sigma: p.sigma,
      sharpe: (p.ret - rfd) / p.sigma,
      deltas: current ? w.map((tw, i) => {
        const cw = current.w[i];
        return { i, from: cw, to: tw, dw: tw - cw, dollars: (tw - cw) * current.tot };
      }) : null,
    };
  }, [base, tClamped, current, rev]);

  const qInsights = useMemo(
    () => (base ? quantInsights(assets, corr, { tan: base.tan }, rf / 100, A) : []),
    [base, rev]
  );

  /* Valuation model. Defaults come from the reported history; anything the user
     has overridden wins. Recomputes on every edit so the sensitivity of the
     answer to each assumption is visible immediately. */
  const val = useMemo(() => {
    if (!valData || !valData.haveStatements) return null;
    const hist = buildHistory(valData.series);
    if (!hist.length) return null;
    const defs = deriveDefaults(valData, hist, rf, 5.5);
    const asm = { ...defs };
    for (const k in valOv) if (valOv[k] != null && isFinite(valOv[k])) asm[k] = valOv[k];
    if (valOv.termMode) asm.termMode = valOv.termMode;
    const suit = dcfSuitability(valData, asm);
    const dcf = suit.ok ? runDCF(asm) : null;
    const price = valData.price;
    const implied = reverseDCF(asm, price);

    // WACC × terminal-growth grid — the honest way to show a DCF's range.
    const grid = suit.ok ? (() => {
      const waccs = [-0.02, -0.01, 0, 0.01, 0.02].map((d) => asm.wacc + d).filter((w) => w > 0.01);
      const tgs = [-0.01, -0.005, 0, 0.005, 0.01].map((d) => asm.tg + d);
      return {
        waccs, tgs,
        cells: waccs.map((w) => tgs.map((g) => {
          const o = runDCF({ ...asm, wacc: w, tg: g });
          return o && isFinite(o.perShareU) ? o.perShareU : NaN;
        })),
      };
    })() : null;

    const q = valData.quote || {};
    const last = hist[hist.length - 1];
    const mcap = fin(q.marketCap, asm.shares && price ? asm.shares * price : null);
    const evNow = fin(q.enterpriseValue, mcap != null ? mcap + asm.netDebt : null);
    const safeDiv = (a2, b2) => (isFinite(a2) && isFinite(b2) && b2 !== 0 ? a2 / b2 : NaN);
    const multiples = [
      { l: "P/E (trailing)", v: fin(q.trailingPE, safeDiv(mcap, last.ni)), d: 1 },
      { l: "P/E (forward)", v: fin(q.forwardPE), d: 1 },
      { l: "EV / EBITDA", v: fin(q.evToEbitda, safeDiv(evNow, last.ebitda)), d: 1 },
      { l: "EV / Sales", v: fin(q.evToRevenue, safeDiv(evNow, last.rev)), d: 2 },
      { l: "EV / EBIT", v: safeDiv(evNow, last.ebit), d: 1 },
      { l: "Price / Book", v: fin(q.priceToBook, safeDiv(mcap, last.equity)), d: 2 },
      { l: "Price / FCF", v: safeDiv(mcap, last.fcf), d: 1 },
      { l: "PEG", v: fin(q.pegRatio), d: 2 },
      { l: "FCF yield", v: safeDiv(last.fcf, mcap), d: 2, pct: true },
      { l: "Dividend yield", v: fin(q.dividendYield), d: 2, pct: true },
    ];
    const quality = [
      { l: "Operating margin", v: safeDiv(last.ebit, last.rev), pct: true },
      { l: "Net margin", v: safeDiv(last.ni, last.rev), pct: true },
      { l: "Return on equity", v: fin(q.returnOnEquity, safeDiv(last.ni, last.equity)), pct: true },
      { l: "ROIC (after tax)", v: safeDiv(last.ebit * (1 - asm.taxRate), last.invCap), pct: true },
      { l: "Net debt / EBITDA", v: safeDiv(asm.netDebt, last.ebitda), d: 2 },
      { l: "Interest coverage", v: safeDiv(last.ebit, last.interest), d: 1 },
      { l: "Effective tax rate", v: asm.taxRate, pct: true },
      { l: "Revenue CAGR (reported)", v: defs.growth, pct: true },
    ];
    return { hist, defs, asm, suit, dcf, grid, implied, price, multiples, quality, mcap, evNow, q };
  }, [valData, valOv, rf]);

  /* ---- basic-mode derived model ---- */
  const basic = useMemo(() => {
    const hs = bHoldings.filter((h) => h.amount > 0);
    if (hs.length < 1) return null;
    const total = hs.reduce((s, h) => s + h.amount, 0);
    const w = hs.map((h) => h.amount / total);
    const a2 = hs.map((h) => ({ name: h.name, er: RISK_PRESETS[h.risk].er, sigma: RISK_PRESETS[h.risk].sigma }));
    const c2 = hs.map((_, i) => hs.map((_, j) => (i === j ? 1 : 0.4)));
    const mu = a2.map((x) => x.er / 100);
    const S = buildCov(a2, c2);
    const p = portStats(w, mu, S);
    const hhi = w.reduce((s, x) => s + x * x, 0);
    const effN = 1 / hhi;
    const riskBucket = p.sigma < 0.14 ? "Lower" : p.sigma < 0.24 ? "Moderate" : p.sigma < 0.34 ? "Elevated" : "High";
    const sim = monteCarloContrib(p.ret, p.sigma, bYears, 400, total, Math.max(0, bMonthly));
    const biggest = hs.reduce((m, h) => (h.amount > m.amount ? h : m), hs[0]);
    const mix = { low: 0, med: 0, high: 0 };
    hs.forEach((h) => { mix[h.risk] += h.amount / total; });
    const notes = [];
    notes.push(`${biggest.name} is ${pct(biggest.amount / total, 0)} of the portfolio — the single largest driver of results.`);
    notes.push(effN < hs.length * 0.6
      ? `The mix behaves like roughly ${effN.toFixed(1)} independent positions, so results depend heavily on a few holdings.`
      : `The mix is fairly evenly spread — it behaves like about ${effN.toFixed(1)} independent positions.`);
    const hiShare = mix.high;
    if (hiShare > 0.5) notes.push(`${pct(hiShare, 0)} of the money is in aggressive holdings, which is the main source of the swings shown below.`);
    const hiCount = hs.filter((h) => h.risk === "high").length;
    if (hiCount >= 2) notes.push(`${hiCount} aggressive holdings tend to rise and fall together — in a rough market they usually drop at the same time.`);
    if (mix.low === 0 && hs.length >= 3) notes.push(`Nothing in the mix is in the steady category, so there's no cushion when the aggressive holdings swing.`);
    return { total, w, p, effN, riskBucket, sim, notes, mix, count: hs.length };
  }, [bHoldings, bYears, bMonthly]);

  const setB = (i, key, val) => setBHoldings(bHoldings.map((h, k) => (k === i ? { ...h, [key]: val } : h)));
  const addB = () => bHoldings.length < 10 && setBHoldings([...bHoldings, { name: `Company ${String.fromCharCode(65 + bHoldings.length)}`, amount: 1000, risk: "med" }]);
  const rmB = (i) => bHoldings.length > 1 && setBHoldings(bHoldings.filter((_, k) => k !== i));

  const setAsset = (i, key, val) => setAssets(assets.map((x, k) => (k === i ? { ...x, [key]: val } : x)));
  const setRho = (i, j, val) => {
    const v = Math.max(-0.99, Math.min(0.99, val));
    const c = corr.map((r) => [...r]);
    c[Math.min(i, j)][Math.max(i, j)] = v;
    setCorr(c);
    // A hand-entered figure is a deliberate choice, not an unmeasured gap.
    setCorrReal((prev) => {
      const nx = (prev || Array.from({ length: n }, () => Array(n).fill(false))).map((r) => [...r]);
      if (nx[i] && nx[j]) { nx[i][j] = true; nx[j][i] = true; }
      return nx;
    });
  };
  const addAsset = () => {
    if (n >= 30) return;
    setAssets([...assets, { name: `ASSET${n + 1}`, er: 8, sigma: 20, amount: 1000 }]);
    const c = corr.map((r) => [...r, 0.35]);
    c.push(Array(n + 1).fill(0.35)); c[n][n] = 1;
    setCorr(c);
    // The new row/column is unmeasured until market data comes back for it.
    setCorrReal((prev) => (prev ? prev.map((r) => [...r, false]).concat([Array(n + 1).fill(false)]) : null));
  };
  const removeAsset = (i) => {
    if (n <= 2) return;
    setAssets(assets.filter((_, k) => k !== i));
    setCorr(corr.filter((_, r2) => r2 !== i).map((r) => r.filter((_, c2) => c2 !== i)));
    setCorrReal((prev) => (prev ? prev.filter((_, r2) => r2 !== i).map((r) => r.filter((_, c2) => c2 !== i)) : null));
  };

  /* ---- AI with safeguards ---- */
  async function runAiInsights() {
    if (!isPro) { setShowPaywall(true); return; }
    if (!base) return;
    setAiLoading(true); setAiError(null); setAiItems(null); setAiWithheld(0);
    const payload = {
      assets: assets.map((a, i) => ({ name: a.name, expectedReturnPct: a.er, volPct: a.sigma, tangencyWeightPct: +(base.tan.w[i] * 100).toFixed(1) })),
      riskFreePct: rf,
      tangency: { retPct: +(base.tan.ret * 100).toFixed(1), sigmaPct: +(base.tan.sigma * 100).toFixed(1), sharpe: +base.tan.sharpe.toFixed(2) },
      longOnly,
    };
    try {
      const response = await fetch("/api/claude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6", max_tokens: 1200,
          messages: [{ role: "user", content: `${AI_PROMPT_RULES}\n\nData: ${JSON.stringify(payload)}` }],
        }),
      });
      const data = await response.json();
      const text = data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      const { passed, withheldCount } = filterAiItems(parsed.items);
      setAiItems(passed);
      setAiWithheld(withheldCount);
    } catch { setAiError("Analysis unavailable. Retry."); }
    finally { setAiLoading(false); }
  }

  /* ---- Security brief: recent factual coverage via web search, mapped to
     model inputs only. Same no-advice contract + output filter as observations. ---- */
  async function runBrief(ticker) {
    if (!isPro) { setShowPaywall(true); return; }
    setBriefTicker(ticker); setBriefData(null); setBriefErr(null); setBriefLoading(true);
    try {
      const response = await fetch("/api/claude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6", max_tokens: 1500,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content: `Search the web for recent news about the security with ticker ${ticker}. Then respond ONLY with valid JSON, no markdown fences, no preamble. You are a factual summarizer for an allocation calculator, NOT an advisor. Hard rules: no recommendations, no buy/sell/hold language, no price targets, no predictions, no "should", no opinions on whether news is good or bad for an investor. Summarize only what happened, in neutral factual language, paraphrased in your own words (never quote headlines or article text verbatim). Schema: {"items":[{"category":"Earnings|Regulatory|Product|Macro|Corporate|Other","title":"short factual title in your own words","note":"1-2 factual sentences on what happened"}],"modelNote":"1-2 sentences on which model INPUT this news category is mechanically relevant to (the volatility assumption, the correlation assumptions, or the expected-return assumption) - describe the connection to the inputs only, never what the user should enter or do"} with 3-4 items, most recent first.` }],
        }),
      });
      const data = await response.json();
      const text = data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      const items = (parsed.items || []).filter((it) => !violatesAdviceRules(`${it.title} ${it.note}`));
      const modelNote = parsed.modelNote && !violatesAdviceRules(parsed.modelNote) ? parsed.modelNote : null;
      if (!items.length) { setBriefErr("No usable coverage found. Retry."); }
      else setBriefData({ items, modelNote });
    } catch { setBriefErr("Brief unavailable. Retry."); }
    finally { setBriefLoading(false); }
  }

  const th = { ...label, fontSize: 9.5, textAlign: "left", padding: "9px 10px", borderBottom: `2px solid ${T.ruleDark}` };
  const thNum = { ...th, textAlign: "right" };
  const td = { padding: "8px 10px", borderBottom: `1px solid ${T.rule}`, fontSize: 13 };
  const numTd = (v) => ({ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", color: v < 0 ? T.red : T.ink });

  /* ═════════ CHECKOUT (demo) ═════════
     DEPLOY NOTE: replace this entire modal with Stripe Checkout
     (mode: subscription, trial_period_days: 14 for Advanced).
     Never collect raw card numbers in your own code in production — Stripe
     hosts the card fields so PCI compliance stays on their side. */
  const activatePlan = () => {
    setCkErr(null);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ckEmail.trim())) { setCkErr("Enter a valid email address."); return; }
    if (!luhnValid(ckCard)) { setCkErr("Card number doesn't check out — verify the digits."); return; }
    const m = ckExp.trim().match(/^(0[1-9]|1[0-2])\s*\/\s*(\d{2})$/);
    if (!m) { setCkErr("Expiry must be MM/YY."); return; }
    const expDate = new Date(2000 + parseInt(m[2], 10), parseInt(m[1], 10), 0);
    if (expDate < new Date()) { setCkErr("This card has expired."); return; }
    if (!/^\d{3,4}$/.test(ckCvc.trim())) { setCkErr("CVC must be 3–4 digits."); return; }
    const tier = showCheckout;
    if (tier === "advanced") {
      const ends = new Date(Date.now() + 14 * 24 * 3600 * 1000);
      setTrialEnds(ends.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    }
    ev("plan_activated", { tier: String(tier) });
    setPlan(tier);
    if (tier === "advanced") setMode("advanced");
    setShowCheckout(null); setView("app");
    setCkCard(""); setCkExp(""); setCkCvc("");
  };
  const ckField = { width: "100%", padding: "11px 13px", border: `1px solid ${T.ruleDark}`, borderRadius: T.radiusMd, fontFamily: T.mono, fontSize: 13.5, color: T.ink, background: T.surface, outline: "none", boxSizing: "border-box" };
  const Checkout = () => (
    <div onClick={() => setShowCheckout(null)} style={{ position: "fixed", inset: 0, background: "rgba(3,7,18,0.72)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: T.band, border: `1px solid ${T.rule}`, borderRadius: T.radius, boxShadow: T.shadow, maxWidth: 420, width: "100%", padding: 28 }}>
        <h2 style={{ fontFamily: T.disp, fontSize: 20, fontWeight: 800, margin: "0 0 4px", color: T.ink }}>
          Subscribe to Pro
        </h2>
        <p style={{ fontSize: 12.5, color: T.sub, margin: "0 0 18px", lineHeight: 1.55 }}>
          {PRO_PRICE_MO}, cancel anytime.
        </p>
        <div style={{ display: "grid", gap: 10 }}>
          <input placeholder="Email" value={ckEmail} onChange={(e) => setCkEmail(e.target.value)} style={ckField} />
          <input placeholder="Card number" inputMode="numeric" value={ckCard}
            onChange={(e) => setCkCard(e.target.value.replace(/[^\d ]/g, "").slice(0, 19))} style={ckField} />
          <div style={{ display: "flex", gap: 10 }}>
            <input placeholder="MM/YY" value={ckExp} onChange={(e) => setCkExp(e.target.value.slice(0, 5))} style={{ ...ckField, flex: 1 }} />
            <input placeholder="CVC" inputMode="numeric" value={ckCvc} onChange={(e) => setCkCvc(e.target.value.replace(/\D/g, "").slice(0, 4))} style={{ ...ckField, flex: 1 }} />
          </div>
        </div>
        {ckErr && <div style={{ fontSize: 12.5, color: T.red, marginTop: 10 }}>{ckErr}</div>}
        <div style={{ marginTop: 18 }}>
          <Btn primary wide pill onClick={activatePlan}>
            Subscribe — {PRO_PRICE_MO}
          </Btn>
        </div>
        <div style={{ fontSize: 10, color: T.faint, marginTop: 12, lineHeight: 1.5, textAlign: "center" }}>
          Secure checkout demo — replaced by Stripe Checkout in production. No card details are stored.
        </div>
      </div>
    </div>
  );

  /* ═════════ PAYWALL ═════════ */
  const Paywall = () => (
    <div onClick={() => setShowPaywall(false)} style={{ position: "fixed", inset: 0, background: "rgba(3,7,18,0.72)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: T.band, border: `1px solid ${T.rule}`, borderRadius: T.radius, boxShadow: T.shadow, maxWidth: 760, width: "100%" }}>
        <div style={{ padding: "28px 28px 24px" }}>
          <h2 style={{ fontFamily: T.disp, fontSize: 24, fontWeight: 800, margin: "0 0 6px", color: T.ink }}>Plans</h2>
          <p style={{ fontSize: 13, color: T.sub, margin: "0 0 22px" }}>Basic and Advanced are free. Pro adds the analytical extras.</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
            {[
              { name: "Basic", price: "$0", items: ["Plain-language check-up", "Risk & diversification read", "Dollar-based projection"], cta: "Included", act: () => { setPlan("free"); setMode("basic"); setShowPaywall(false); setView("app"); } },
              { name: "Advanced", price: "$0", items: ["Full optimizer & frontier", "Monte Carlo simulator", "Quantitative diagnostics"], cta: "Open toolkit", act: () => { setPlan(plan); setMode("advanced"); setShowPaywall(false); setView("app"); } },
              { name: "Pro", price: PRO_PRICE_MO, hi: true, items: ["AI observations", "Security news briefs", "Crisis stress lab", "Correlation lab", "Long-only solver"], cta: "Subscribe", act: () => { setShowPaywall(false); setShowCheckout("pro"); } },
            ].map((p, i) => (
              <div key={i} style={{
                padding: 20, borderRadius: T.radiusLg,
                background: p.hi ? `linear-gradient(160deg, rgba(16,185,129,0.14), ${T.band2})` : T.band2,
                border: `1px solid ${p.hi ? "rgba(16,185,129,0.4)" : T.rule}`,
              }}>
                <div style={{ fontFamily: T.disp, fontWeight: 800, fontSize: 16, color: p.hi ? T.green : T.ink }}>{p.name}</div>
                <div style={{ fontFamily: T.mono, fontVariantNumeric: "tabular-nums", fontSize: 24, fontWeight: 800, margin: "8px 0 2px", color: T.ink }}>{p.price}</div>
                <div style={{ fontSize: 10.5, color: T.green, fontWeight: 700, marginBottom: 10, minHeight: 14 }}>{p.sub || ""}</div>
                <div style={{ fontSize: 12, color: T.sub, lineHeight: 1.9, marginBottom: 16 }}>{p.items.map((x, k) => <div key={k}>· {x}</div>)}</div>
                <Btn small primary={p.hi} wide onClick={p.act}>{p.cta}</Btn>
                {(p.hi || p.sub) && <div style={{ fontSize: 10, color: T.faint, marginTop: 10 }}>Demo checkout — connect Stripe in production.</div>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  /* ═════════ LANDING ═════════ */
  const Landing = () => (
    <div>
      {/* hero */}
      <div style={{ position: "relative", overflow: "hidden" }}>
        <HeroArt />
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "96px 20px 72px", position: "relative", textAlign: "center" }}>
          <div style={{ display: "inline-block", ...label, color: T.green, marginBottom: 20, background: "rgba(16,185,129,0.10)", border: `1px solid rgba(16,185,129,0.28)`, borderRadius: T.pill, padding: "6px 16px" }}>
            Portfolio analytics · Three tiers · Two free
          </div>
          <h1 style={{ fontFamily: T.disp, fontSize: 54, fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1.06, margin: "0 auto 20px", maxWidth: 760, color: T.ink }}>
            Know exactly what your portfolio is doing.
          </h1>
          <p style={{ fontSize: 17, color: T.sub, maxWidth: 560, lineHeight: 1.65, margin: "0 auto 34px" }}>
            From a plain-language check-up anyone can read, to the same mean-variance mathematics used on institutional desks. Your assumptions in, honest analysis out.
          </p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
            <Btn primary pill onClick={() => { setMode("basic"); setView("app"); }}>Check my portfolio — free</Btn>
            <Btn pill onClick={() => { setMode("advanced"); setView("app"); }}>Open the full toolkit</Btn>
          </div>
        </div>
      </div>

      {/* live proof band */}
      {base && mc && (
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "0 20px 56px", position: "relative" }}>
          <StatRow cols="repeat(auto-fit, minmax(160px, 1fr))" items={[
            { l: "Max Sharpe solved · live", v: num(base.tan.sharpe) },
            { l: "Frontier points · live", v: chart ? String(chart.frontier.length) : "—" },
            { l: "Paths simulated", v: "500" },
            { l: "Median 10-yr outcome · live", v: money(mc.median) },
          ]} />
        </div>
      )}

      {/* tiers */}
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 20px 64px" }}>
        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <h2 style={{ fontFamily: T.disp, fontSize: 32, fontWeight: 800, margin: "0 0 10px", color: T.ink }}>Built for how much finance you know.</h2>
          <p style={{ fontSize: 14.5, color: T.sub, margin: "0 auto", maxWidth: 560 }}>Never used anything beyond a brokerage app? Start Basic. Comfortable with volatility and correlation? Advanced is the full desk. Both free.</p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 20 }}>
          {[
            { tier: "Basic", tag: "Free · plain language", d: "Type in what you own and what it's worth. Get a risk grade, a risk-mix breakdown, plain-English flags, and a dollar-figure projection that includes your monthly contributions — no jargon anywhere.", act: () => { setMode("basic"); setView("app"); }, cta: "Start here" },
            { tier: "Advanced", tag: "Free · full mathematics", d: "Tangency and minimum-variance portfolios solved in closed form, the efficient frontier, capital allocation line, Monte Carlo simulation, and six live diagnostics.", act: () => { setMode("advanced"); setView("app"); }, cta: "Open toolkit" },
            { tier: "Pro", tag: PRO_PRICE_MO + " · analytical extras", d: "Crisis stress testing, a fully editable correlation lab, long-only optimization, AI observations, and factual news briefs on any holding.", act: () => setShowPaywall(true), cta: "See Pro", hi: true },
          ].map((t, i) => (
            <div key={i} style={{
              padding: 28, borderRadius: T.radiusLg,
              background: t.hi ? `linear-gradient(160deg, rgba(16,185,129,0.14), ${T.band})` : T.band,
              border: `1px solid ${t.hi ? "rgba(16,185,129,0.4)" : T.rule}`,
              boxShadow: t.hi ? "0 1px 2px rgba(0,0,0,.3), 0 20px 44px -16px rgba(16,185,129,0.35)" : T.shadowSm,
            }}>
              <div style={{ fontFamily: T.disp, fontSize: 20, fontWeight: 800, color: t.hi ? T.green : T.ink }}>{t.tier}</div>
              <div style={{ ...label, fontSize: 9.5, margin: "6px 0 14px" }}>{t.tag}</div>
              <p style={{ fontSize: 13.5, color: T.sub, lineHeight: 1.65, margin: "0 0 20px" }}>{t.d}</p>
              <Btn small primary={t.hi} wide onClick={t.act}>{t.cta}</Btn>
            </div>
          ))}
        </div>
      </div>

      {/* final CTA */}
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 20px 72px" }}>
        <div style={{ textAlign: "center", padding: "48px 32px", borderRadius: T.radiusLg, background: `linear-gradient(160deg, rgba(16,185,129,0.12), ${T.band})`, border: `1px solid rgba(16,185,129,0.28)`, boxShadow: T.shadowSm }}>
          <h2 style={{ fontFamily: T.disp, fontSize: 28, fontWeight: 800, margin: "0 0 10px", color: T.ink }}>Sixty seconds to your first read.</h2>
          <p style={{ fontSize: 14, color: T.sub, margin: "0 0 24px" }}>No signup. No card. No jargon unless you ask for it.</p>
          <Btn primary pill onClick={() => { setMode("basic"); setView("app"); }}>Check my portfolio</Btn>
          <div style={{ fontSize: 10.5, color: T.faint, marginTop: 28, lineHeight: 1.6 }}>
            Analytical tool only. All outputs are descriptive model results based on user-supplied assumptions, and do not constitute investment advice or recommendations.
          </div>
        </div>
      </div>
    </div>
  );

  /* ═════════ BASIC MODE ═════════ */
  const BasicMode = () => (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "20px 16px 48px" }}>
      <Panel title="What do you own?">
        <p style={{ fontSize: 13, color: T.sub, margin: "0 0 14px", lineHeight: 1.6 }}>
          List your investments, roughly what each is worth, and how jumpy each one tends to be. Estimates are fine.
        </p>
        {bHoldings.map((h, i) => (
          <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "10px 0", borderBottom: `1px solid ${T.rule}` }}>
            <div style={{ flex: "1 1 130px", minWidth: 120 }}>
              <TickerInput value={h.name} width="100%" bold={false}
                onChange={(v) => setB(i, "name", v)}
                onSelect={(r) => setBHoldings(bHoldings.map((x, k) => (k === i ? { ...x, name: r.t, risk: riskFromVol(r.vol) } : x)))} />
            </div>
            <span style={{ fontSize: 13, color: T.sub }}>$</span>
            <Field value={h.amount} onChange={(v) => setB(i, "amount", v)} w={104} />
            <select value={h.risk} onChange={(e) => setB(i, "risk", e.target.value)}
              style={{ padding: "8px 10px", border: `1px solid ${T.ruleDark}`, borderRadius: T.radiusMd, fontFamily: T.ui, fontSize: 12.5, color: T.ink, background: T.surface }}>
              {Object.entries(RISK_PRESETS).map(([k, p]) => <option key={k} value={k}>{p.label} — {p.desc}</option>)}
            </select>
            <span onClick={() => rmB(i)} style={{ cursor: "pointer", color: T.faint, fontSize: 14, padding: "0 4px" }}>✕</span>
          </div>
        ))}
        <div style={{ marginTop: 12 }}>
          {bHoldings.length >= 10
            ? <span style={{ fontSize: 11.5, color: T.faint }}>10 holding maximum</span>
            : <Btn small onClick={addB}>+ Add another</Btn>}
        </div>
      </Panel>

      {!basic && (
        <div style={{ background: T.goldBg, border: `1px solid ${T.goldBorder}`, borderRadius: T.radiusMd, padding: "12px 16px", fontSize: 13, color: T.ink }}>
          Enter at least one holding with a value above $0 to see your portfolio read.
        </div>
      )}

      {basic && (
        <>
          <Panel title="Your portfolio at a glance" band>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 14, marginBottom: 16 }}>
              <div>
                <div style={{ ...label, fontSize: 9.5 }}>Total value</div>
                <div style={{ fontFamily: T.disp, fontSize: 26, fontWeight: 800, color: T.ink, fontVariantNumeric: "tabular-nums" }}>{money(basic.total)}</div>
              </div>
              <div>
                <div style={{ ...label, fontSize: 9.5 }}>Overall risk level</div>
                <div style={{ fontFamily: T.disp, fontSize: 26, fontWeight: 800, color: basic.riskBucket === "High" ? T.red : basic.riskBucket === "Elevated" ? T.copper : T.green }}>{basic.riskBucket}</div>
              </div>
              <div>
                <div style={{ ...label, fontSize: 9.5 }}>Spread of holdings</div>
                <div style={{ fontFamily: T.disp, fontSize: 26, fontWeight: 800, color: T.ink, fontVariantNumeric: "tabular-nums" }}>{basic.effN.toFixed(1)}<span style={{ fontSize: 13, color: T.sub, fontWeight: 600 }}> of {basic.count}</span></div>
              </div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ ...label, fontSize: 9.5, marginBottom: 6 }}>How the money is split by risk</div>
              <div style={{ display: "flex", height: 26, overflow: "hidden", borderRadius: T.pill, background: T.surface }}>
                {[["low", T.green, "Steady"], ["med", T.steel, "Balanced"], ["high", T.copper, "Aggressive"]].map(([k, c]) => (
                  basic.mix[k] > 0.001 && <div key={k} style={{ width: pct(basic.mix[k], 1), background: c }} />
                ))}
              </div>
              <div style={{ display: "flex", gap: 16, marginTop: 6, flexWrap: "wrap" }}>
                {[["low", T.green, "Steady"], ["med", T.steel, "Balanced"], ["high", T.copper, "Aggressive"]].map(([k, c, t]) => (
                  <span key={k} style={{ fontSize: 11.5, color: T.sub, display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{ width: 9, height: 9, background: c, display: "inline-block" }} />{t} {pct(basic.mix[k], 0)}
                  </span>
                ))}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16, alignItems: "center" }}>
              <ResponsiveContainer width="100%" height={190}>
                <PieChart>
                  <Pie data={bHoldings.filter((h) => h.amount > 0).map((h) => ({ name: h.name, value: h.amount }))}
                    dataKey="value" innerRadius={48} outerRadius={80} paddingAngle={2} stroke={T.paper} strokeWidth={2}>
                    {bHoldings.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v) => money(v)} contentStyle={{ background: T.band2, border: `1px solid ${T.ruleDark}`, borderRadius: T.radiusSm, boxShadow: T.shadowSm, padding: "8px 11px", fontSize: 12, color: T.ink }} />
                </PieChart>
              </ResponsiveContainer>
              <div>
                {basic.notes.map((t, i) => (
                  <div key={i} style={{ fontSize: 13, color: T.ink, lineHeight: 1.6, marginBottom: 10, paddingLeft: 12, borderLeft: `3px solid ${PALETTE[i % PALETTE.length]}` }}>{t}</div>
                ))}
              </div>
            </div>
          </Panel>

          <Panel title={`Where could this land in ${bYears} years?`}
            right={
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <label style={{ fontSize: 12, color: T.sub, display: "flex", gap: 6, alignItems: "center" }}>
                  Adding $<Field value={bMonthly} onChange={(v) => setBMonthly(Math.max(0, v))} w={80} />/mo
                </label>
                <label style={{ fontSize: 12, color: T.sub, display: "flex", gap: 6, alignItems: "center" }}>
                  Years <Field value={bYears} onChange={(v) => setBYears(Math.max(1, Math.min(40, Math.round(v))))} w={56} />
                </label>
              </div>
            }>
            <p style={{ fontSize: 13, color: T.sub, margin: "0 0 12px", lineHeight: 1.6 }}>
              We ran 400 possible futures for this exact mix, including anything you add monthly. Half landed above the middle line, half below. The shaded area covers the likely range — not a guarantee, a range.
            </p>
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={basic.sim.series} margin={{ top: 6, right: 12, bottom: 4, left: 6 }}>
                <defs>
                  <linearGradient id="bband" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={T.green} stopOpacity={0.22} />
                    <stop offset="100%" stopColor={T.green} stopOpacity={0.03} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={T.rule} />
                <XAxis dataKey="year" tick={{ fontSize: 11, fill: T.sub }} stroke={T.ruleDark} />
                <YAxis tick={{ fontSize: 11, fill: T.sub }} stroke={T.ruleDark} tickFormatter={(v) => "$" + (v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : Math.round(v / 1000) + "k")} />
                <Tooltip formatter={(v, name2) => [money(v), { p5: "Rough year (5th pct)", p50: "Middle outcome", p95: "Strong year (95th pct)" }[name2] || name2]} contentStyle={{ background: T.band2, border: `1px solid ${T.ruleDark}`, borderRadius: T.radiusSm, boxShadow: T.shadowSm, padding: "8px 11px", fontSize: 12, color: T.ink }} />
                <Area type="monotone" dataKey="p95" stroke="none" fill="url(#bband)" />
                <Area type="monotone" dataKey="p50" stroke={T.green} strokeWidth={2.4} fill="none" />
                <Area type="monotone" dataKey="p5" stroke={T.copper} strokeWidth={1.4} strokeDasharray="5 4" fill="none" />
              </AreaChart>
            </ResponsiveContainer>
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginTop: 10 }}>
              {[
                { l: "Middle outcome", v: money(basic.sim.median), c: T.green },
                { l: "If things go badly", v: money(basic.sim.p5), c: T.copper },
                { l: "If things go well", v: money(basic.sim.p95), c: T.steel },
                { l: "Total you'd put in", v: money(basic.sim.contributed), c: T.sub },
                { l: "Chance of ending below what you put in", v: pct(basic.sim.probLoss, 0), c: T.ink },
              ].map((k, i) => (
                <div key={i}>
                  <div style={{ ...label, fontSize: 9 }}>{k.l}</div>
                  <div style={{ fontFamily: T.disp, fontSize: 18, fontWeight: 800, color: k.c, fontVariantNumeric: "tabular-nums" }}>{k.v}</div>
                </div>
              ))}
            </div>
          </Panel>

          <div style={{ textAlign: "center", padding: "8px 0 0" }}>
            <span style={{ fontSize: 12.5, color: T.sub }}>Comfortable with more depth? </span>
            <span onClick={() => setMode("advanced")} style={{ fontSize: 12.5, fontWeight: 700, color: T.green, cursor: "pointer", textDecoration: "underline" }}>Switch to Advanced</span>
          </div>
        </>
      )}
      <div style={{ fontSize: 10.5, color: T.faint, marginTop: 24, lineHeight: 1.6 }}>
        Estimates use broad risk categories and simplified assumptions. Descriptive model output only — not investment advice.
      </div>
    </div>
  );

  /* ═════════ ADVANCED MODE ═════════ */
  const AdvancedMode = () => (
    <div style={{ maxWidth: 1500, margin: "0 auto", padding: "16px 16px 48px" }}>
      <div style={{ background: T.band, border: `1px solid ${T.rule}`, borderRadius: T.radiusLg, boxShadow: T.shadowSm, padding: "14px 18px", marginBottom: 16, display: "flex", flexWrap: "wrap", gap: 18, alignItems: "center" }}>
        <label style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 8, color: T.sub }}>
          Risk-free <Field value={rf} onChange={setRf} w={52} /> %
        </label>
        <label style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 8, color: T.sub }}>
          Risk aversion
          <input type="range" min={1} max={10} step={0.5} value={A} onChange={(e) => setA(parseFloat(e.target.value))} />
          <span style={{ color: T.ink, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{A.toFixed(1)}</span>
        </label>
        <label style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 8, color: T.sub }}>
          <input type="checkbox" checked={longOnly} onChange={(e) => { setLongOnly(e.target.checked); }} />
          Long-only {!isPro && <span style={{ fontSize: 9, fontWeight: 700, color: T.green }}>PRO</span>}
        </label>
        <button onClick={applyInputs} disabled={!dirty} style={{
          fontFamily: T.ui, fontSize: 12.5, fontWeight: 700, padding: "8px 18px", borderRadius: T.pill,
          cursor: dirty ? "pointer" : "default",
          border: dirty ? "none" : `1.5px solid ${T.rule}`,
          background: dirty ? `linear-gradient(180deg, ${T.greenLight}, ${T.green})` : "transparent",
          color: dirty ? "#04140D" : T.faint,
          boxShadow: dirty ? "0 4px 14px -4px rgba(16,185,129,0.55)" : "none",
        }}>{dirty ? "Update model ↻" : "Up to date"}</button>
        <div style={{ display: "flex", gap: 2, marginLeft: "auto", background: T.surface, borderRadius: T.pill, padding: 3 }}>
          {Object.entries(SCENARIOS).map(([k, s]) => (
            <button key={k}
              onClick={() => { if (k !== "base" && !isPro) { setShowPaywall(true); return; } setScenario(k); }}
              style={{ fontFamily: T.ui, fontSize: 11.5, fontWeight: 700, padding: "7px 14px", cursor: "pointer", border: "none", borderRadius: T.pill, background: scenario === k ? T.green : "transparent", color: scenario === k ? "#04140D" : T.sub }}>
              {s.name}
            </button>
          ))}
        </div>
      </div>

      {scen && base && (
        <div style={{ background: T.goldBg, border: `1px solid ${T.goldBorder}`, borderRadius: T.radiusMd, padding: "12px 16px", marginBottom: 16, fontSize: 12.5, color: T.ink, display: "flex", gap: 20, flexWrap: "wrap" }}>
          <span style={{ ...label, color: T.copper }}>{SCENARIOS[scenario].name} vs base</span>
          <span>E[r]: {pct(base.tan.ret)} → <b style={{ color: scen.tan.ret < base.tan.ret ? T.red : T.green }}>{pct(scen.tan.ret)}</b></span>
          <span>σ: {pct(base.tan.sigma)} → <b style={{ color: scen.tan.sigma > base.tan.sigma ? T.red : T.green }}>{pct(scen.tan.sigma)}</b></span>
          <span>Sharpe: {num(base.tan.sharpe)} → <b style={{ color: scen.tan.sharpe < base.tan.sharpe ? T.red : T.green }}>{num(scen.tan.sharpe)}</b></span>
        </div>
      )}

      <div style={{ background: `linear-gradient(160deg, rgba(16,185,129,0.10), ${T.band})`, border: `1px solid rgba(16,185,129,0.28)`, borderRadius: T.radiusLg, padding: "14px 18px", marginBottom: 16 }}>
        <div style={{ ...label, color: T.green, marginBottom: 6 }}>Three steps</div>
        <div style={{ fontSize: 12.5, color: T.sub, lineHeight: 1.7 }}>
          <b style={{ color: T.ink }}>1.</b> Add your holdings below and press <b style={{ color: T.ink }}>Fetch real σ &amp; ρ</b> to pull live risk data. &nbsp;
          <b style={{ color: T.ink }}>2.</b> Review the <b style={{ color: T.ink }}>E[r]</b> figures CAPM produced and override any you disagree with. &nbsp;
          <b style={{ color: T.ink }}>3.</b> Read the solved allocation and the checks underneath it. New to this? The <b style={{ color: T.ink }}>Basic</b> tab does the same thing in plain language.
        </div>
      </div>
      <Panel title="Capital market assumptions & solved weights"
        right={
          n >= 30
            ? <span style={{ fontSize: 11.5, color: T.faint }}>30 asset maximum</span>
            : <span style={{ display: "flex", gap: 8 }}><Btn small primary onClick={fetchMarketData}>{mktLoading ? "Fetching…" : "Fetch market data"}</Btn><Btn small onClick={addAsset}>+ Add asset</Btn></span>
        }>
            <Hint>Enter what you own. Type any ticker or company name and pick it from the list. <b>E[r]</b> is the expected yearly return, <b>σ</b> is how much it swings. Press <b>Fetch market data</b> to compute all three inputs from a year of real prices: σ and correlations directly, and E[r] via CAPM (risk-free rate + beta × 5.5% market premium). Every figure stays editable if you disagree with it.</Hint>
        {mktNote && (
          <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: T.radiusSm, padding: "10px 14px", marginBottom: 12, fontSize: 12, color: T.sub }}>{mktNote}</div>
        )}
        {!base && (
          <div style={{ background: T.goldBg, border: `1px solid ${T.goldBorder}`, borderRadius: T.radiusMd, padding: "11px 14px", marginBottom: 12, fontSize: 12.5, color: T.ink }}>
            The model can't solve with these inputs. This usually means every expected return sits at or below the risk-free rate, so no risky portfolio beats cash. It can also mean a volatility of zero, or a correlation matrix that is internally inconsistent — extreme combinations (e.g. A–B at 0.9, A–C at 0.9, B–C at −0.9) have no valid covariance.
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16, alignItems: "start" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 400 }}>
              <thead><tr>
                <th style={th}>Security</th><th style={thNum}>You hold $</th><th style={thNum}>E[r]%</th><th style={thNum}>σ%</th>
                <th style={thNum}>Tangency</th><th style={thNum}>Min-var</th><th style={{ ...th, width: 26 }}></th>
              </tr></thead>
              <tbody>
                {assets.map((a, i) => (
                  <tr key={i}>
                    <td style={td}>
                      <span style={{ width: 8, height: 8, background: PALETTE[i % PALETTE.length], display: "inline-block", marginRight: 8 }} />
                      <TickerInput value={a.name} width={112}
                        onChange={(v) => setAsset(i, "name", v.toUpperCase())}
                        onSelect={(r) => setAssets(assets.map((x, k) => (k === i ? { ...x, name: r.t, er: typeof r.beta === "number" ? Math.round((rf + r.beta * 5.5) * 10) / 10 : erFromVol(r.vol), sigma: r.vol } : x)))} />
                    </td>
                    <td style={{ ...td, textAlign: "right" }}><Field value={a.amount == null ? 0 : a.amount} onChange={(v) => setAsset(i, "amount", v)} w={100} /></td>
<td style={{ ...td, textAlign: "right" }}><Field value={a.er} onChange={(v) => setAsset(i, "er", v)} w={50} /></td>
                    <td style={{ ...td, textAlign: "right" }}><Field value={a.sigma} onChange={(v) => setAsset(i, "sigma", v)} w={50} /></td>
                    <td style={{ ...numTd(base ? base.tan.w[i] : 0), fontWeight: 700 }}>{base ? pct(base.tan.w[i]) : "—"}</td>
                    <td style={numTd(base ? base.minv.w[i] : 0)}>{base ? pct(base.minv.w[i]) : "—"}</td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>
                      <span onClick={() => runBrief(a.name)} title={isPro ? "Recent coverage" : "Pro feature"}
                        style={{ cursor: "pointer", color: T.steel, fontSize: 11, fontWeight: 700, marginRight: 10 }}>NEWS</span>
                      <span onClick={() => { if (window.confirm('Remove this holding?')) removeAsset(i); }} style={{ cursor: "pointer", color: T.faint }}>✕</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {base && (
            <div style={{ textAlign: "center" }}>
              <ResponsiveContainer width="100%" height={190}>
                <PieChart>
                  <Pie data={assets.map((a, i) => ({ name: a.name, value: Math.max(0, base.tan.w[i]) }))}
                    dataKey="value" innerRadius={48} outerRadius={80} paddingAngle={2} stroke={T.paper} strokeWidth={2}>
                    {assets.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v) => pct(v)} contentStyle={{ background: T.band2, border: `1px solid ${T.ruleDark}`, borderRadius: T.radiusSm, boxShadow: T.shadowSm, padding: "8px 11px", fontSize: 12, color: T.ink }} />
                </PieChart>
              </ResponsiveContainer>
              <div style={{ ...label, fontSize: 9 }}>Tangency allocation (long weights)</div>
            </div>
          )}
        </div>
      </Panel>

      {base && chart && (
        <>
          <StatRow items={[
            { l: "Tangency E[r]", v: pct(base.tan.ret) },
            { l: "Tangency σ", v: pct(base.tan.sigma) },
            { l: "Sharpe", v: num(base.tan.sharpe) },
            { l: "Min-var σ", v: pct(base.minv.sigma) },
            { l: `y* (A=${A})`, v: pct(chart.yStar, 0) },
          ]} />

          <Panel title="Your portfolio vs the optimum">
            {!current ? (<div style={{ fontSize: 12.5, color: T.faint }}>Enter dollar amounts in the You hold $ column above to compare your actual portfolio against the optimum.</div>) : (
              <div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
                  {[{ l: "Expected return", a: pct(current.ret), b: pct(base.tan.ret) }, { l: "Volatility", a: pct(current.sigma), b: pct(base.tan.sigma) }, { l: "Sharpe ratio", a: num(current.sharpe), b: num(base.tan.sharpe) }].map((k, i) => (
                    <div key={i} style={{ padding: "12px 14px", background: T.surface, borderRadius: T.radiusMd }}>
                      <div style={{ ...label, fontSize: 9, marginBottom: 6 }}>{k.l}</div>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                        <span style={{ fontFamily: T.mono, fontSize: 16, color: T.sub }}>{k.a}</span>
                        <span style={{ color: T.faint }}>to</span>
                        <span style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 700, color: T.green }}>{k.b}</span>
                      </div>
                    </div>))}
                </div>
                <div style={{ background: `linear-gradient(160deg, rgba(16,185,129,0.10), ${T.band2})`, border: `1px solid rgba(16,185,129,0.28)`, borderRadius: T.radiusMd, padding: "11px 16px", marginTop: 12, fontSize: 12.5, color: T.ink }}>
                  Your {money(current.tot)} portfolio scores a Sharpe of {num(current.sharpe)} against the model optimum of {num(base.tan.sharpe)}.
                </div>
              </div>)}
          </Panel>

          <Panel title="Solved allocation">
            <Hint>The mix with the best return-per-unit-of-risk given your inputs above. Change an input and these update instantly.</Hint>
            <div style={{ fontSize: 12.5, color: T.sub, marginBottom: 14 }}>
              Maximum-Sharpe (tangency) weights from your assumptions, shown against a portfolio value of {money(Math.max(1, mcStart))} — change that figure in the Monte Carlo panel below.
            </div>
            {assets.map((a, i) => {
              const w = base.tan.w[i];
              const maxW = Math.max.apply(null, base.tan.w.map(function (x) { return Math.abs(x); }));
              const barW = maxW > 0 ? (Math.abs(w) / maxW) * 100 : 0;
              return (
                <div key={i} style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 5 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>{a.name}</span>
                    <span>
                      <span style={{ fontFamily: T.mono, fontSize: 17, fontWeight: 700, color: w < 0 ? T.red : T.green }}>{pct(w)}</span>
                      <span style={{ fontFamily: T.mono, fontSize: 13, color: T.sub, marginLeft: 10 }}>{money(w * Math.max(1, mcStart))}</span>
                    </span>
                  </div>
                  <div style={{ height: 14, background: T.surface, borderRadius: T.pill, overflow: "hidden" }}>
                    <div style={{ width: barW + "%", height: "100%", borderRadius: T.pill, background: w < 0 ? T.red : PALETTE[i % PALETTE.length] }} />
                  </div>
                </div>
              );
            })}
            <div style={{ fontSize: 11, color: T.faint, marginTop: 4 }}>
              Negative weights shown in red are short positions, which the long-only constraint removes.
            </div>
          </Panel>

          <Panel title="Efficient frontier · Where you sit">
            <Hint>Every dot is a possible portfolio: risk across the bottom, expected return up the side. The curve is the best return available at each level of risk. Your portfolio is marked in pink; drag the slider below to pick any point on the curve and see which weights differ.</Hint>
            <ResponsiveContainer width="100%" height={330}>
              <ComposedChart margin={{ top: 8, right: 16, bottom: 6, left: -6 }}>
                <CartesianGrid stroke={T.rule} />
                <XAxis type="number" dataKey="x" unit="%" domain={[0, "auto"]} tick={{ fontSize: 11, fill: T.sub }} stroke={T.ruleDark} />
                <YAxis type="number" dataKey="y" unit="%" tick={{ fontSize: 11, fill: T.sub }} stroke={T.ruleDark} />
                <Tooltip formatter={(v) => `${Number(v).toFixed(2)}%`} contentStyle={{ background: T.band2, border: `1px solid ${T.ruleDark}`, borderRadius: T.radiusSm, boxShadow: T.shadowSm, padding: "8px 11px", fontSize: 12, color: T.ink }} />
                <Scatter data={chart.frontier} fill={T.green} line={{ stroke: T.green, strokeWidth: 2 }} shape={() => null} />
                <Scatter data={chart.cal} fill={T.steel} line={{ stroke: T.steel, strokeWidth: 1.3, strokeDasharray: "5 4" }} shape={() => null} />
                <Scatter data={chart.assetPts} fill={T.faint} />
                <Scatter data={[{ x: base.minv.sigma * 100, y: base.minv.ret * 100 }]} fill={T.copper} />
                <Scatter data={[{ x: chart.complete.sigma * 100, y: chart.complete.ret * 100 }]} fill={T.ink} />
                {/* the move: dashed connector from where you are to the selected point */}
                {current && target && (
                  <Scatter
                    data={[
                      { x: current.sigma * 100, y: current.ret * 100 },
                      { x: target.sigma * 100, y: target.ret * 100 },
                    ]}
                    fill="none"
                    line={{ stroke: T.sub, strokeWidth: 1.2, strokeDasharray: "3 4" }}
                    shape={() => null}
                  />
                )}
                {/* selected target — emphasised */}
                {target && (
                  <Scatter data={[{ x: target.sigma * 100, y: target.ret * 100 }]} fill={T.green} shape={haloDot(T.green, 8)} />
                )}
                {/* your actual portfolio — emphasised */}
                {current && (
                  <Scatter data={[{ x: current.sigma * 100, y: current.ret * 100 }]} fill={T.pink} shape={haloDot(T.pink, 8)} />
                )}
              </ComposedChart>
            </ResponsiveContainer>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 6 }}>
              {[
                ...(current ? [{ c: T.pink, t: "Your portfolio", big: true }] : []),
                { c: T.green, t: "Selected point on frontier", big: true },
                { c: T.green, t: "Frontier" },
                { c: T.steel, t: "CAL" },
                { c: T.copper, t: "Min-variance" },
                { c: T.ink, t: "Complete portfolio" },
                { c: T.faint, t: "Assets" },
              ].map((k, i) => (
                <span key={i} style={{ fontSize: 11, color: k.big ? T.ink : T.sub, fontWeight: k.big ? 700 : 400, display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: k.big ? 11 : 9, height: k.big ? 11 : 9, borderRadius: "50%", background: k.c, display: "inline-block", boxShadow: k.big ? `0 0 0 3px ${k.c}33` : "none" }} />{k.t}
                </span>
              ))}
            </div>

            {!current && (
              <div style={{ background: T.goldBg, border: `1px solid ${T.goldBorder}`, borderRadius: T.radiusMd, padding: "11px 14px", marginTop: 16, fontSize: 12.5, color: T.ink }}>
                Enter dollar amounts in the <b>You hold $</b> column above to plot your own portfolio on this chart and see how its weights differ from any point on the curve.
              </div>
            )}

            {/* ---- frontier position selector ---- */}
            {target && (
              <div style={{ marginTop: 20, borderTop: `1px solid ${T.rule}`, paddingTop: 18 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
                  <span style={{ ...label, color: T.ink }}>Pick a point on the frontier</span>
                  <span style={{ display: "flex", gap: 6 }}>
                    <Btn small onClick={() => setFrontierT(0)}>Min risk</Btn>
                    <Btn small onClick={() => setFrontierT(1)}>Max Sharpe</Btn>
                  </span>
                </div>
                <input type="range" min={tBounds[0]} max={tBounds[1]} step={0.01} value={tClamped}
                  onChange={(e) => setFrontierT(parseFloat(e.target.value))}
                  style={{ width: "100%", accentColor: T.green }} />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: T.faint, marginBottom: 16 }}>
                  <span>Lower risk · minimum variance</span>
                  <span>Higher risk / return{!longOnly ? " · leveraged" : ""}</span>
                </div>

                <StatRow cols="repeat(auto-fit, minmax(130px, 1fr))" items={[
                  { l: "Selected E[r]", v: pct(target.ret), c: T.green },
                  { l: "Selected σ", v: pct(target.sigma), c: T.green },
                  { l: "Selected Sharpe", v: num(target.sharpe), c: T.green },
                  ...(current ? [
                    { l: "Your E[r] → change", v: pct(target.ret - current.ret), c: target.ret >= current.ret ? T.green : T.red },
                    { l: "Your σ → change", v: pct(target.sigma - current.sigma), c: target.sigma <= current.sigma ? T.green : T.red },
                  ] : []),
                ]} />

                {target.deltas && (
                  <>
                    <div style={{ ...label, color: T.ink, marginBottom: 10 }}>Weight differences vs what you hold</div>
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 460 }}>
                        <thead><tr>
                          <th style={th}>Security</th>
                          <th style={thNum}>You hold</th>
                          <th style={thNum}>Selected</th>
                          <th style={thNum}>Difference</th>
                          <th style={thNum}>In dollars</th>
                          <th style={{ ...th, width: 130 }}></th>
                        </tr></thead>
                        <tbody>
                          {target.deltas.map((d) => {
                            const maxAbs = Math.max.apply(null, target.deltas.map((x) => Math.abs(x.dw))) || 1;
                            const barPct = (Math.abs(d.dw) / maxAbs) * 50; // half-width each side
                            const up = d.dw >= 0;
                            return (
                              <tr key={d.i}>
                                <td style={{ ...td, whiteSpace: "nowrap" }}>
                                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: PALETTE[d.i % PALETTE.length], display: "inline-block", marginRight: 8 }} />
                                  {assets[d.i] ? assets[d.i].name : "—"}
                                </td>
                                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", color: T.sub }}>{pct(d.from)}</td>
                                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{pct(d.to)}</td>
                                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700, color: Math.abs(d.dw) < 0.0005 ? T.faint : up ? T.green : T.red }}>
                                  {Math.abs(d.dw) < 0.0005 ? "—" : (up ? "+" : "") + (d.dw * 100).toFixed(1) + "pp"}
                                </td>
                                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", color: Math.abs(d.dollars) < 1 ? T.faint : up ? T.green : T.red }}>
                                  {Math.abs(d.dollars) < 1 ? "—" : (up ? "+" : "−") + money(Math.abs(d.dollars))}
                                </td>
                                <td style={{ ...td, padding: "8px 10px" }}>
                                  {/* diverging bar, centred: left = lower weight, right = higher */}
                                  <div style={{ position: "relative", height: 8, background: T.surface, borderRadius: T.pill }}>
                                    <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: T.ruleDark }} />
                                    <div style={{
                                      position: "absolute", top: 0, bottom: 0, borderRadius: T.pill,
                                      background: up ? T.green : T.red,
                                      left: up ? "50%" : `${50 - barPct}%`,
                                      width: `${barPct}%`,
                                    }} />
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div style={{ fontSize: 11, color: T.faint, marginTop: 10, lineHeight: 1.6 }}>
                      A descriptive comparison of two weightings at a fixed portfolio value of {money(current.tot)} — it shows how the
                      two allocations differ, not a recommendation to transact. Dollar figures ignore trading costs, taxes, and
                      minimum lot sizes.
                    </div>
                  </>
                )}
              </div>
            )}
          </Panel>

          <Panel title="Monte Carlo wealth simulation · 500 paths"
            right={
              <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                <label style={{ fontSize: 11.5, color: T.sub, display: "flex", gap: 5, alignItems: "center" }}><span style={{ minWidth: 52 }}>Start $</span><Field value={mcStart} onChange={setMcStart} w={104} /></label>
                <label style={{ fontSize: 11.5, color: T.sub, display: "flex", gap: 5, alignItems: "center" }}><span style={{ minWidth: 38 }}>Years</span><Field value={mcYears} onChange={(v) => setMcYears(Math.max(1, Math.min(40, Math.round(v))))} w={84} /></label>
                <Btn small onClick={() => setMcSeed(mcSeed + 1)}>Re-run</Btn>
              </div>
            }>
            <Hint>Runs 500 possible futures for this portfolio. The middle line is the typical outcome; the shaded band is the likely range. Not a prediction, a range.</Hint>
            {mc && (
              <>
                <ResponsiveContainer width="100%" height={270}>
                  <AreaChart data={mc.series} margin={{ top: 6, right: 12, bottom: 4, left: 6 }}>
                    <defs>
                      <linearGradient id="aband" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={T.green} stopOpacity={0.2} />
                        <stop offset="100%" stopColor={T.green} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke={T.rule} />
                    <XAxis dataKey="year" tick={{ fontSize: 11, fill: T.sub }} stroke={T.ruleDark} />
                    <YAxis tick={{ fontSize: 11, fill: T.sub }} stroke={T.ruleDark} tickFormatter={(v) => "$" + (v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : Math.round(v / 1000) + "k")} />
                    <Tooltip formatter={(v, name2) => [money(v), { p5: "5th pct", p25: "25th pct", p50: "Median", p75: "75th pct", p95: "95th pct" }[name2] || name2]} contentStyle={{ background: T.band2, border: `1px solid ${T.ruleDark}`, borderRadius: T.radiusSm, boxShadow: T.shadowSm, padding: "8px 11px", fontSize: 12, color: T.ink }} />
                    <Area type="monotone" dataKey="p95" stroke="none" fill="url(#aband)" />
                    <Area type="monotone" dataKey="p75" stroke="none" fill="url(#aband)" />
                    <Area type="monotone" dataKey="p50" stroke={T.green} strokeWidth={2.2} fill="none" />
                    <Area type="monotone" dataKey="p25" stroke={T.faint} strokeWidth={1} strokeDasharray="4 3" fill="none" />
                    <Area type="monotone" dataKey="p5" stroke={T.red} strokeWidth={1.2} strokeDasharray="4 3" fill="none" />
                  </AreaChart>
                </ResponsiveContainer>
                <div style={{ display: "flex", gap: 22, flexWrap: "wrap", marginTop: 8 }}>
                  {[
                    { l: "Median", v: money(mc.median), c: T.green },
                    { l: "5th percentile", v: money(mc.p5), c: T.red },
                    { l: "95th percentile", v: money(mc.p95), c: T.steel },
                    { l: "P(below start)", v: pct(mc.probLoss, 0), c: T.ink },
                  ].map((k, i) => (
                    <div key={i}>
                      <div style={{ ...label, fontSize: 9 }}>{k.l}</div>
                      <div style={{ fontFamily: T.disp, fontSize: 17, fontWeight: 800, color: k.c, fontVariantNumeric: "tabular-nums" }}>{k.v}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Panel>

          {/* ═════════ VALUATION LAB (Pro) ═════════ */}
          <Panel title={`Valuation lab · DCF and multiples${!isPro ? " · Pro" : ""}`}
            right={!isPro && <Btn small primary onClick={() => setShowPaywall(true)}>Unlock</Btn>}>
            <Hint>Pulls a company's reported financial statements and builds a discounted cash-flow model from them — levered and unlevered — alongside the usual trading multiples. Every assumption starts from that company's own history and every one of them is editable.</Hint>
            {!isPro ? (
              <div style={{ fontSize: 13, color: T.faint }}>
                Reported income statement, balance sheet and cash-flow data for any listed company, a full DCF (FCFF and FCFE) with an editable assumption set, a WACC × terminal-growth sensitivity grid, a reverse DCF, and ten valuation multiples.
              </div>
            ) : (
              <>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 16 }}>
                  <TickerInput
                    value={valSym}
                    onChange={setValSym}
                    onSelect={(r) => { setValSym(r.t); loadValuation(r.t); }}
                    width={220}
                  />
                  <Btn small primary onClick={() => loadValuation(valSym)} disabled={valLoading || !valSym.trim()}>
                    {valLoading ? "Pulling filings…" : "Value it"}
                  </Btn>
                  {valData && val && (
                    <span style={{ fontSize: 12, color: T.sub }}>
                      {valData.name} · {valData.currency} {num(valData.price)} · {(val.q.sector || "—")}
                    </span>
                  )}
                </div>

                {valErr && (
                  <div style={{ background: T.goldBg, border: `1px solid ${T.goldBorder}`, borderRadius: T.radiusMd, padding: "12px 14px", fontSize: 12.5, color: T.copper, marginBottom: 14 }}>
                    {valErr}
                  </div>
                )}

                {!valData && !valLoading && !valErr && (
                  <div style={{ fontSize: 13, color: T.faint }}>Search a company above to pull its filings and build the model.</div>
                )}

                {val && (
                  <>
                    {/* ── suitability gate ── */}
                    {!val.suit.ok && (
                      <div style={{ background: T.goldBg, border: `1px solid ${T.goldBorder}`, borderRadius: T.radiusMd, padding: "13px 15px", fontSize: 12.5, color: T.copper, marginBottom: 18, lineHeight: 1.6 }}>
                        <strong style={{ display: "block", marginBottom: 4 }}>No DCF for this one.</strong>
                        {val.suit.why}
                      </div>
                    )}

                    {/* ── headline result ── */}
                    {val.dcf && (() => {
                      const psU = val.dcf.perShareU, psL = val.dcf.perShareL, p = val.price;
                      const up = isFinite(psU) && isFinite(p) ? psU / p - 1 : NaN;
                      const cur = valData.currency + " ";
                      return (
                        <StatRow items={[
                          { l: "Market price", v: cur + num(p), c: T.pink },
                          { l: "Unlevered DCF (FCFF)", v: isFinite(psU) ? cur + num(psU) : "—", c: T.green },
                          { l: "Levered DCF (FCFE)", v: isFinite(psL) ? cur + num(psL) : "—", c: T.greenLight },
                          { l: "Gap to price", v: isFinite(up) ? (up >= 0 ? "+" : "") + (up * 100).toFixed(0) + "%" : "—", c: up >= 0 ? T.green : T.red },
                        ]} />
                      );
                    })()}

                    {/* ── assumptions ── */}
                    {val.suit.ok && (
                      <>
                        <div style={{ ...label, fontSize: 10, color: T.ink, marginBottom: 8 }}>Assumptions — drawn from reported history, all editable</div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10, marginBottom: 8 }}>
                          {[
                            { k: "growth", l: "Revenue growth, yr 1", pct: true },
                            { k: "tg", l: "Terminal growth", pct: true },
                            { k: "years", l: "Explicit period (years)", pct: false, int: true },
                            { k: "ebitMargin", l: "Operating (EBIT) margin", pct: true },
                            { k: "taxRate", l: "Tax rate", pct: true },
                            { k: "daPct", l: "D&A, % of revenue", pct: true },
                            { k: "capexPct", l: "Capex, % of revenue", pct: true },
                            { k: "nwcPct", l: "Working capital, % of revenue", pct: true },
                            { k: "wacc", l: "WACC (discount rate)", pct: true },
                            { k: "ke", l: "Cost of equity", pct: true },
                          ].map(({ k, l, pct: isP, int }) => {
                            const shown = int ? val.asm[k] : Math.round(val.asm[k] * 1000) / 10;
                            const edited = valOv[k] != null;
                            return (
                              <div key={k} style={{ background: T.band, border: `1px solid ${edited ? T.goldBorder : T.rule}`, borderRadius: T.radiusMd, padding: "10px 12px" }}>
                                <div style={{ ...label, fontSize: 9, marginBottom: 6 }}>{l}</div>
                                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                  <Field
                                    value={shown}
                                    w={72}
                                    onChange={(v2) => setValOv({ ...valOv, [k]: int ? Math.max(1, Math.min(15, Math.round(v2))) : v2 / 100 })}
                                  />
                                  {isP && <span style={{ fontSize: 12, color: T.faint }}>%</span>}
                                  {edited && (
                                    <button onClick={() => { const n2 = { ...valOv }; delete n2[k]; setValOv(n2); }}
                                      style={{ marginLeft: "auto", background: "none", border: "none", color: T.faint, fontSize: 10, cursor: "pointer", textDecoration: "underline" }}>reset</button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        <div style={{ fontSize: 11.5, color: T.faint, marginBottom: 12, lineHeight: 1.6 }}>
                          Growth fades in a straight line from year 1 to the terminal rate. Working capital is applied to the <em>change</em> in revenue, so a negative figure means growth releases cash. WACC blends a CAPM cost of equity (β {num(val.asm.beta)} against a 5.5% market risk premium and your {num(rf, 1)}% risk-free rate) with an after-tax cost of debt of {(val.asm.kd * 100).toFixed(2)}% taken from interest actually paid.
                        </div>

                        {/* ── how the defaults were arrived at, and where they were overridden ── */}
                        {(() => {
                          const d0 = val.defs, notes = [];
                          notes.push(`Growth default is the middle of three measures, so no single distorted year drives it — reported CAGR ${pct(d0.growthCagr)}, latest year-over-year ${pct(d0.growthYoyLatest)}, median year-over-year ${pct(d0.growthYoyMedian)}.`);
                          if (d0.measuresDisagree) notes.push(`Those three measures span ${pct(d0.spread)}, so growth has not been steady — the starting year matters a great deal here and this default deserves a second look.`);
                          if (d0.growthClamped) notes.push(`That figure was capped into a −15% to +45% band before use; the raw measure was ${pct(d0.growthCagr)}. Nothing is underwritten at triple-digit growth in perpetuity.`);
                          if (d0.periods <= 4) notes.push(`Only ${d0.periods} annual periods are published through this feed, so every trend here rests on ${d0.periods - 1} year-over-year observations. Treat the growth default as a starting point, not a forecast.`);
                          if (d0.taxImplausible) notes.push(`The effective tax rate in the filings works out to ${isFinite(d0.effTax) ? pct(d0.effTax) : "an unusable figure"} — distorted by one-off credits or losses — so the 21% statutory rate was used instead.`);
                          if (Math.abs(d0.betaRaw - d0.beta) > 0.02) notes.push(`Beta was adjusted from a raw ${num(d0.betaRaw)} to ${num(d0.beta)} using the standard two-thirds/one-third pull toward 1.0, since trailing betas are noisy and mean-revert.`);
                          if (d0.keFloored) notes.push(`CAPM returned a ${pct(d0.keRaw)} cost of equity off that beta, which is too close to the risk-free rate to discount equity with. It was floored at ${num(rf, 1)}% + 300bp.`);
                          if (d0.waccFloored) notes.push(`The blended WACC came to ${pct(d0.waccRaw)} and was floored at 6.0%.`);
                          const LBL = {
                            growth: "revenue growth", ebitMargin: "operating margin", ebitdaMargin: "EBITDA margin",
                            daPct: "D&A", capexPct: "capex", nwcPct: "working capital", taxRate: "tax rate",
                            kd: "cost of debt", beta: "beta", shares: "share count", exitMult: "exit multiple",
                          };
                          const missing = (d0.unsourced || []).filter((k) => k !== "exitMult" || val.asm.termMode === "exit");
                          return (
                            <div style={{ background: T.band2, border: `1px solid ${T.ruleDark}`, borderRadius: T.radiusMd, padding: "12px 14px", marginBottom: 18 }}>
                              <div style={{ ...label, fontSize: 9, marginBottom: 7, color: T.copper }}>How these defaults were set</div>
                              {notes.map((nt, i) => (
                                <div key={i} style={{ fontSize: 11.5, color: "#C7D1DB", lineHeight: 1.6, marginBottom: 5 }}>· {nt}</div>
                              ))}
                              <div style={{ fontSize: 11.5, lineHeight: 1.6, marginTop: 7, paddingTop: 7, borderTop: `1px solid ${T.rule}`, color: missing.length ? T.copper : T.sage }}>
                                {missing.length === 0
                                  ? "· Every input above is computed from this company's own reported figures. Nothing is filled in from a generic assumption."
                                  : `· ${missing.map((k) => LBL[k] || k).join(", ")} ${missing.length === 1 ? "is" : "are"} not reported in the data available for this company, so a generic placeholder was used rather than its own figures. Treat ${missing.length === 1 ? "that input" : "those inputs"} as a guess and set ${missing.length === 1 ? "it" : "them"} yourself.`}
                              </div>
                            </div>
                          );
                        })()}

                        {/* ── terminal value method ── */}
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 18 }}>
                          <span style={{ ...label, fontSize: 9.5 }}>Terminal value</span>
                          {[["gordon", "Perpetual growth"], ["exit", "Exit EV/EBITDA multiple"]].map(([m, lbl]) => (
                            <button key={m} onClick={() => setValOv({ ...valOv, termMode: m })}
                              style={{
                                fontFamily: T.ui, fontSize: 11.5, fontWeight: 700, padding: "6px 14px", borderRadius: T.pill, cursor: "pointer",
                                border: `1px solid ${val.asm.termMode === m ? T.green : T.ruleDark}`,
                                background: val.asm.termMode === m ? "rgba(16,185,129,0.12)" : "transparent",
                                color: val.asm.termMode === m ? T.green : T.sub,
                              }}>{lbl}</button>
                          ))}
                          {val.asm.termMode === "exit" && (
                            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <Field value={Math.round(val.asm.exitMult * 10) / 10} w={64} onChange={(v2) => setValOv({ ...valOv, exitMult: v2 })} />
                              <span style={{ fontSize: 12, color: T.faint }}>× EBITDA</span>
                            </span>
                          )}
                          {val.dcf && isFinite(val.dcf.termPctU) && (
                            <span style={{ fontSize: 11.5, color: val.dcf.termPctU > 0.8 ? T.copper : T.faint }}>
                              Terminal value is {(val.dcf.termPctU * 100).toFixed(0)}% of the total{val.dcf.termPctU > 0.8 ? " — most of the answer rests on the perpetuity, not the forecast" : ""}
                            </span>
                          )}
                        </div>

                        {/* ── projection table ── */}
                        {val.dcf && (
                          <div style={{ overflowX: "auto", marginBottom: 18 }}>
                            <table style={{ borderCollapse: "collapse", minWidth: 620, width: "100%" }}>
                              <thead>
                                <tr>
                                  <th style={th}>Year</th>
                                  <th style={thNum}>Growth</th>
                                  <th style={thNum}>Revenue</th>
                                  <th style={thNum}>EBIT</th>
                                  <th style={thNum}>NOPAT</th>
                                  <th style={thNum}>+ D&A</th>
                                  <th style={thNum}>− Capex</th>
                                  <th style={thNum}>− ΔWC</th>
                                  <th style={thNum}>FCFF</th>
                                  <th style={thNum}>FCFE</th>
                                </tr>
                              </thead>
                              <tbody>
                                {val.dcf.rows.map((r2) => (
                                  <tr key={r2.t}>
                                    <td style={{ ...td, fontWeight: 700 }}>{r2.t}</td>
                                    <td style={{ ...td, textAlign: "right", color: T.sub }}>{(r2.g * 100).toFixed(1)}%</td>
                                    <td style={{ ...td, textAlign: "right" }}>{bigMoney(r2.rev)}</td>
                                    <td style={{ ...td, textAlign: "right" }}>{bigMoney(r2.ebit)}</td>
                                    <td style={{ ...td, textAlign: "right" }}>{bigMoney(r2.nopat)}</td>
                                    <td style={{ ...td, textAlign: "right", color: T.sub }}>{bigMoney(r2.da)}</td>
                                    <td style={{ ...td, textAlign: "right", color: T.sub }}>{bigMoney(r2.capex)}</td>
                                    <td style={{ ...td, textAlign: "right", color: T.sub }}>{bigMoney(r2.nwc)}</td>
                                    <td style={{ ...td, textAlign: "right", fontWeight: 700, color: T.green }}>{bigMoney(r2.fcff)}</td>
                                    <td style={{ ...td, textAlign: "right", fontWeight: 700, color: T.greenLight }}>{bigMoney(r2.fcfe)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}

                        {/* ── bridge ── */}
                        {val.dcf && (
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 18 }}>
                            {[
                              { l: "PV of forecast FCFF", v: bigMoney(val.dcf.pvExplicitU) },
                              { l: "PV of terminal value", v: bigMoney(val.dcf.pvTermU) },
                              { l: "Enterprise value", v: bigMoney(val.dcf.ev), c: T.steel },
                              { l: "Less net debt", v: bigMoney(val.asm.netDebt) },
                              { l: "Equity value", v: bigMoney(val.dcf.equityU), c: T.green },
                            ].map((k, i) => (
                              <div key={i} style={{ background: T.band, border: `1px solid ${T.rule}`, borderRadius: T.radiusMd, padding: "11px 13px" }}>
                                <div style={{ ...label, fontSize: 9, marginBottom: 5 }}>{k.l}</div>
                                <div style={{ fontFamily: T.ui, fontSize: 15, fontWeight: 800, color: k.c || T.ink, fontVariantNumeric: "tabular-nums" }}>{k.v}</div>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* ── sensitivity grid ── */}
                        {val.grid && val.grid.cells.length > 0 && (
                          <>
                            <div style={{ ...label, fontSize: 10, color: T.ink, marginBottom: 8 }}>Sensitivity — value per share by WACC and terminal growth</div>
                            <div style={{ overflowX: "auto", marginBottom: 8 }}>
                              <table style={{ borderCollapse: "collapse" }}>
                                <thead>
                                  <tr>
                                    <th style={{ ...th, fontSize: 9 }}>WACC ↓ / g →</th>
                                    {val.grid.tgs.map((g, j) => <th key={j} style={{ ...thNum, fontSize: 9 }}>{(g * 100).toFixed(1)}%</th>)}
                                  </tr>
                                </thead>
                                <tbody>
                                  {val.grid.cells.map((row, i) => (
                                    <tr key={i}>
                                      <td style={{ ...td, fontWeight: 700, fontSize: 11.5 }}>{(val.grid.waccs[i] * 100).toFixed(1)}%</td>
                                      {row.map((c, j) => {
                                        const ok = isFinite(c) && isFinite(val.price);
                                        const rel = ok ? c / val.price - 1 : NaN;
                                        const bg = !ok ? T.surface
                                          : rel >= 0 ? `rgba(16,185,129,${Math.min(0.42, 0.08 + rel * 0.5)})`
                                            : `rgba(248,113,113,${Math.min(0.42, 0.08 + Math.abs(rel) * 0.5)})`;
                                        const isCentre = val.grid.waccs[i].toFixed(4) === val.asm.wacc.toFixed(4) && val.grid.tgs[j].toFixed(4) === val.asm.tg.toFixed(4);
                                        return (
                                          <td key={j} style={{ ...td, padding: 3, borderBottom: "none" }}>
                                            <div style={{
                                              minWidth: 64, height: 32, background: bg, borderRadius: T.radiusSm,
                                              border: isCentre ? `1.5px solid ${T.ink}` : "1px solid transparent",
                                              display: "flex", alignItems: "center", justifyContent: "center",
                                              fontSize: 11.5, fontVariantNumeric: "tabular-nums", color: T.ink,
                                            }}>{ok ? num(c, c > 100 ? 0 : 1) : "—"}</div>
                                          </td>
                                        );
                                      })}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            <div style={{ fontSize: 11.5, color: T.faint, marginBottom: 18 }}>
                              Green sits above the {valData.currency} {num(val.price)} market price, red below. The outlined cell is your current assumption set. The spread across this grid is the honest width of the answer — a single number would hide it.
                            </div>
                          </>
                        )}

                        {/* ── reverse DCF ── */}
                        {val.implied && (
                          <div style={{ background: T.band2, border: `1px solid ${T.ruleDark}`, borderRadius: T.radiusMd, padding: "13px 15px", fontSize: 12.5, color: "#C7D1DB", marginBottom: 18, lineHeight: 1.65 }}>
                            <strong style={{ color: T.ink }}>Reverse DCF · </strong>
                            {val.implied.beyond === "above"
                              ? `Holding every other assumption still, no revenue growth rate inside a −50% to +150% range gets this model to today's ${valData.currency} ${num(val.price)} price. The market is valuing something this model does not capture, or the assumptions above need revisiting.`
                              : val.implied.beyond === "below"
                                ? `Even at a 50% annual revenue decline this model values the company above its ${valData.currency} ${num(val.price)} price.`
                                : `Today's price of ${valData.currency} ${num(val.price)} is consistent with about ${(val.implied.g * 100).toFixed(1)}% annual revenue growth in year 1, fading to ${(val.asm.tg * 100).toFixed(1)}%, if every other assumption above holds. Reported history was ${(val.defs.growth * 100).toFixed(1)}%.`}
                          </div>
                        )}
                      </>
                    )}

                    {/* ── multiples & quality (shown even when a DCF is unsuitable) ── */}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 18, marginBottom: 18 }}>
                      <div>
                        <div style={{ ...label, fontSize: 10, color: T.ink, marginBottom: 8 }}>Trading multiples</div>
                        {val.multiples.map((m, i) => (
                          <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: i < val.multiples.length - 1 ? `1px solid ${T.rule}` : "none", fontSize: 12.5 }}>
                            <span style={{ color: T.sub }}>{m.l}</span>
                            <span style={{ color: T.ink, fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>
                              {isFinite(m.v) ? (m.pct ? (m.v * 100).toFixed(m.d || 1) + "%" : num(m.v, m.d || 1) + "×") : "—"}
                            </span>
                          </div>
                        ))}
                      </div>
                      <div>
                        <div style={{ ...label, fontSize: 10, color: T.ink, marginBottom: 8 }}>Returns & balance sheet</div>
                        {val.quality.map((m, i) => (
                          <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: i < val.quality.length - 1 ? `1px solid ${T.rule}` : "none", fontSize: 12.5 }}>
                            <span style={{ color: T.sub }}>{m.l}</span>
                            <span style={{ color: T.ink, fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>
                              {isFinite(m.v) ? (m.pct ? (m.v * 100).toFixed(1) + "%" : num(m.v, m.d || 1) + (m.l.indexOf("/") > 0 || m.l.indexOf("coverage") > 0 ? "×" : "")) : "—"}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* ── reported history ── */}
                    <div style={{ ...label, fontSize: 10, color: T.ink, marginBottom: 8 }}>Reported annual financials</div>
                    <div style={{ overflowX: "auto", marginBottom: 14 }}>
                      <table style={{ borderCollapse: "collapse", minWidth: 560, width: "100%" }}>
                        <thead>
                          <tr>
                            <th style={th}>Fiscal year</th>
                            {val.hist.map((h) => <th key={h.year} style={thNum}>{h.year}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {[
                            ["Revenue", "rev"], ["EBIT", "ebit"], ["EBITDA", "ebitda"], ["Net income", "ni"],
                            ["D&A", "da"], ["Capex", "capex"], ["Operating cash flow", "ocf"], ["Free cash flow", "fcf"],
                            ["Total debt", "debt"], ["Cash & equivalents", "cash"], ["Shareholders' equity", "equity"],
                          ].map(([lbl, k]) => (
                            <tr key={k}>
                              <td style={{ ...td, color: T.sub }}>{lbl}</td>
                              {val.hist.map((h) => (
                                <td key={h.year} style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{bigMoney(h[k])}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div style={{ fontSize: 11.5, color: T.faint, lineHeight: 1.65 }}>
                      Figures in {valData.currency}, as reported to the exchange. The statements are facts; the projection is not — a DCF is only ever as good as the assumptions above it, which is why they are all editable and why the sensitivity grid is shown alongside the point estimate. This is an analytical tool, not advice to buy or sell anything.
                    </div>
                  </>
                )}
              </>
            )}
          </Panel>

          <Panel title={`Correlation lab${!isPro ? " · Pro" : ""}`}
            right={!isPro && <Btn small primary onClick={() => setShowPaywall(true)}>Unlock</Btn>}>
            <Hint>How much these holdings move together. 1.00 means they move in lockstep, 0 means unrelated, negative means they zig when the other zags. Lower numbers across the board mean better diversification.</Hint>
            {isPro ? (
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse" }}>
                  <thead><tr><th style={th}></th>{assets.map((a, j) => <th key={j} style={{ ...thNum, fontSize: 9 }}>{a.name}</th>)}</tr></thead>
                  <tbody>
                    {assets.map((a, i) => (
                      <tr key={i}>
                        <td style={{ ...td, fontWeight: 700, fontSize: 11.5 }}>{a.name}</td>
                        {assets.map((_, j) => {
                          const v = i === j ? 1 : corr[Math.min(i, j)][Math.max(i, j)];
                          const measured = i === j || !!(corrReal && corrReal[i] && corrReal[i][j]);
                          const heat = i === j ? T.band : v >= 0 ? `rgba(16,185,129,${0.08 + v * 0.38})` : `rgba(96,165,250,${0.08 + Math.abs(v) * 0.38})`;
                          return (
                            <td key={j} style={{ ...td, padding: 3, borderBottom: "none" }}>
                              {j < i ? <div title={measured ? "Measured from weekly returns" : "Placeholder — not measured"}
                                style={{ width: 52, height: 30, background: heat, borderRadius: T.radiusSm, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontVariantNumeric: "tabular-nums", color: T.ink, border: measured ? "1px solid transparent" : `1px dashed ${T.copper}`, opacity: measured ? 1 : 0.65 }}>{num(v)}</div>
                                : j === i ? <div style={{ width: 52, height: 30, background: T.surface, borderRadius: T.radiusSm, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: T.faint }}>1.00</div>
                                : <div style={{ width: 52 }} title={measured ? "Measured from weekly returns" : "Placeholder — not measured"}><Field value={corr[i][j]} onChange={(vv) => setRho(i, j, vv)} w={52} /></div>}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(() => {
                  const n = assets.length;
                  let ph = 0, tot = 0;
                  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { tot++; if (!(corrReal && corrReal[i] && corrReal[i][j])) ph++; }
                  return (
                    <div style={{ fontSize: 11, marginTop: 8, lineHeight: 1.6, color: ph ? T.copper : T.sage }}>
                      {ph === 0
                        ? `All ${tot} pairs measured from weekly returns over the past 5 years.`
                        : `${ph} of ${tot} pairs ${ph === 1 ? "is a placeholder that has" : "are placeholders that have"} not been measured — shown dashed. ${mktLoading ? "Pulling market data now…" : "Press Fetch market data, or edit them directly."}`}
                      <span style={{ color: T.faint }}> · Edit the upper triangle · heatmap mirrors below (green positive, blue negative)</span>
                    </div>
                  );
                })()}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: T.faint }}>Edit every pairwise correlation and see the matrix as a live heatmap.</div>
            )}
          </Panel>

          <Panel title="Quantitative diagnostics">
            <Hint>Automatic checks on the result: how concentrated it is, how much diversification you are actually getting, and how bad a rough year could look.</Hint>
            {qInsights.map((q, i) => (
              <div key={i} style={{ display: "flex", gap: 14, marginBottom: 10, paddingBottom: 10, borderBottom: i < qInsights.length - 1 ? `1px solid ${T.rule}` : "none" }}>
                <span style={{ ...label, fontSize: 9, minWidth: 100, paddingTop: 2, color: T.green }}>{q.tag}</span>
                <span style={{ fontSize: 13, lineHeight: 1.6, color: "#C7D1DB" }}>{q.text}</span>
              </div>
            ))}
          </Panel>

          {/* AI OBSERVATIONS — safeguarded */}
          <Panel title={`Security news briefs${!isPro ? " · Pro" : ""}`}>
            <Hint>Recent headlines for each holding, with links to the full articles.</Hint>
            <div style={{ fontSize: 12.5, color: T.sub, marginBottom: 10 }}>Recent factual coverage for any holding — descriptive only:</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {assets.map((a, i) => (
                <button key={i} onClick={() => runBrief(a.name)} style={{ fontFamily: T.ui, fontSize: 12, fontWeight: 700, padding: "8px 16px", borderRadius: T.pill, cursor: "pointer", border: `1px solid rgba(96,165,250,0.4)`, background: "rgba(96,165,250,0.08)", color: T.steel }}>{a.name} ↗</button>
              ))}
            </div>
          </Panel>

          <Panel title={`AI observations${!isPro ? " · Pro" : ""}`}
            right={<Btn small primary onClick={runAiInsights}>{aiLoading ? "Analyzing…" : isPro ? "Generate" : "Unlock"}</Btn>} band>
            <Hint>Machine-written notes on what stands out in your inputs and results.</Hint>
            <div style={{ background: "rgba(255,255,255,0.03)", padding: "10px 14px", marginBottom: 14, borderRadius: T.radiusSm, fontSize: 11.5, color: T.sub, lineHeight: 1.55 }}>
              <b style={{ color: T.ink }}>Descriptive only.</b> These are machine-generated observations about the model's inputs and outputs — labeled as strengths, considerations, or flags. They are screened by an advice-language filter before display, contain no recommendations, and are not investment advice. Company characteristics beyond the numbers you entered may be imprecise; verify independently.
            </div>
            {aiError && <div style={{ fontSize: 13, color: T.red }}>{aiError} <span onClick={runAiInsights} style={{ color: T.green, fontWeight: 700, cursor: 'pointer', marginLeft: 6 }}>Try again</span></div>}
            {!aiItems && !aiLoading && !aiError && (
              <div style={{ fontSize: 13, color: T.faint, lineHeight: 1.6 }}>
                Generates observations specific to the securities entered: structural strengths visible in the data, model sensitivities, and risk patterns such as likely shared factor exposures.
              </div>
            )}
            {aiItems && aiItems.map((ins, i) => (
              <div key={i} style={{ marginBottom: 14, display: "flex", gap: 12, alignItems: "flex-start" }}>
                <div style={{ paddingTop: 1 }}><TypeBadge type={ins.type} /></div>
                <div>
                  <div style={{ fontFamily: T.disp, fontSize: 14, fontWeight: 800, color: T.ink, marginBottom: 3 }}>{ins.title}</div>
                  <div style={{ fontSize: 13, lineHeight: 1.65, color: "#C7D1DB" }}>{ins.body}</div>
                </div>
              </div>
            ))}
            {aiItems && aiWithheld > 0 && (
              <div style={{ fontSize: 11.5, color: T.copper, marginTop: 6 }}>
                {aiWithheld} observation{aiWithheld > 1 ? "s were" : " was"} withheld by the advice-language filter.
              </div>
            )}
          </Panel>

          <div style={{ fontSize: 10.5, color: T.faint, lineHeight: 1.6 }}>
            Tangency: w ∝ Σ⁻¹(μ − rf·1) · Min-var: w ∝ Σ⁻¹1 · y* = (E[rp] − rf)/(A·σp²) · MC: lognormal monthly steps. Descriptive model output only; not investment advice.
          </div>
        </>
      )}
    </div>
  );

  /* ═════════ SHELL ═════════ */
  return (
    <div style={{ minHeight: "100vh", background: T.paper, color: T.ink, fontFamily: T.ui }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;500;600;700;800&display=swap');
        input[type=range]{accent-color:${T.green};} input[type=checkbox]{accent-color:${T.green};}
        select:focus, input:focus{border-color:${T.green} !important; box-shadow:0 0 0 3px rgba(16,185,129,0.18) !important;}
        button{font-family:inherit;}
        @keyframes fxBlob{0%,100%{transform:translate(0,0) scale(1);}33%{transform:translate(30px,-24px) scale(1.06);}66%{transform:translate(-20px,18px) scale(.95);}}
        .fx-blob{animation-name:fxBlob; animation-timing-function:ease-in-out; animation-iteration-count:infinite;}`}</style>
      {showPaywall && Paywall()}
      {showCheckout && Checkout()}
      {briefTicker && (
        <div onClick={() => setBriefTicker(null)} style={{ position: "fixed", inset: 0, background: "rgba(3,7,18,0.72)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 55, padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: T.band, border: `1px solid ${T.rule}`, borderRadius: T.radius, boxShadow: T.shadow, maxWidth: 560, width: "100%", maxHeight: "80vh", overflowY: "auto", padding: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
              <h2 style={{ fontFamily: T.disp, fontSize: 19, fontWeight: 800, margin: 0, color: T.ink }}>
                {briefTicker} <span style={{ fontSize: 12, fontWeight: 600, color: T.sub }}>· security brief</span>
              </h2>
              <span onClick={() => setBriefTicker(null)} style={{ cursor: "pointer", color: T.faint, fontSize: 15 }}>✕</span>
            </div>
            <div style={{ fontSize: 11, color: T.faint, marginBottom: 16 }}>Recent coverage, summarized factually. Descriptive only — verify independently.</div>
            {briefLoading && <div style={{ fontSize: 13, color: T.sub }}>Searching recent coverage…</div>}
            {briefErr && <div style={{ fontSize: 13, color: T.red }}>{briefErr}</div>}
            {briefData && briefData.items.map((it, i) => (
              <div key={i} style={{ marginBottom: 14, paddingBottom: 14, borderBottom: i < briefData.items.length - 1 ? `1px solid ${T.rule}` : "none" }}>
                <div style={{ marginBottom: 5 }}>
                  <span style={{ fontFamily: T.ui, fontSize: 9.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", background: "rgba(96,165,250,0.14)", color: T.steel, padding: "4px 10px", borderRadius: T.pill, marginRight: 8 }}>{it.category}</span>
                  <span style={{ fontFamily: T.disp, fontSize: 13.5, fontWeight: 800, color: T.ink }}>{it.title}</span>
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.6, color: "#C7D1DB" }}>{it.note}{it.url && <a href={it.url} target="_blank" rel="noreferrer" style={{ color: T.steel, fontWeight: 700, marginLeft: 8, textDecoration: "none" }}>Read article ↗</a>}</div>
              </div>
            ))}
            {briefData && briefData.modelNote && (
              <div style={{ background: "rgba(251,191,36,0.08)", border: `1px solid ${T.goldBorder}`, borderRadius: T.radiusMd, padding: "12px 14px", fontSize: 12.5, lineHeight: 1.6, color: T.ink }}>
                <span style={{ ...label, fontSize: 9, color: T.copper, display: "block", marginBottom: 4 }}>Relevance to your inputs</span>
                {briefData.modelNote}
              </div>
            )}
          </div>
        </div>
      )}

      <div style={{ borderBottom: `1px solid ${T.rule}`, background: "rgba(3,7,18,0.85)", backdropFilter: "blur(8px)", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ maxWidth: 1500, margin: "0 auto", padding: "0 20px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 60 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
            <span onClick={() => setView("landing")} style={{ fontFamily: T.disp, fontWeight: 800, fontSize: 16, letterSpacing: "0.01em", cursor: "pointer", color: T.ink }}>
              FRONTIER <span style={{ color: T.green }}>X</span>
            </span>
            {view === "app" && (
              <div style={{ display: "flex", gap: 2, background: T.surface, borderRadius: T.pill, padding: 3 }}>
                {[["basic", "Basic"], ["advanced", "Advanced"]].map(([m, t]) => (
                  <button key={m} onClick={() => setMode(m)}
                    style={{ fontFamily: T.ui, fontSize: 12, fontWeight: 700, padding: "6px 16px", cursor: "pointer", border: "none", borderRadius: T.pill, background: mode === m ? T.green : "transparent", color: mode === m ? "#04140D" : T.sub }}>
                    {t}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {view === "landing" && <span onClick={() => setView("app")} style={{ fontSize: 12.5, fontWeight: 700, color: T.sub, cursor: "pointer" }}>Workspace</span>}
            <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: "0.08em", color: isAdv ? T.green : T.sub, background: isAdv ? "rgba(16,185,129,0.12)" : T.surface, borderRadius: T.pill, padding: "4px 11px" }}>
              {plan.toUpperCase()}
            </span>
            {!isPro && <Btn small primary pill onClick={() => setShowPaywall(true)}>Upgrade</Btn>}
          </div>
        </div>
      </div>

      {view === "landing" ? Landing() : mode === "basic" ? BasicMode() : AdvancedMode()}
    </div>
  );
}

/* A render-time throw anywhere in the tree unmounts everything and leaves the
   user staring at a blank page with no way to recover — saved state that puts
   the app in a bad shape would keep re-crashing on every reload. Catch it,
   explain it, and offer a one-click reset of the persisted book. */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (!this.state.err) return this.props.children;
    const reset = () => {
      try { localStorage.removeItem("fx_book"); localStorage.removeItem("fx_plan"); } catch (e) {}
      window.location.reload();
    };
    return (
      <div style={{ minHeight: "100vh", background: T.paper, color: T.ink, fontFamily: T.ui, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ maxWidth: 460, width: "100%", background: T.band, border: `1px solid ${T.rule}`, borderRadius: T.radiusLg, boxShadow: T.shadow, padding: 28 }}>
          <div style={{ ...label, color: T.copper, marginBottom: 10 }}>Something broke</div>
          <h1 style={{ fontFamily: T.disp, fontSize: 22, fontWeight: 800, margin: "0 0 10px", color: T.ink }}>
            The app couldn't render.
          </h1>
          <p style={{ fontSize: 13.5, color: T.sub, lineHeight: 1.65, margin: "0 0 18px" }}>
            This is usually caused by a saved portfolio that no longer matches what the
            model expects. Resetting the saved data clears it and reloads the app. Your
            holdings will need to be re-entered.
          </p>
          <div style={{ background: T.surface, borderRadius: T.radiusSm, padding: "10px 12px", marginBottom: 18, fontSize: 11.5, color: T.faint, fontFamily: T.mono, wordBreak: "break-word" }}>
            {String((this.state.err && this.state.err.message) || this.state.err)}
          </div>
          <Btn primary wide pill onClick={reset}>Reset saved data &amp; reload</Btn>
        </div>
      </div>
    );
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <FrontierApp />
    </ErrorBoundary>
  );
}
