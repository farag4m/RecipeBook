// Optional renderer. Needs OPENAI_API_KEY.

const MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";

export function available(){
  return Boolean(process.env.OPENAI_API_KEY);
}

export async function generate({ prompt, size = "1536x1024" }){
  const key = process.env.OPENAI_API_KEY;
  if(!key) throw new Error("OPENAI_API_KEY is not set");

  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt, size, n: 1 }),
    signal: AbortSignal.timeout(Number(process.env.IMAGE_TIMEOUT_MS || 120000))
  });

  if(!res.ok){
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenAI ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  if(!b64) throw new Error("OpenAI returned no image data");
  return { provider: "openai", mime: "image/png", base64: b64 };
}
