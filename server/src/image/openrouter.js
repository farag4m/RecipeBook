// Preferred renderer: OpenRouter fronts the same Gemini/OpenAI image models,
// so one key covers both the panel writing and the painting.

const MODEL = process.env.OPENROUTER_IMAGE_MODEL || "google/gemini-3.1-flash-image";

export function available(){
  return Boolean(process.env.OPENROUTER_API_KEY);
}

export async function generate({ prompt }){
  const key = process.env.OPENROUTER_API_KEY;
  if(!key) throw new Error("OPENROUTER_API_KEY is not set");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.PUBLIC_URL || "https://family-recipe-box.onrender.com",
      "X-Title": "The Family Recipe Box"
    },
    body: JSON.stringify({
      model: MODEL,
      // Sent explicitly: OpenRouter rejects requests whose default max_tokens
      // exceeds what the account balance can cover.
      max_tokens: Number(process.env.OPENROUTER_IMAGE_MAX_TOKENS || 8000),
      modalities: ["image", "text"],
      messages: [{ role: "user", content: prompt }]
    }),
    signal: AbortSignal.timeout(Number(process.env.IMAGE_TIMEOUT_MS || 180000))
  });

  if(!res.ok){
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenRouter image ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  if(data.error) throw new Error(`OpenRouter image: ${JSON.stringify(data.error).slice(0, 300)}`);

  const images = data?.choices?.[0]?.message?.images || [];
  const first = images[0];
  const url = typeof first === "string" ? first : first?.image_url?.url;
  if(!url) throw new Error("OpenRouter returned no image data");

  const match = /^data:([^;]+);base64,(.+)$/s.exec(url);
  if(!match) throw new Error("OpenRouter returned an unexpected image payload");

  return { provider: "openrouter", mime: match[1], base64: match[2] };
}
