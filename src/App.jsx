import React, { useState, useMemo } from "react";
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
      const rho = i === j ? 1 : corr[Math.min(i, j)][Math.max(i, j)];
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
  const mMu = ret / 12 - (sigma * sigma) / 24;
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
  const mMu = ret / 12 - (sigma * sigma) / 24;
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
  { name: "VST", er: 14, sigma: 38 },
  { name: "NVDA", er: 16, sigma: 42 },
  { name: "BN.TO", er: 12, sigma: 28 },
  { name: "MEQ.TO", er: 10, sigma: 24 },
  { name: "ATD.TO", er: 9, sigma: 20 },
];
const defaultCorr = (n) => {
  const c = [];
  for (let i = 0; i < n; i++) { c.push([]); for (let j = 0; j < n; j++) c[i].push(i === j ? 1 : 0.35); }
  return c;
};
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
["US · Insurance",19,"BRK.B~Berkshire Hathaway;PGR~Progressive;CB~Chubb;MMC~Marsh McLennan;AON~Aon;AJG~Gallagher;MET~MetLife;AIG~AIG;PRU~Prudential;AFL~Aflac;ALL~Allstate;TRV~Travelers;HIG~Hartford;WTW~WTW;BRO~Brown & Brown;EG~Everest;CINF~Cincinnati Financial;L~Loews;GL~Globe Life;AIZ~Assurant;WRB~WR Berkley;ACGL~Arch Capital;PFG~Principal;ERIE~Erie Indemnity"],
// ————— S&P 500 · Consumer Discretionary —————
["US · Consumer Discretionary",28,"AMZN~Amazon;HD~Home Depot;MCD~McDonald's;BKNG~Booking;LOW~Lowe's;TJX~TJX;SBUX~Starbucks;NKE~Nike;CMG~Chipotle;ORLY~O'Reilly;AZO~AutoZone;MAR~Marriott;HLT~Hilton;GM~General Motors;F~Ford;YUM~Yum Brands;DRI~Darden;ROST~Ross;DG~Dollar General;DLTR~Dollar Tree;BBY~Best Buy;EBAY~eBay;DECK~Deckers;LULU~Lululemon;RL~Ralph Lauren;TPR~Tapestry;GRMN~Garmin;EXPE~Expedia;POOL~Pool Corp;KMX~CarMax;APTV~Aptiv;GPC~Genuine Parts;ULTA~Ulta;WSM~Williams-Sonoma;TSCO~Tractor Supply;HAS~Hasbro;MHK~Mohawk;DHI~DR Horton;LEN~Lennar;PHM~PulteGroup;NVR~NVR"],
["US · Travel & Casinos",36,"RCL~Royal Caribbean;CCL~Carnival;NCLH~Norwegian;LVS~Las Vegas Sands;WYNN~Wynn;MGM~MGM;CZR~Caesars;DAL~Delta;UAL~United Airlines;LUV~Southwest;AAL~American Airlines"],
// ————— S&P 500 · Consumer Staples —————
["US · Staples",15,"WMT~Walmart;PG~Procter & Gamble;COST~Costco;KO~Coca-Cola;PEP~PepsiCo;PM~Philip Morris;MO~Altria;MDLZ~Mondelez;CL~Colgate;TGT~Target;KMB~Kimberly-Clark;GIS~General Mills;KDP~Keurig Dr Pepper;MNST~Monster;STZ~Constellation Brands;HSY~Hershey;KR~Kroger;SYY~Sysco;ADM~ADM;KHC~Kraft Heinz;CHD~Church & Dwight;MKC~McCormick;CLX~Clorox;CAG~Conagra;CPB~Campbell's;HRL~Hormel;SJM~JM Smucker;TSN~Tyson;TAP~Molson Coors;BG~Bunge;LW~Lamb Weston;EL~Estée Lauder;BF.B~Brown-Forman;CASY~Casey's"],
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
  const inputRef = React.useRef(null);
  const results = searchLibrary(value);
  const measure = () => {
    if (inputRef.current) setRect(inputRef.current.getBoundingClientRect());
  };
  // fixed positioning escapes any overflow/scroll container (fixes clipping
  // when the row sits low on the page); flip upward if short on space below
  const DROP_H = 236;
  const flipUp = rect && window.innerHeight - rect.bottom < DROP_H && rect.top > DROP_H;
  const dropStyle = rect ? {
    position: "fixed",
    left: Math.min(rect.left, Math.max(8, window.innerWidth - 258)),
    ...(flipUp ? { bottom: window.innerHeight - rect.top + 2 } : { top: rect.bottom + 2 }),
    zIndex: 1000, width: 250, maxHeight: DROP_H, overflowY: "auto",
    background: T.band, border: `1px solid ${T.ruleDark}`,
    borderTop: `2px solid ${T.green}`, boxShadow: "0 8px 24px rgba(12,18,16,0.16)",
  } : null;
  return (
    <div style={{ position: "relative", display: "inline-block", width }}>
      <input ref={inputRef} value={value}
        onChange={(e) => { onChange(e.target.value); measure(); setOpen(true); }}
        onFocus={() => { measure(); setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 160)}
        placeholder="Ticker or name"
        style={{ width: "100%", padding: "6px 8px", border: `1px solid ${T.ruleDark}`, borderRadius: 3, fontFamily: T.ui, fontSize: 13, fontWeight: bold ? 700 : 500, color: T.ink, background: T.surface, outline: "none", boxSizing: "border-box" }} />
      {open && results.length > 0 && dropStyle && (
        <div style={dropStyle}>
          {results.map((r) => (
            <div key={r.t}
              onMouseDown={(e) => { e.preventDefault(); onSelect(r); setOpen(false); }}
              style={{ padding: "8px 10px", borderBottom: `1px solid ${T.rule}`, cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#1B2530")}
              onMouseLeave={(e) => (e.currentTarget.style.background = T.band)}>
              <div style={{ minWidth: 0 }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: T.ink }}>{r.t}</span>
                <span style={{ fontSize: 11.5, color: T.sub, marginLeft: 7 }}>{r.n}</span>
              </div>
              <span style={{ fontSize: 10, color: T.faint, whiteSpace: "nowrap" }}>{r.sec} · σ~{r.vol}%</span>
            </div>
          ))}
          <div style={{ padding: "6px 10px", fontSize: 10, color: T.faint }}>Estimates are editable · not in the list? Type it and set your own figures.</div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════ DESIGN TOKENS — sharp editorial light ═══════════════ */

const T = {
  paper: "#0C1116",        // terminal base
  band: "#121A22",         // raised panel
  surface: "#141C25",      // inputs / cells
  ink: "#E8EEF2",
  sub: "#93A1AD",
  faint: "#5C6873",
  rule: "#212B35",
  ruleDark: "#35424F",
  green: "#2EBD85",        // up / primary
  greenDeep: "#1F8A62",
  steel: "#4C9AFF",        // secondary series
  copper: "#E8A33D",       // amber highlight
  red: "#F6465D",          // down
  goldBg: "#251C0D",       // amber warning bg
  ui: "'Inter', -apple-system, sans-serif",
  disp: "'Archivo', 'Inter', sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, Menlo, monospace",
};
const PALETTE = [T.green, T.steel, T.copper, "#B180F0", "#F6465D", "#25C2C2", "#D4B106", "#7E93A8", "#E06B9A", "#5AD1B3"];

const pct = (v, d = 1) => (isFinite(v) ? (v * 100).toFixed(d) + "%" : "—");
const num = (v, d = 2) => (isFinite(v) ? v.toFixed(d) : "—");
const money = (v) => (isFinite(v) ? "$" + Math.round(v).toLocaleString() : "—");
const label = { fontFamily: T.ui, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.11em", color: T.sub };

function Field({ value, onChange, w = 58 }) {
  return (
    <input type="number" value={value}
      onChange={(e) => onChange(e.target.value === "" ? 0 : parseFloat(e.target.value))}
      style={{ width: w, padding: "5px 7px", border: `1px solid ${T.ruleDark}`, borderRadius: 3, fontFamily: T.ui, fontVariantNumeric: "tabular-nums", fontSize: 13, color: T.ink, background: T.surface, textAlign: "right", outline: "none" }} />
  );
}
function Btn({ children, onClick, primary, small, wide }) {
  return (
    <button onClick={onClick} style={{
      fontFamily: T.ui, fontSize: small ? 12.5 : 14, fontWeight: 600,
      padding: small ? "7px 14px" : "12px 24px", borderRadius: 3, cursor: "pointer",
      border: `1.5px solid ${primary ? T.green : T.ruleDark}`,
      background: primary ? T.green : T.surface,
      color: primary ? "#07130E" : T.green,
      width: wide ? "100%" : "auto",
    }}>{children}</button>
  );
}
function Panel({ title, right, children, band }) {
  return (
    <div style={{ background: band ? T.band : T.paper, border: `1px solid ${T.rule}`, borderTop: `3px solid ${T.green}`, marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", borderBottom: `1px solid ${T.rule}`, flexWrap: "wrap", gap: 8 }}>
        <span style={{ ...label, color: T.ink }}>{title}</span>{right}
      </div>
      <div style={{ padding: 16 }}>{children}</div>
    </div>
  );
}
// Engraved-chart hero art: fine green line-work on paper — swap for a licensed
// photograph (e.g. Unsplash: trading floor, skyline) at deploy time if preferred.
function HeroArt() {
  const rows = useMemo(() => {
    const mk = (seed, amp, base) => {
      let y = base, out = "";
      for (let x = 0; x <= 100; x += 1.5) {
        y += (Math.sin(x / 6 + seed) * 0.7 + Math.random() - 0.46) * amp;
        out += `${x},${Math.max(6, Math.min(94, y))} `;
      }
      return out.trim();
    };
    return Array.from({ length: 7 }, (_, i) => mk(i * 2.3, 1.1 + i * 0.14, 78 - i * 9));
  }, []);
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
      {Array.from({ length: 11 }, (_, i) => (
        <line key={i} x1={i * 10} y1="0" x2={i * 10} y2="100" stroke={T.rule} strokeWidth="0.15" />
      ))}
      {rows.map((p, i) => (
        <polyline key={i} points={p} fill="none" stroke={i === 3 ? T.green : T.ruleDark}
          strokeWidth={i === 3 ? 0.6 : 0.25} opacity={i === 3 ? 1 : 0.8} />
      ))}
    </svg>
  );
}
function TypeBadge({ type }) {
  const map = {
    strength: { t: "Strength", bg: "rgba(46,189,133,0.14)", c: T.green },
    consideration: { t: "Consideration", bg: "rgba(76,154,255,0.14)", c: T.steel },
    flag: { t: "Flag", bg: "rgba(232,163,61,0.16)", c: T.copper },
  };
  const m = map[type] || map.consideration;
  return <span style={{ fontFamily: T.ui, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", background: m.bg, color: m.c, padding: "3px 8px", borderRadius: 2 }}>{m.t}</span>;
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

/* ═══════════════ APP ═══════════════ */

export default function FrontierApp() {
  const [view, setView] = useState("landing");
  const [mode, setMode] = useState("basic"); // basic | advanced
  const [plan, setPlan] = useState("free");
  const [showPaywall, setShowPaywall] = useState(false);
  const [showCheckout, setShowCheckout] = useState(null); // "advanced" | "pro" | null
  const [ckEmail, setCkEmail] = useState("");
  const [ckCard, setCkCard] = useState("");
  const [ckExp, setCkExp] = useState("");
  const [ckCvc, setCkCvc] = useState("");
  const [ckErr, setCkErr] = useState(null);
  const [trialEnds, setTrialEnds] = useState(null);

  // basic-mode state
  const [bHoldings, setBHoldings] = useState(DEFAULT_BASIC);
  const [bYears, setBYears] = useState(10);
  const [bMonthly, setBMonthly] = useState(0);

  // advanced-mode state
  const [assets, setAssets] = useState(DEFAULT_ASSETS);
  const [corr, setCorr] = useState(defaultCorr(DEFAULT_ASSETS.length));
  const [rf, setRf] = useState(3.5);
  const [A, setA] = useState(4);
  const [longOnly, setLongOnly] = useState(false);
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

  /* ---- shared model runners ---- */
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
  const base = useMemo(() => runModel(assets, corr, rf), [assets, corr, rf, longOnly]);
  const scen = useMemo(() => {
    if (scenario === "base" || !base) return null;
    const { a, c, rf: r2 } = SCENARIOS[scenario].fn(assets, corr, rf);
    return runModel(a, c, r2);
  }, [scenario, assets, corr, rf, longOnly, base]);

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
  }, [base, assets, rf, A, longOnly]);

  const mc = useMemo(() => (base ? monteCarlo(base.tan.ret, base.tan.sigma, mcYears, 500, Math.max(1, mcStart)) : null),
    [base, mcYears, mcStart, mcSeed]);

  const qInsights = useMemo(
    () => (base ? quantInsights(assets, corr, { tan: base.tan }, rf / 100, A) : []),
    [assets, corr, base, rf, A]
  );

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
  };
  const addAsset = () => {
    if (n >= 10) return;
    setAssets([...assets, { name: `ASSET${n + 1}`, er: 8, sigma: 20 }]);
    const c = corr.map((r) => [...r, 0.35]);
    c.push(Array(n + 1).fill(0.35)); c[n][n] = 1;
    setCorr(c);
  };
  const removeAsset = (i) => {
    if (n <= 2) return;
    setAssets(assets.filter((_, k) => k !== i));
    setCorr(corr.filter((_, r2) => r2 !== i).map((r) => r.filter((_, c2) => c2 !== i)));
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
    setPlan(tier);
    if (tier === "advanced") setMode("advanced");
    setShowCheckout(null); setView("app");
    setCkCard(""); setCkExp(""); setCkCvc("");
  };
  const ckField = { width: "100%", padding: "9px 10px", border: `1px solid ${T.ruleDark}`, borderRadius: 3, fontFamily: T.mono, fontSize: 13.5, color: T.ink, background: T.surface, outline: "none", boxSizing: "border-box" };
  const Checkout = () => (
    <div onClick={() => setShowCheckout(null)} style={{ position: "fixed", inset: 0, background: "rgba(6,10,14,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: T.paper, border: `1px solid ${T.ruleDark}`, borderTop: `4px solid ${T.green}`, maxWidth: 420, width: "100%", padding: 24 }}>
        <h2 style={{ fontFamily: T.disp, fontSize: 19, fontWeight: 800, margin: "0 0 4px", color: T.ink }}>
          "Subscribe to Pro"
        </h2>
        <p style={{ fontSize: 12.5, color: T.sub, margin: "0 0 16px", lineHeight: 1.55 }}>
"$14.99/mo, cancel anytime."
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
        <div style={{ marginTop: 16 }}>
          <Btn primary wide onClick={activatePlan}>
            "Subscribe — $14.99/mo"
          </Btn>
        </div>
        <div style={{ fontSize: 10, color: T.faint, marginTop: 10, lineHeight: 1.5 }}>
          Secure checkout demo — replaced by Stripe Checkout in production. No card details are stored.
        </div>
      </div>
    </div>
  );

  /* ═════════ PAYWALL ═════════ */
  const Paywall = () => (
    <div onClick={() => setShowPaywall(false)} style={{ position: "fixed", inset: 0, background: "rgba(12,18,16,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: T.paper, border: `1px solid ${T.ruleDark}`, borderTop: `4px solid ${T.green}`, maxWidth: 720, width: "100%" }}>
        <div style={{ padding: "22px 24px" }}>
          <h2 style={{ fontFamily: T.disp, fontSize: 22, fontWeight: 800, margin: "0 0 4px", color: T.ink }}>Plans</h2>
          <p style={{ fontSize: 12.5, color: T.sub, margin: "0 0 18px" }}>Basic and Advanced are free. Pro adds the analytical extras.</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 0, border: `1px solid ${T.rule}` }}>
            {[
              { name: "Basic", price: "$0", items: ["Plain-language check-up", "Risk & diversification read", "Dollar-based projection"], cta: "Included", act: () => { setPlan("free"); setMode("basic"); setShowPaywall(false); setView("app"); } },
              { name: "Advanced", price: "$0", items: ["Full optimizer & frontier", "Monte Carlo simulator", "Quantitative diagnostics"], cta: "Open toolkit", act: () => { setPlan(plan); setMode("advanced"); setShowPaywall(false); setView("app"); } },
              { name: "Pro", price: "$14.99/mo", hi: true, items: ["AI observations", "Security news briefs", "Crisis stress lab", "Correlation lab", "Long-only solver"], cta: "Subscribe", act: () => { setShowPaywall(false); setShowCheckout("pro"); } },
            ].map((p, i) => (
              <div key={i} style={{ padding: 18, borderRight: i < 2 ? `1px solid ${T.rule}` : "none", background: p.hi ? "#152420" : T.band }}>
                <div style={{ fontFamily: T.disp, fontWeight: 800, fontSize: 15, color: p.hi ? T.green : T.ink }}>{p.name}</div>
                <div style={{ fontFamily: T.mono, fontVariantNumeric: "tabular-nums", fontSize: 24, fontWeight: 800, margin: "6px 0 2px", color: T.ink }}>{p.price}</div>
                <div style={{ fontSize: 10.5, color: T.green, fontWeight: 700, marginBottom: 8, minHeight: 14 }}>{p.sub || ""}</div>
                <div style={{ fontSize: 12, color: T.sub, lineHeight: 1.9, marginBottom: 14 }}>{p.items.map((x, k) => <div key={k}>· {x}</div>)}</div>
                <Btn small primary={p.hi} onClick={p.act}>{p.cta}</Btn>
                {(p.hi || p.sub) && <div style={{ fontSize: 10, color: T.faint, marginTop: 8 }}>Demo checkout — connect Stripe in production.</div>}
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
      <div style={{ borderBottom: `1px solid ${T.rule}`, position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0, opacity: 0.3 }}><HeroArt /></div>
        <div style={{ maxWidth: 980, margin: "0 auto", padding: "72px 16px 56px", position: "relative" }}>
          <div style={{ ...label, color: T.green, marginBottom: 14 }}>Portfolio analytics · Three tiers · Two free</div>
          <h1 style={{ fontFamily: T.disp, fontSize: 46, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.04, margin: "0 0 16px", maxWidth: 660, color: T.ink }}>
            Know exactly what your portfolio is doing.
          </h1>
          <p style={{ fontSize: 16, color: "#FFFFFF", maxWidth: 540, lineHeight: 1.65, margin: "0 0 26px", textShadow: "0 1px 8px rgba(12,17,22,0.8)" }}>
            From a plain-language check-up anyone can read, to the same mean-variance mathematics used on institutional desks. Your assumptions in, honest analysis out.
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Btn primary onClick={() => { setMode("basic"); setView("app"); }}>Check my portfolio — free</Btn>
            <Btn onClick={() => { setMode("advanced"); setView("app"); }}>Open the full toolkit</Btn>
          </div>
        </div>
      </div>

      {/* live proof band */}
      {base && mc && (
        <div style={{ background: T.band, borderTop: `1px solid ${T.rule}`, borderBottom: `1px solid ${T.rule}` }}>
          <div style={{ maxWidth: 980, margin: "0 auto", padding: "18px 16px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14 }}>
            {[
              { l: "Max Sharpe solved", v: num(base.tan.sharpe) },
              { l: "Frontier points", v: chart ? String(chart.frontier.length) : "—" },
              { l: "Paths simulated", v: "500" },
              { l: "Median 10-yr outcome", v: money(mc.median) },
            ].map((k, i) => (
              <div key={i}>
                <div style={{ fontFamily: T.mono, fontVariantNumeric: "tabular-nums", fontSize: 24, fontWeight: 800, color: T.green }}>{k.v}</div>
                <div style={{ ...label, fontSize: 9, color: T.faint }}>{k.l} · live</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* tiers */}
      <div style={{ maxWidth: 980, margin: "0 auto", padding: "48px 16px" }}>
        <h2 style={{ fontFamily: T.disp, fontSize: 28, fontWeight: 800, margin: "0 0 6px", color: T.ink }}>Built for how much finance you know.</h2>
        <p style={{ fontSize: 13.5, color: T.sub, margin: "0 0 24px", maxWidth: 560 }}>Never used anything beyond a brokerage app? Start Basic. Comfortable with volatility and correlation? Advanced is the full desk. Both free.</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 0, border: `1px solid ${T.rule}` }}>
          {[
            { tier: "Basic", tag: "Free · plain language", d: "Type in what you own and what it's worth. Get a risk grade, a risk-mix breakdown, plain-English flags, and a dollar-figure projection that includes your monthly contributions — no jargon anywhere.", act: () => { setMode("basic"); setView("app"); }, cta: "Start here" },
            { tier: "Advanced", tag: "Free · full mathematics", d: "Tangency and minimum-variance portfolios solved in closed form, the efficient frontier, capital allocation line, Monte Carlo simulation, and six live diagnostics.", act: () => { setMode("advanced"); setView("app"); }, cta: "Open toolkit" },
            { tier: "Pro", tag: "$14.99/mo · analytical extras", d: "Crisis stress testing, a fully editable correlation lab, long-only optimization, AI observations, and factual news briefs on any holding.", act: () => setShowPaywall(true), cta: "See Pro" },
          ].map((t, i) => (
            <div key={i} style={{ padding: 24, borderRight: i < 2 ? `1px solid ${T.rule}` : "none", background: i === 2 ? "#152420" : T.band }}>
              <div style={{ fontFamily: T.disp, fontSize: 19, fontWeight: 800, color: i === 2 ? T.green : T.ink }}>{t.tier}</div>
              <div style={{ ...label, fontSize: 9.5, margin: "4px 0 12px" }}>{t.tag}</div>
              <p style={{ fontSize: 13, color: T.sub, lineHeight: 1.65, margin: "0 0 16px" }}>{t.d}</p>
              <Btn small primary={i === 2} onClick={t.act}>{t.cta}</Btn>
            </div>
          ))}
        </div>
      </div>

      {/* final CTA */}
      <div style={{ maxWidth: 980, margin: "0 auto", padding: "48px 16px 40px", textAlign: "center" }}>
        <h2 style={{ fontFamily: T.disp, fontSize: 26, fontWeight: 800, margin: "0 0 8px", color: T.ink }}>Sixty seconds to your first read.</h2>
        <p style={{ fontSize: 13.5, color: T.sub, margin: "0 0 20px" }}>No signup. No card. No jargon unless you ask for it.</p>
        <Btn primary onClick={() => { setMode("basic"); setView("app"); }}>Check my portfolio</Btn>
        <div style={{ fontSize: 10.5, color: T.faint, marginTop: 32 }}>
          Analytical tool only. All outputs are descriptive model results based on user-supplied assumptions, and do not constitute investment advice or recommendations.
        </div>
      </div>
    </div>
  );

  /* ═════════ BASIC MODE ═════════ */
  const BasicMode = () => (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "20px 16px 48px" }}>
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
            <Field value={h.amount} onChange={(v) => setB(i, "amount", v)} w={86} />
            <select value={h.risk} onChange={(e) => setB(i, "risk", e.target.value)}
              style={{ padding: "7px 8px", border: `1px solid ${T.ruleDark}`, borderRadius: 3, fontFamily: T.ui, fontSize: 12.5, color: T.ink, background: T.surface }}>
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
        <div style={{ background: T.goldBg, border: `1px solid ${T.ruleDark}`, padding: "10px 14px", fontSize: 13, color: T.ink }}>
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
              <div style={{ display: "flex", height: 26, overflow: "hidden", border: `1px solid ${T.ruleDark}` }}>
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
                  <Tooltip formatter={(v) => money(v)} contentStyle={{ background: T.band, border: `1px solid ${T.ruleDark}`, borderRadius: 3, fontSize: 12, color: T.ink }} />
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
                  Adding $<Field value={bMonthly} onChange={(v) => setBMonthly(Math.max(0, v))} w={64} />/mo
                </label>
                <label style={{ fontSize: 12, color: T.sub, display: "flex", gap: 6, alignItems: "center" }}>
                  Years <Field value={bYears} onChange={(v) => setBYears(Math.max(1, Math.min(40, Math.round(v))))} w={44} />
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
                <Tooltip formatter={(v, name2) => [money(v), { p5: "Rough year (5th pct)", p50: "Middle outcome", p95: "Strong year (95th pct)" }[name2] || name2]} contentStyle={{ background: T.band, border: `1px solid ${T.ruleDark}`, borderRadius: 3, fontSize: 12, color: T.ink }} />
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
    <div style={{ maxWidth: 1040, margin: "0 auto", padding: "16px 16px 48px" }}>
      <div style={{ background: T.paper, border: `1px solid ${T.rule}`, padding: "10px 14px", marginBottom: 16, display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" }}>
        <label style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 6, color: T.sub }}>
          Risk-free <Field value={rf} onChange={setRf} w={52} /> %
        </label>
        <label style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 6, color: T.sub }}>
          Risk aversion
          <input type="range" min={1} max={10} step={0.5} value={A} onChange={(e) => setA(parseFloat(e.target.value))} />
          <span style={{ color: T.ink, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{A.toFixed(1)}</span>
        </label>
        <label style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 6, color: T.sub }}>
          <input type="checkbox" checked={longOnly} onChange={(e) => { if (!isPro) { setShowPaywall(true); return; } setLongOnly(e.target.checked); }} />
          Long-only {!isPro && <span style={{ fontSize: 9, fontWeight: 700, color: T.green }}>PRO</span>}
        </label>
        <div style={{ display: "flex", gap: 0, marginLeft: "auto", border: `1px solid ${T.ruleDark}` }}>
          {Object.entries(SCENARIOS).map(([k, s]) => (
            <button key={k}
              onClick={() => { if (k !== "base" && !isPro) { setShowPaywall(true); return; } setScenario(k); }}
              style={{ fontFamily: T.ui, fontSize: 11.5, fontWeight: 700, padding: "6px 12px", cursor: "pointer", border: "none", borderRight: `1px solid ${T.ruleDark}`, background: scenario === k ? T.green : T.surface, color: scenario === k ? "#07130E" : T.sub }}>
              {s.name}
            </button>
          ))}
        </div>
      </div>

      {scen && base && (
        <div style={{ background: T.goldBg, border: `1px solid ${T.ruleDark}`, padding: "10px 14px", marginBottom: 16, fontSize: 12.5, color: T.ink, display: "flex", gap: 20, flexWrap: "wrap" }}>
          <span style={{ ...label, color: T.copper }}>{SCENARIOS[scenario].name} vs base</span>
          <span>E[r]: {pct(base.tan.ret)} → <b style={{ color: scen.tan.ret < base.tan.ret ? T.red : T.green }}>{pct(scen.tan.ret)}</b></span>
          <span>σ: {pct(base.tan.sigma)} → <b style={{ color: scen.tan.sigma > base.tan.sigma ? T.red : T.green }}>{pct(scen.tan.sigma)}</b></span>
          <span>Sharpe: {num(base.tan.sharpe)} → <b style={{ color: scen.tan.sharpe < base.tan.sharpe ? T.red : T.green }}>{num(scen.tan.sharpe)}</b></span>
        </div>
      )}

      <Panel title="Capital market assumptions & solved weights"
        right={
          n >= 10
            ? <span style={{ fontSize: 11.5, color: T.faint }}>10 asset maximum</span>
            : <Btn small onClick={addAsset}>+ Add asset</Btn>
        }>
        {!base && (
          <div style={{ background: T.goldBg, border: `1px solid ${T.ruleDark}`, padding: "9px 12px", marginBottom: 12, fontSize: 12.5, color: T.ink }}>
            The model can't solve with these inputs. Check that every volatility is above zero and that the correlation matrix is internally consistent — extreme combinations (e.g. A–B at 0.9, A–C at 0.9, B–C at −0.9) have no valid covariance.
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16, alignItems: "start" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 400 }}>
              <thead><tr>
                <th style={th}>Security</th><th style={thNum}>E[r]%</th><th style={thNum}>σ%</th>
                <th style={thNum}>Tangency</th><th style={thNum}>Min-var</th><th style={{ ...th, width: 26 }}></th>
              </tr></thead>
              <tbody>
                {assets.map((a, i) => (
                  <tr key={i}>
                    <td style={td}>
                      <span style={{ width: 8, height: 8, background: PALETTE[i % PALETTE.length], display: "inline-block", marginRight: 8 }} />
                      <TickerInput value={a.name} width={112}
                        onChange={(v) => setAsset(i, "name", v.toUpperCase())}
                        onSelect={(r) => setAssets(assets.map((x, k) => (k === i ? { ...x, name: r.t, er: erFromVol(r.vol), sigma: r.vol } : x)))} />
                    </td>
                    <td style={{ ...td, textAlign: "right" }}><Field value={a.er} onChange={(v) => setAsset(i, "er", v)} w={50} /></td>
                    <td style={{ ...td, textAlign: "right" }}><Field value={a.sigma} onChange={(v) => setAsset(i, "sigma", v)} w={50} /></td>
                    <td style={{ ...numTd(base ? base.tan.w[i] : 0), fontWeight: 700 }}>{base ? pct(base.tan.w[i]) : "—"}</td>
                    <td style={numTd(base ? base.minv.w[i] : 0)}>{base ? pct(base.minv.w[i]) : "—"}</td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>
                      <span onClick={() => runBrief(a.name)} title={isPro ? "Recent coverage" : "Pro feature"}
                        style={{ cursor: "pointer", color: T.steel, fontSize: 11, fontWeight: 700, marginRight: 10 }}>NEWS</span>
                      <span onClick={() => removeAsset(i)} style={{ cursor: "pointer", color: T.faint }}>✕</span>
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
                  <Tooltip formatter={(v) => pct(v)} contentStyle={{ background: T.band, border: `1px solid ${T.ruleDark}`, borderRadius: 3, fontSize: 12, color: T.ink }} />
                </PieChart>
              </ResponsiveContainer>
              <div style={{ ...label, fontSize: 9 }}>Tangency allocation (long weights)</div>
            </div>
          )}
        </div>
      </Panel>

      {base && chart && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 0, border: `1px solid ${T.rule}`, borderTop: `3px solid ${T.green}`, marginBottom: 16, background: T.band }}>
            {[
              { l: "Tangency E[r]", v: pct(base.tan.ret) },
              { l: "Tangency σ", v: pct(base.tan.sigma) },
              { l: "Sharpe", v: num(base.tan.sharpe) },
              { l: "Min-var σ", v: pct(base.minv.sigma) },
              { l: `y* (A=${A})`, v: pct(chart.yStar, 0) },
            ].map((k, i, arr) => (
              <div key={i} style={{ padding: "12px 14px", borderRight: i < arr.length - 1 ? `1px solid ${T.rule}` : "none" }}>
                <div style={{ ...label, fontSize: 9 }}>{k.l}</div>
                <div style={{ fontFamily: T.mono, fontVariantNumeric: "tabular-nums", fontSize: 20, fontWeight: 800, color: T.ink }}>{k.v}</div>
              </div>
            ))}
          </div>

          <Panel title="Efficient frontier · Capital allocation line">
            <ResponsiveContainer width="100%" height={300}>
              <ComposedChart margin={{ top: 8, right: 16, bottom: 6, left: -6 }}>
                <CartesianGrid stroke={T.rule} />
                <XAxis type="number" dataKey="x" unit="%" domain={[0, "auto"]} tick={{ fontSize: 11, fill: T.sub }} stroke={T.ruleDark} />
                <YAxis type="number" dataKey="y" unit="%" tick={{ fontSize: 11, fill: T.sub }} stroke={T.ruleDark} />
                <Tooltip formatter={(v) => `${Number(v).toFixed(2)}%`} contentStyle={{ background: T.band, border: `1px solid ${T.ruleDark}`, borderRadius: 3, fontSize: 12, color: T.ink }} />
                <Scatter data={chart.frontier} fill={T.green} line={{ stroke: T.green, strokeWidth: 2 }} shape={() => null} />
                <Scatter data={chart.cal} fill={T.steel} line={{ stroke: T.steel, strokeWidth: 1.3, strokeDasharray: "5 4" }} shape={() => null} />
                <Scatter data={chart.assetPts} fill={T.faint} />
                <Scatter data={[{ x: base.tan.sigma * 100, y: base.tan.ret * 100 }]} fill={T.steel} />
                <Scatter data={[{ x: base.minv.sigma * 100, y: base.minv.ret * 100 }]} fill={T.copper} />
                <Scatter data={[{ x: chart.complete.sigma * 100, y: chart.complete.ret * 100 }]} fill={T.ink} />
              </ComposedChart>
            </ResponsiveContainer>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 6 }}>
              {[{ c: T.green, t: "Frontier" }, { c: T.steel, t: "CAL / Tangency" }, { c: T.copper, t: "Min-variance" }, { c: T.ink, t: "Complete portfolio" }, { c: T.faint, t: "Assets" }].map((k, i) => (
                <span key={i} style={{ fontSize: 11, color: T.sub, display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 9, height: 9, background: k.c }} />{k.t}
                </span>
              ))}
            </div>
          </Panel>

          <Panel title="Monte Carlo wealth simulation · 500 paths"
            right={
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <label style={{ fontSize: 11.5, color: T.sub, display: "flex", gap: 5, alignItems: "center" }}>Start $<Field value={mcStart} onChange={setMcStart} w={72} /></label>
                <label style={{ fontSize: 11.5, color: T.sub, display: "flex", gap: 5, alignItems: "center" }}>Years<Field value={mcYears} onChange={(v) => setMcYears(Math.max(1, Math.min(40, Math.round(v))))} w={44} /></label>
                <Btn small onClick={() => setMcSeed(mcSeed + 1)}>Re-run</Btn>
              </div>
            }>
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
                    <Tooltip formatter={(v, name2) => [money(v), { p5: "5th pct", p25: "25th pct", p50: "Median", p75: "75th pct", p95: "95th pct" }[name2] || name2]} contentStyle={{ background: T.band, border: `1px solid ${T.ruleDark}`, borderRadius: 3, fontSize: 12, color: T.ink }} />
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

          <Panel title={`Correlation lab${!isPro ? " · Pro" : ""}`}
            right={!isPro && <Btn small primary onClick={() => setShowPaywall(true)}>Unlock</Btn>}>
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
                          const heat = i === j ? T.band : v >= 0 ? `rgba(46,189,133,${0.08 + v * 0.38})` : `rgba(76,154,255,${0.08 + Math.abs(v) * 0.38})`;
                          return (
                            <td key={j} style={{ ...td, padding: 3 }}>
                              {j < i ? <div style={{ width: 52, height: 30, background: heat, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontVariantNumeric: "tabular-nums", color: T.ink }}>{v.toFixed(2)}</div>
                                : j === i ? <div style={{ width: 52, height: 30, background: T.band, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: T.faint }}>1.00</div>
                                : <div style={{ width: 52 }}><Field value={corr[i][j]} onChange={(vv) => setRho(i, j, vv)} w={52} /></div>}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ fontSize: 11, color: T.faint, marginTop: 8 }}>Edit the upper triangle · heatmap mirrors below (green positive, blue negative)</div>
              </div>
            ) : (
              <div style={{ fontSize: 13, color: T.faint }}>Edit every pairwise correlation and see the matrix as a live heatmap.</div>
            )}
          </Panel>

          <Panel title="Quantitative diagnostics">
            {qInsights.map((q, i) => (
              <div key={i} style={{ display: "flex", gap: 14, marginBottom: 10, paddingBottom: 10, borderBottom: i < qInsights.length - 1 ? `1px solid ${T.rule}` : "none" }}>
                <span style={{ ...label, fontSize: 9, minWidth: 100, paddingTop: 2, color: T.green }}>{q.tag}</span>
                <span style={{ fontSize: 13, lineHeight: 1.6, color: "#C7D1DB" }}>{q.text}</span>
              </div>
            ))}
          </Panel>

          {/* AI OBSERVATIONS — safeguarded */}
          <Panel title={`AI observations${!isPro ? " · Pro" : ""}`}
            right={<Btn small primary onClick={runAiInsights}>{aiLoading ? "Analyzing…" : isPro ? "Generate" : "Unlock"}</Btn>} band>
            <div style={{ background: T.paper, border: `1px solid ${T.rule}`, padding: "8px 12px", marginBottom: 14, fontSize: 11.5, color: T.sub, lineHeight: 1.55 }}>
              <b style={{ color: T.ink }}>Descriptive only.</b> These are machine-generated observations about the model's inputs and outputs — labeled as strengths, considerations, or flags. They are screened by an advice-language filter before display, contain no recommendations, and are not investment advice. Company characteristics beyond the numbers you entered may be imprecise; verify independently.
            </div>
            {aiError && <div style={{ fontSize: 13, color: T.red }}>{aiError}</div>}
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
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@600;800&family=IBM+Plex+Mono:wght@500;600&family=Inter:wght@400;500;600;700&display=swap');
        input[type=range]{accent-color:${T.green};} input[type=checkbox]{accent-color:${T.green};}
        select:focus, input:focus{border-color:${T.green} !important;}`}</style>
      {showPaywall && Paywall()}
      {showCheckout && Checkout()}
      {briefTicker && (
        <div onClick={() => setBriefTicker(null)} style={{ position: "fixed", inset: 0, background: "rgba(6,10,14,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 55, padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: T.paper, border: `1px solid ${T.ruleDark}`, borderTop: `4px solid ${T.steel}`, maxWidth: 560, width: "100%", maxHeight: "80vh", overflowY: "auto", padding: 22 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
              <h2 style={{ fontFamily: T.disp, fontSize: 19, fontWeight: 800, margin: 0, color: T.ink }}>
                {briefTicker} <span style={{ fontSize: 12, fontWeight: 600, color: T.sub }}>· security brief</span>
              </h2>
              <span onClick={() => setBriefTicker(null)} style={{ cursor: "pointer", color: T.faint, fontSize: 15 }}>✕</span>
            </div>
            <div style={{ fontSize: 11, color: T.faint, marginBottom: 14 }}>Recent coverage, summarized factually. Descriptive only — verify independently.</div>
            {briefLoading && <div style={{ fontSize: 13, color: T.sub }}>Searching recent coverage…</div>}
            {briefErr && <div style={{ fontSize: 13, color: T.red }}>{briefErr}</div>}
            {briefData && briefData.items.map((it, i) => (
              <div key={i} style={{ marginBottom: 13, paddingBottom: 13, borderBottom: `1px solid ${T.rule}` }}>
                <div style={{ marginBottom: 4 }}>
                  <span style={{ fontFamily: T.ui, fontSize: 9.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", background: "rgba(76,154,255,0.14)", color: T.steel, padding: "3px 8px", borderRadius: 2, marginRight: 8 }}>{it.category}</span>
                  <span style={{ fontFamily: T.disp, fontSize: 13.5, fontWeight: 800, color: T.ink }}>{it.title}</span>
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.6, color: "#C7D1DB" }}>{it.note}</div>
              </div>
            ))}
            {briefData && briefData.modelNote && (
              <div style={{ background: T.band, border: `1px solid ${T.rule}`, padding: "10px 12px", fontSize: 12.5, lineHeight: 1.6, color: T.ink }}>
                <span style={{ ...label, fontSize: 9, color: T.copper, display: "block", marginBottom: 4 }}>Relevance to your inputs</span>
                {briefData.modelNote}
              </div>
            )}
          </div>
        </div>
      )}

      <div style={{ borderBottom: `1px solid ${T.ruleDark}`, background: T.paper, position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ maxWidth: 1040, margin: "0 auto", padding: "0 16px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 52 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            <span onClick={() => setView("landing")} style={{ fontFamily: T.disp, fontWeight: 800, fontSize: 16, letterSpacing: "0.01em", cursor: "pointer", color: T.ink }}>
              FRONTIER <span style={{ color: T.green }}>X</span>
            </span>
            {view === "app" && (
              <div style={{ display: "flex", border: `1px solid ${T.ruleDark}` }}>
                {[["basic", "Basic"], ["advanced", "Advanced"]].map(([m, t]) => (
                  <button key={m} onClick={() => setMode(m)}
                    style={{ fontFamily: T.ui, fontSize: 12, fontWeight: 700, padding: "5px 14px", cursor: "pointer", border: "none", background: mode === m ? T.green : T.surface, color: mode === m ? "#07130E" : T.sub }}>
                    {t}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {view === "landing" && <span onClick={() => setView("app")} style={{ fontSize: 12.5, fontWeight: 700, color: T.sub, cursor: "pointer" }}>Workspace</span>}
            <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: "0.1em", color: isAdv ? T.green : T.sub, border: `1px solid ${isAdv ? T.green : T.rule}`, padding: "3px 9px" }}>
              {plan.toUpperCase()}
            </span>
            {!isPro && <Btn small primary onClick={() => setShowPaywall(true)}>Upgrade</Btn>}
          </div>
        </div>
      </div>

      {view === "landing" ? Landing() : mode === "basic" ? BasicMode() : AdvancedMode()}
    </div>
  );
}
