// Cloudflare Workers AI - the only provider here with a genuinely free image
// tier, so it takes precedence when configured.
//
// Model note: flux-1-schnell is fast but low fidelity (white grounds, weak
// hands). leonardo/lucid-origin honours the cream ground, the ink gutters and
// an explicit wide aspect, so it is the default.

const MODEL = process.env.CLOUDFLARE_IMAGE_MODEL || "@cf/leonardo/lucid-origin";

// Diffusion models leak stray captions and page furniture unless told not to.
const NEGATIVE = [
  "text", "letters", "words", "numbers", "caption", "title", "label",
  "signature", "watermark", "logo", "copyright", "page number", "speech bubble",
  "faces", "people", "portrait", "photorealistic", "3d render", "white background"
].join(", ");

export function available(){
  return Boolean(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID);
}

export async function generate({ prompt }){
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if(!token || !account){
    throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are both required");
  }

  const body = {
    prompt: prompt.slice(0, 2000),
    negative_prompt: NEGATIVE,
    width: Number(process.env.COMIC_WIDTH || 1440),
    height: Number(process.env.COMIC_HEIGHT || 576)
  };
  if(process.env.CLOUDFLARE_IMAGE_STEPS) body.steps = Number(process.env.CLOUDFLARE_IMAGE_STEPS);

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${MODEL}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(process.env.IMAGE_TIMEOUT_MS || 180000))
    }
  );

  if(!res.ok){
    const detail = await res.text().catch(() => "");
    throw new Error(`Cloudflare ${res.status}: ${detail.slice(0, 300)}`);
  }

  // Some models answer with a JSON envelope holding base64, others stream the
  // image bytes straight back.
  const contentType = res.headers.get("content-type") || "";
  if(contentType.startsWith("image/")){
    const buffer = Buffer.from(await res.arrayBuffer());
    if(buffer.length < 1024) throw new Error("Cloudflare returned an empty image");
    return { provider: "cloudflare", mime: contentType.split(";")[0], base64: buffer.toString("base64") };
  }

  const data = await res.json();
  if(!data.success) throw new Error(`Cloudflare: ${JSON.stringify(data.errors || data).slice(0, 300)}`);
  const b64 = data?.result?.image;
  if(!b64) throw new Error("Cloudflare returned no image data");
  return { provider: "cloudflare", mime: "image/jpeg", base64: b64 };
}
