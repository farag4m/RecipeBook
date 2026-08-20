// Keyless renderer so a fresh deploy produces real art with only a Groq key.
// Lower fidelity than Gemini - used when no image credentials are present.

export function available(){
  return process.env.ENABLE_POLLINATIONS !== "false";
}

export async function generate({ prompt, seed = 1, width = 1440, height = 576 }){
  const url =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.slice(0, 1800))}` +
    `?width=${width}&height=${height}&seed=${seed}&nologo=true&safe=false`;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(Number(process.env.IMAGE_TIMEOUT_MS || 120000))
  });
  if(!res.ok) throw new Error(`Pollinations ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  if(buffer.length < 1024) throw new Error("Pollinations returned an empty image");

  return {
    provider: "pollinations",
    mime: res.headers.get("content-type") || "image/jpeg",
    base64: buffer.toString("base64")
  };
}
