export default async function handler(req, res) {
  try {
    return await main(req, res);
  } catch (e) {
    return res.status(200).json({ crashed: true, message: String(e && e.message) });
  }
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
  const weeklyCloses = async (sym) => {
    const r = await tfetch(
      "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(sym) + "?range=1y&interval=1wk",
      { headers: { "user-agent": "Mozilla/5.0" } }, 7000
    );
    try {
      const d = JSON.parse(r.raw);
      const res0 = d.chart.result[0];
      const ts = res0.timestamp || [];
      const cl = res0.indicators.quote[0].close || [];
      const map = {};
      for (let i = 0; i < ts.length; i++) {
        if (cl[i] != null) map[Math.floor(ts[i] / 604800)] = cl[i];
      }
      return Object.keys(map).length ? map : null;
    } catch (e) { return null; }
  };
  const stdev = (arr) => {
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    const v = arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (arr.length - 1);
    return { mean: m, sd: Math.sqrt(v) };
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
      const syms = csv.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 10);
      const maps = [];
      for (const s of syms) maps.push(await weeklyCloses(s));
      const ok = maps.map((m) => m != null);
      const weekSets = maps.filter((m) => m).map((m) => Object.keys(m));
      let common = weekSets.length ? weekSets[0] : [];
      for (const ws of weekSets) common = common.filter((k) => ws.indexOf(k) >= 0);
      common.sort((a, b) => Number(a) - Number(b));
      if (common.length < 15) {
        return res.status(200).json({ note: "Not enough overlapping price history.", points: common.length, vols: syms.map(() => null), corr: null });
      }
      const rets = maps.map((m) => {
        if (!m) return null;
        const out = [];
        for (let i = 1; i < common.length; i++) out.push(Math.log(m[common[i]] / m[common[i - 1]]));
        return out;
      });
      const vols = rets.map((r) => {
        if (!r) return null;
        return Math.max(5, Math.min(150, Math.round(stdev(r).sd * Math.sqrt(52) * 100)));
      });
      const n = syms.length;
      const corr = [];
      for (let i = 0; i < n; i++) {
        corr.push([]);
        for (let j = 0; j < n; j++) {
          if (i === j) { corr[i].push(1); continue; }
          if (!rets[i] || !rets[j]) { corr[i].push(null); continue; }
          const a = rets[i], b = rets[j];
          const sa = stdev(a), sb = stdev(b);
          let cov = 0;
          for (let k = 0; k < a.length; k++) cov += (a[k] - sa.mean) * (b[k] - sb.mean);
          cov /= (a.length - 1);
          const c = cov / (sa.sd * sb.sd);
          corr[i].push(isFinite(c) ? Math.max(-0.99, Math.min(0.99, c)) : null);
        }
      }
      return res.status(200).json({
        points: common.length - 1,
        vols, corr,
        missing: syms.filter((s, i) => !ok[i]),
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
      const sd = stdev(r2).sd;
      return res.status(200).json({ vol: Math.max(5, Math.min(150, Math.round(sd * Math.sqrt(52) * 100))) });
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
