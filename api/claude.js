export default async function handler(req, res) {
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
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY,
        },
        body: JSON.stringify(payload),
      }
    );
    const data = await r.json();
    const text = ((data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts) || [])
      .map((p) => p.text || "")
      .join("");
    return res.status(200).json({ content: [{ type: "text", text }] });
  } catch (e) {
    return res.status(500).json({ error: "Upstream error" });
  }
}
