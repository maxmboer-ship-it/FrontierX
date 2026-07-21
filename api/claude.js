export default async function handler(req, res) {
  const key = process.env.GEMINI_API_KEY || "";
  const call = async (payload) => {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": key,
        },
        body: JSON.stringify(payload),
      }
    );
    const raw = await r.text();
    return { status: r.status, raw };
  };
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
  if (req.method === "GET") {
    const out = await call({ contents: [{ parts: [{ text: "Say OK" }] }] });
    return res.status(200).json({ keyFound: key.length > 0, googleStatus: out.status });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const body = req.body || {};
    const userText =
      (body.messages && body.messages[0] && body.messages[0].content) || "";
    const wantsSearch = Array.isArray(body.tools) && body.tools.length > 0;
    const contents = [{ parts: [{ text: userText }] }];
    let out = wantsSearch
      ? await call({ contents, tools: [{ google_search: {} }] })
      : await call({ contents });
    let text = extract(out.raw);
    if ((!text || out.status !== 200) && wantsSearch) {
      out = await call({ contents });
      text = extract(out.raw);
    }
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
