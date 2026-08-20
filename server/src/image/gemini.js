// Preferred renderer: Google's image model matches the existing hand-painted
// step art most closely. Needs GEMINI_API_KEY (free tier at aistudio.google.com).

const MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";

export function available(){
  return Boolean(process.env.GEMINI_API_KEY);
}

export async function generate({ prompt }){
  const key = process.env.GEMINI_API_KEY;
  if(!key) throw new Error("GEMINI_API_KEY is not set");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal: AbortSignal.timeout(Number(process.env.IMAGE_TIMEOUT_MS || 120000))
    }
  );

  if(!res.ok){
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const image = parts.find(part => part.inlineData?.data || part.inline_data?.data);
  const inline = image?.inlineData || image?.inline_data;
  if(!inline?.data) throw new Error("Gemini returned no image data");

  return {
    provider: "gemini",
    mime: inline.mimeType || inline.mime_type || "image/png",
    base64: inline.data
  };
}
