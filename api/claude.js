export default async function handler(req, res) {
  try { return await main(req, res); }
  catch (e) { return res.status(200).json({ crashed: true, message: String(e && e.message) }); }
}
async function main(req, res) {
  const key = process.env.GEMINI_API_KEY || "";
  const getParam = (name) => {
    try { return new URL(req.url, "http://x").searchParams.get(name) || ""; }
    catch (e) { return ""; }
  };
  const tfetch = async (url, opts, ms) => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    try {
      const r = await fetch(url, { ...(opts || {}), signal: c.signal });
      const raw = await r.text();
      clearTimeout(t);
      return { status: r.status, raw };
    } catch (e) { clearTimeout(t); return { status: 0, raw: "" }; }
  };
  const call = (payload) =>
    tfetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
      { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(payload) },
      20000
    );
  const extract = (raw) => {
    try {
      const data = JSON.parse(raw);
      return ((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [])
        .map((p) => p.text || "").join("");
    } catch (e) { return ""; }
  };
  const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const isCad = (s) => /\.(TO|V|NE|CN)$/i.test(s);
  const weeklyClosesOnce = async (sym) => {
    const r = await tfetch(
      "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(sym) + "?range=5y&interval=1wk",
      { headers: { "user-agent": "Mozilla/5.0" } }, 7000
    );
    try {
      const d = JSON.parse(r.raw);
      const res0 = d.chart.result[0];
      const ts = res0.timestamp || [];
      let cl = null;
      try { cl = res0.indicators.adjclose[0].adjclose; } catch (e) { cl = null; }
      if (!cl) cl = res0.indicators.quote[0].close || [];
      const map = {};
      for (let i = 0; i < ts.length; i++) if (cl[i] != null) map[Math.floor(ts[i] / 604800)] = cl[i];
      return Object.keys(map).length ? map : null;
    } catch (e) { return null; }
  };
  // One retry: a transient Yahoo/network failure on one symbol shouldn't
  // permanently blank that asset's CAPM inputs for the whole session.
  const weeklyCloses = async (sym) => (await weeklyClosesOnce(sym)) || (await weeklyClosesOnce(sym));
  const stats = (arr) => {
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    const v = arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (arr.length - 1);
    return { mean: m, sd: Math.sqrt(v), varr: v };
  };
  const clean = (s) =>
    s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&")
     .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;.*?&gt;/g, "").trim();
  const parseRss = (xml, cap) => {
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) && items.length < cap) {
      const block = m[1];
      const t = /<title>([\s\S]*?)<\/title>/.exec(block);
      const d = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(block);
      const l = /<link>([\s\S]*?)<\/link>/.exec(block);
      if (t) items.push({
        title: clean(t[1]),
        date: d ? d[1].trim().split(" ").slice(0, 4).join(" ") : "",
        url: l ? clean(l[1]) : "",
      });
    }
    return items;
  };
  const fetchHeadlines = async (ticker) => {
    const feeds = [
      "https://news.google.com/rss/search?q=" + encodeURIComponent('"' + ticker + '" stock') + "&hl=en-CA&gl=CA&ceid=CA:en",
      "https://feeds.finance.yahoo.com/rss/2.0/headline?s=" + encodeURIComponent(ticker) + "&region=US&lang=en-US",
      "https://www.bing.com/news/search?q=" + encodeURIComponent(ticker + " stock") + "&format=rss",
    ];
    for (const url of feeds) {
      const r = await tfetch(url, { headers: { "user-agent": "Mozilla/5.0" } }, 6000);
      if (r.status === 200) {
        const items = parseRss(r.raw, 5);
        if (items.length) return items;
      }
    }
    return [];
  };
  if (req.method === "GET") {
    const csv = getParam("corr");
    if (csv) {
      const syms = csv.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 30);
      const anyCad = syms.some(isCad), anyUsd = syms.some((x) => !isCad(x));
      const mixed = anyCad && anyUsd;
      const BENCH = mixed ? "XEQT.TO" : (anyCad ? "XIC.TO" : "SPY");
      const maps = await Promise.all(syms.map((x) => weeklyCloses(x)));
      let fx = null;
      if (mixed) fx = await weeklyCloses("CAD=X");
      if (mixed && fx) {
        for (let i = 0; i < syms.length; i++) {
          if (maps[i] && !isCad(syms[i])) {
            const conv = {};
            for (const k of Object.keys(maps[i])) if (fx[k] != null) conv[k] = maps[i][k] * fx[k];
            maps[i] = Object.keys(conv).length ? conv : null;
          }
        }
      }
      const bench = await weeklyCloses(BENCH);
      const ok = maps.map((m) => m != null);
      const sortedKeys = (m) => Object.keys(m).sort((a, b) => Number(a) - Number(b));
      const retsAt = (m, keys) => {
        const out = [];
        for (let i = 1; i < keys.length; i++) out.push(Math.log(m[keys[i]] / m[keys[i - 1]]));
        return out;
      };
      // Each asset's own volatility depends only on its own history — never on
      // another asset's data availability or the benchmark's.
      const ownRets = maps.map((m) => {
        if (!m) return null;
        const ks = sortedKeys(m);
        return ks.length >= 11 ? retsAt(m, ks) : null;
      });
      const vols = ownRets.map((r) => (r ? Math.max(5, Math.min(150, Math.round(stats(r).sd * Math.sqrt(52) * 100))) : null));
      // Beta uses only the overlap between that one asset and the benchmark —
      // one thin-history asset elsewhere in the batch can no longer zero out
      // every other asset's beta (and therefore CAPM E[r]).
      let betas = syms.map(() => null);
      let benchPoints = 0;
      if (bench) {
        const benchKeys = new Set(Object.keys(bench));
        betas = maps.map((m) => {
          if (!m) return null;
          const common = sortedKeys(m).filter((k) => benchKeys.has(k));
          if (common.length < 13) return null;
          const ra = retsAt(m, common), rb = retsAt(bench, common);
          benchPoints = Math.max(benchPoints, ra.length);
          const sa = stats(ra), sb = stats(rb);
          let cov = 0;
          for (let k = 0; k < ra.length; k++) cov += (ra[k] - sa.mean) * (rb[k] - sb.mean);
          cov /= (ra.length - 1);
          const b = cov / sb.varr;
          return isFinite(b) ? Math.round(Math.max(-1, Math.min(4, b)) * 100) / 100 : null;
        });
      }
      // Correlation between any pair uses only that pair's own overlap, not a
      // single intersection forced across the whole portfolio.
      const n = syms.length;
      const keySets = maps.map((m) => (m ? new Set(Object.keys(m)) : null));
      const corr = [];
      for (let i = 0; i < n; i++) {
        corr.push([]);
        for (let j = 0; j < n; j++) {
          if (i === j) { corr[i].push(1); continue; }
          if (!maps[i] || !maps[j]) { corr[i].push(null); continue; }
          const common = sortedKeys(maps[i]).filter((k) => keySets[j].has(k));
          if (common.length < 13) { corr[i].push(null); continue; }
          const a = retsAt(maps[i], common), b = retsAt(maps[j], common);
          const sa = stats(a), sb2 = stats(b);
          let cov = 0;
          for (let k = 0; k < a.length; k++) cov += (a[k] - sa.mean) * (b[k] - sb2.mean);
          cov /= (a.length - 1);
          const c = cov / (sa.sd * sb2.sd);
          corr[i].push(isFinite(c) ? Math.max(-0.99, Math.min(0.99, c)) : null);
        }
      }
      const notes = [];
      if (mixed && !fx) notes.push("USD/CAD rate unavailable — figures use each holding's native currency.");
      if (!bench) notes.push("Benchmark (" + BENCH + ") data unavailable — betas could not be computed this round.");
      return res.status(200).json({
        points: benchPoints, vols, betas, corr,
        benchmark: BENCH,
        currency: mixed ? (fx ? "CAD (USD holdings converted)" : "mixed, unconverted") : (anyCad ? "CAD" : "USD"),
        missing: syms.filter((s, i) => !ok[i]),
        ...(notes.length ? { note: notes.join(" ") } : {}),
      });
    }
    const cap = getParam("capm");
    if (cap) {
      const [m, bm] = await Promise.all([weeklyCloses(cap), weeklyCloses(/\.(TO|V|NE|CN)$/i.test(cap) ? "XIC.TO" : "SPY")]);
      if (!m) return res.status(200).json({ vol: null, beta: null });
      const ks = Object.keys(m).sort((a, b) => Number(a) - Number(b));
      const r2 = [];
      for (let i = 1; i < ks.length; i++) r2.push(Math.log(m[ks[i]] / m[ks[i - 1]]));
      if (r2.length < 10) return res.status(200).json({ vol: null, beta: null });
      const sd = stats(r2).sd;
      const vol = Math.max(5, Math.min(150, Math.round(sd * Math.sqrt(52) * 100)));
      let beta = null;
      if (bm) {
        const common = ks.filter((k) => bm[k] != null);
        if (common.length > 12) {
          const ra = [], rb = [];
          for (let i = 1; i < common.length; i++) {
            ra.push(Math.log(m[common[i]] / m[common[i - 1]]));
            rb.push(Math.log(bm[common[i]] / bm[common[i - 1]]));
          }
          const sa = stats(ra), sb = stats(rb);
          let cov = 0;
          for (let k = 0; k < ra.length; k++) cov += (ra[k] - sa.mean) * (rb[k] - sb.mean);
          cov /= (ra.length - 1);
          const b = cov / sb.varr;
          if (isFinite(b)) beta = Math.round(Math.max(-1, Math.min(4, b)) * 100) / 100;
        }
      }
      return res.status(200).json({ vol, beta });
    }
    /* ── FUNDAMENTALS: reported financials for a DCF ──────────────────
       Two Yahoo sources. fundamentals-timeseries carries the annual
       statement lines; quoteSummary carries price/share/multiple data but
       is crumb-gated, so we fall back to the (never-gated) chart endpoint
       for price when the crumb handshake fails. Everything returned here
       is *reported history* — no projections are made server-side. */
    const fsym = getParam("fund");
    if (fsym) {
      const sym = fsym.toUpperCase().trim();
      const nowS = Math.floor(Date.now() / 1000);
      const p1 = nowS - 12 * 365 * 24 * 3600;

      const TS_KEYS = [
        "TotalRevenue", "OperatingIncome", "EBIT", "EBITDA", "NetIncome",
        "PretaxIncome", "TaxProvision", "TaxRateForCalcs",
        "ReconciledDepreciation", "DepreciationAndAmortization",
        "CapitalExpenditure", "ChangeInWorkingCapital", "FreeCashFlow",
        "OperatingCashFlow", "InterestExpense", "TotalDebt",
        "CashAndCashEquivalents", "CashCashEquivalentsAndShortTermInvestments",
        "StockholdersEquity", "OrdinarySharesNumber", "InvestedCapital",
        "CurrentAssets", "CurrentLiabilities", "NetPPE",
      ];
      const types = TS_KEYS.map((k) => "annual" + k).join(",");
      const tsUrl = "https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/" +
        encodeURIComponent(sym) + "?symbol=" + encodeURIComponent(sym) +
        "&type=" + types + "&period1=" + p1 + "&period2=" + nowS + "&merge=false";

      // Crumb handshake: cookie from fc.yahoo.com, then trade it for a crumb.
      const getCrumb = async () => {
        try {
          const c = await fetch("https://fc.yahoo.com", { headers: { "user-agent": UA } });
          const setC = c.headers.get("set-cookie") || "";
          const cookie = setC.split(",").map((s) => s.split(";")[0]).filter(Boolean).join("; ");
          if (!cookie) return null;
          const cr = await tfetch(
            "https://query1.finance.yahoo.com/v1/test/getcrumb",
            { headers: { "user-agent": UA, cookie } }, 6000
          );
          if (cr.status !== 200 || !cr.raw || cr.raw.length > 40) return null;
          return { crumb: cr.raw, cookie };
        } catch (e) { return null; }
      };

      const [tsRes, auth, chart] = await Promise.all([
        tfetch(tsUrl, { headers: { "user-agent": UA } }, 9000),
        getCrumb(),
        tfetch(
          "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(sym) + "?range=1mo&interval=1d",
          { headers: { "user-agent": UA } }, 7000
        ),
      ]);

      // ── annual statement lines → { key: [{year, v}] }
      const series = {};
      try {
        const rows = JSON.parse(tsRes.raw).timeseries.result || [];
        for (const row of rows) {
          const t = (row.meta && row.meta.type && row.meta.type[0]) || "";
          if (!t) continue;
          const short = t.replace(/^annual/, "");
          const pts = [];
          for (const p of (row[t] || [])) {
            if (!p || p.reportedValue == null) continue;
            const v = Number(p.reportedValue.raw);
            const yr = Number(String(p.asOfDate || "").slice(0, 4));
            if (isFinite(v) && isFinite(yr)) pts.push({ year: yr, v });
          }
          pts.sort((a, b) => a.year - b.year);
          if (pts.length) series[short] = pts;
        }
      } catch (e) { /* series stays empty; handled below */ }

      // ── price (chart meta is the reliable floor)
      let price = null, currency = null, name = null;
      try {
        const meta = JSON.parse(chart.raw).chart.result[0].meta;
        price = Number(meta.regularMarketPrice);
        currency = meta.currency || null;
        name = meta.longName || meta.shortName || sym;
      } catch (e) { /* leave null */ }

      // ── quote/multiple data (best-effort, crumb-gated)
      let q2 = {};
      if (auth) {
        const mods = "financialData,defaultKeyStatistics,summaryDetail,price,summaryProfile";
        const qs = await tfetch(
          "https://query1.finance.yahoo.com/v10/finance/quoteSummary/" + encodeURIComponent(sym) +
          "?modules=" + mods + "&crumb=" + encodeURIComponent(auth.crumb),
          { headers: { "user-agent": UA, cookie: auth.cookie } }, 9000
        );
        try {
          const r0 = JSON.parse(qs.raw).quoteSummary.result[0] || {};
          const num = (x) => (x && typeof x.raw === "number" && isFinite(x.raw) ? x.raw : null);
          const fd = r0.financialData || {}, ks = r0.defaultKeyStatistics || {},
            sd = r0.summaryDetail || {}, pr = r0.price || {}, sp = r0.summaryProfile || {};
          q2 = {
            marketCap: num(pr.marketCap) ?? num(sd.marketCap),
            shares: num(ks.sharesOutstanding),
            beta: num(ks.beta) ?? num(sd.beta),
            trailingPE: num(sd.trailingPE), forwardPE: num(sd.forwardPE),
            priceToBook: num(ks.priceToBook),
            enterpriseValue: num(ks.enterpriseValue),
            evToEbitda: num(ks.enterpriseToEbitda), evToRevenue: num(ks.enterpriseToRevenue),
            pegRatio: num(ks.pegRatio),
            dividendYield: num(sd.dividendYield),
            totalCash: num(fd.totalCash), totalDebt: num(fd.totalDebt),
            ebitda: num(fd.ebitda), revenue: num(fd.totalRevenue),
            operatingMargin: num(fd.operatingMargins), profitMargin: num(fd.profitMargins),
            returnOnEquity: num(fd.returnOnEquity),
            revenueGrowth: num(fd.revenueGrowth), earningsGrowth: num(fd.earningsGrowth),
            targetMean: num(fd.targetMeanPrice),
            sector: sp.sector || null, industry: sp.industry || null,
          };
          if (!name && pr.longName) name = pr.longName;
          if (!currency && pr.currency) currency = pr.currency;
          if (price == null) price = num(pr.regularMarketPrice);
        } catch (e) { q2 = {}; }
      }

      // shares fallback from the balance-sheet line when quoteSummary is gated
      if (q2.shares == null && series.OrdinarySharesNumber && series.OrdinarySharesNumber.length) {
        q2.shares = series.OrdinarySharesNumber[series.OrdinarySharesNumber.length - 1].v;
      }
      if (q2.marketCap == null && q2.shares && price) q2.marketCap = q2.shares * price;

      const haveStatements = !!(series.TotalRevenue && series.TotalRevenue.length >= 2);
      const notes = [];
      if (!haveStatements) notes.push("Annual statement data unavailable for " + sym + " — funds, ETFs and some non-US listings do not report company financials.");
      if (!auth) notes.push("Yahoo quote-detail feed was gated this round; multiples were computed from statement data where possible.");

      return res.status(200).json({
        symbol: sym, name: name || sym, currency: currency || "USD",
        price, quote: q2, series, haveStatements,
        notes: notes.length ? notes : undefined,
      });
    }

    const q = getParam("search");
    if (q) {
      const r = await tfetch(
        "https://query1.finance.yahoo.com/v1/finance/search?q=" + encodeURIComponent(q) + "&quotesCount=8&newsCount=0",
        { headers: { "user-agent": "Mozilla/5.0" } }, 6000
      );
      try {
        const data = JSON.parse(r.raw);
        const out = (data.quotes || [])
          .filter((x) => x.symbol && (x.quoteType === "EQUITY" || x.quoteType === "ETF"))
          .map((x) => ({
            t: x.symbol,
            n: x.shortname || x.longname || x.symbol,
            sec: (x.exchDisp || x.exchange || "") + (x.quoteType === "ETF" ? " · ETF" : ""),
            vol: null,
          }));
        return res.status(200).json({ results: out });
      } catch (e) { return res.status(200).json({ results: [] }); }
    }
    const v = getParam("vol");
    if (v) {
      const m = await weeklyCloses(v);
      if (!m) return res.status(200).json({ vol: null });
      const keys = Object.keys(m).sort((a, b) => Number(a) - Number(b));
      if (keys.length < 10) return res.status(200).json({ vol: null });
      const r2 = [];
      for (let i = 1; i < keys.length; i++) r2.push(Math.log(m[keys[i]] / m[keys[i - 1]]));
      return res.status(200).json({ vol: Math.max(5, Math.min(150, Math.round(stats(r2).sd * Math.sqrt(52) * 100))) });
    }
    const out = await call({ contents: [{ parts: [{ text: "Say OK" }] }] });
    return res.status(200).json({ keyFound: key.length > 0, googleStatus: out.status });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const body = req.body || {};
  const userText = (body.messages && body.messages[0] && body.messages[0].content) || "";
  const wantsNews = Array.isArray(body.tools) && body.tools.length > 0;
  if (wantsNews) {
    const tm = userText.match(/ticker\s+([A-Za-z0-9.\-]+)/);
    const ticker = tm ? tm[1] : "";
    const heads = ticker ? await fetchHeadlines(ticker) : [];
    if (!heads.length) return res.status(500).json({ error: "No coverage found" });
    const text = JSON.stringify({
      items: heads.map((h) => ({
        category: "Coverage", title: h.title,
        note: "Published " + (h.date || "recently") + ".", url: h.url,
      })),
      modelNote: "Headline volume and recency for this holding are generally relevant to the volatility assumption entered in the model.",
    });
    return res.status(200).json({ content: [{ type: "text", text }] });
  }
  const out = await call({ contents: [{ parts: [{ text: userText }] }] });
  let text = extract(out.raw);
  if (text) {
    const s = text.indexOf("{");
    const e2 = text.lastIndexOf("}");
    if (s >= 0 && e2 > s) text = text.slice(s, e2 + 1);
  }
  if (!text) return res.status(500).json({ error: "Upstream error" });
  return res.status(200).json({ content: [{ type: "text", text }] });
}
