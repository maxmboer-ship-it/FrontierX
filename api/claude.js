export default async function handler(req, res) {
  const key = process.env.GEMINI_API_KEY || "";
  const call = async (payload) => {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
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
  if (req.method === "GET") {
    // self-test: shows exactly what Google says
    const out = await call({ contents: [{ parts: [{ text: "Say OK" }] }] });
    return res.status(200).json({
      keyFound: key.length > 0,
      keyStart: key.slice(0, 6),
      googleStatus: out.status,
      googleSays: out.raw.slice(0, 600),
    });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }
  try {
    const body = req.body || {};
    const userText =
      (body.messages && body.messages[0] && body.messages[0].content) || "";
    const wantsSearch = Array.isArray(body.tools) && body.tools.length > 0;
    const payload = { contents: [{ parts: [{ text: userText }] }] };
    if (wantsSearch) payload.tools = [{ google_search: {} }];
    const out = await call(payload);
    let text = "";
    try {
      const data = JSON.parse(out.raw);
      text = ((data.candidates &&
        data.candidates[0] &&
        data.candidates[0].content &&
        data.candidates[0].content.parts) || [])
        .map((p) => p.text || "")
        .join("");
    } catch (e) {}
    if (!text) return res.status(500).json({ error: "Upstream error" });
    return res.status(200).json({ content: [{ type: "text", text }] });
  } catch (e) {
    return res.status(500).json({ error: "Upstream error" });
  }
}
