export default async function handler(req, res) {
  const key = process.env.GEMINI_API_KEY || "";
  const tfetch = async (url, opts, ms) => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    try {
      const r = await fetch(url, { ...(opts || {}), signal: c.signal });
      const raw = await r.text();
      clearTimeout(t);
      return { status: r.status, raw };
    } catch (e) {
      clearTimeout(t);
      return { status: 0, raw: "" };
    }
  };
  const call = (payload) =>
    tfetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(payload),
      },
      20000
    );
  const extract = (raw) => {
    try {
      const data = JSON.parse(raw);
      return ((data.candidates &&
        data.candidates[0] &&
        data.candidates[0].content &&
        data.candidates[0].content.parts) || [])
        .map((p) => p.text || "")
        .join("");
    } catch (e) { return ""; }
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
      if (t) {
        items.push({
          title: clean(t[1]),
          date: d ? d[1].trim().split(" ").slice(0, 4).join(" ") : "",
          url: l ? clean(l[1]) : "",
        });
      }
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
    const out = await call({ contents: [{ parts: [{ text: "Say OK" }] }] });
    return res.status(200).json({ keyFound: key.length > 0, googleStatus: out.status });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const body = req.body || {};
    const userText =
      (body.messages && body.messages[0] && body.messages[0].content) || "";
    const wantsNews = Array.isArray(body.tools) && body.tools.length > 0;
    if (wantsNews) {
      const tm = userText.match(/ticker\s+([A-Za-z0-9.\-]+)/);
      const ticker = tm ? tm[1] : "";
      const heads = ticker ? await fetchHeadlines(ticker) : [];
      if (!heads.length) return res.status(500).json({ error: "No coverage found" });
      const text = JSON.stringify({
        items: heads.map((h) => ({
          category: "Coverage",
          title: h.title,
          note: "Published " + (h.date || "recently") + ".",
          url: h.url,
        })),
        modelNote:
          "Headline volume and recency for this holding are generally relevant to the volatility assumption entered in the model.",
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
  } catch (e) {
    return res.status(500).json({ error: "Upstream error" });
  }
}
