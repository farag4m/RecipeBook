// Cloudflare Workers AI - the free image tier, and the default renderer.
//
// The free allowance is 10,000 neurons per account per day, which one full
// recipe redraw can exhaust. Several accounts can be configured; when one
// reports its allowance spent, it is parked until the daily reset and the
// next account takes over automatically.

const MODEL = process.env.CLOUDFLARE_IMAGE_MODEL || "@cf/leonardo/lucid-origin";

// Diffusion models leak stray captions and page furniture unless told not to.
const NEGATIVE = [
  "text", "letters", "words", "numbers", "caption", "title", "label",
  "signature", "watermark", "logo", "copyright", "page number", "speech bubble",
  "faces", "people", "portrait", "photorealistic", "3d render", "white background"
].join(", ");

// accountId -> epoch ms at which its allowance is expected back.
const exhausted = new Map();

// Cloudflare's allowance rolls over at UTC midnight.
function nextResetAt(){
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

// Accepts either CLOUDFLARE_ACCOUNTS as a JSON array, or numbered pairs:
// CLOUDFLARE_ACCOUNT_ID / _2 / _3 with matching CLOUDFLARE_API_TOKEN.
export function accounts(){
  const raw = process.env.CLOUDFLARE_ACCOUNTS;
  if(raw){
    try{
      const parsed = JSON.parse(raw);
      if(Array.isArray(parsed)){
        return parsed
          .map((a, i) => ({ label: a.label || `account${i + 1}`, id: a.id, token: a.token }))
          .filter(a => a.id && a.token);
      }
    }catch(e){
      console.error("[cloudflare] CLOUDFLARE_ACCOUNTS is not valid JSON:", e.message);
    }
  }

  const list = [];
  for(const suffix of ["", "_2", "_3", "_4", "_5"]){
    const id = process.env[`CLOUDFLARE_ACCOUNT_ID${suffix}`];
    const token = process.env[`CLOUDFLARE_API_TOKEN${suffix}`];
    if(id && token) list.push({ label: `account${list.length + 1}`, id, token });
  }
  return list;
}

function isQuotaError(status, body){
  return status === 429 || /daily free allocation|neurons|quota/i.test(body || "");
}

export function available(){
  return accounts().some(a => !isParked(a.id));
}

function isParked(id){
  const until = exhausted.get(id);
  if(!until) return false;
  if(Date.now() >= until){ exhausted.delete(id); return false; }
  return true;
}

export function status(){
  return accounts().map(a => ({
    label: a.label,
    id: a.id.slice(0, 8) + "…",
    available: !isParked(a.id),
    resetsAt: exhausted.get(a.id) ? new Date(exhausted.get(a.id)).toISOString() : null
  }));
}

async function callAccount(account, body){
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account.id}/ai/run/${MODEL}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(process.env.IMAGE_TIMEOUT_MS || 180000))
    }
  );

  if(!res.ok){
    const detail = await res.text().catch(() => "");
    const err = new Error(`Cloudflare ${res.status}: ${detail.slice(0, 200)}`);
    err.quota = isQuotaError(res.status, detail);
    throw err;
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
  if(!data.success){
    const detail = JSON.stringify(data.errors || data);
    const err = new Error(`Cloudflare: ${detail.slice(0, 200)}`);
    err.quota = isQuotaError(200, detail);
    throw err;
  }
  const b64 = data?.result?.image;
  if(!b64) throw new Error("Cloudflare returned no image data");
  return { provider: "cloudflare", mime: "image/jpeg", base64: b64 };
}

export async function generate({ prompt, negative = [] }){
  const all = accounts();
  if(all.length === 0) throw new Error("No Cloudflare account is configured");

  const body = {
    prompt: prompt.slice(0, 2000),
    negative_prompt: [NEGATIVE, ...negative].join(', '),
    width: Number(process.env.PANEL_WIDTH || 1024),
    height: Number(process.env.PANEL_HEIGHT || 1024)
  };
  if(process.env.CLOUDFLARE_IMAGE_STEPS) body.steps = Number(process.env.CLOUDFLARE_IMAGE_STEPS);

  const failures = [];
  for(const account of all){
    if(isParked(account.id)){
      failures.push(`${account.label}: allowance spent until reset`);
      continue;
    }
    try{
      return await callAccount(account, body);
    }catch(e){
      if(e.quota){
        // Park it for the rest of the UTC day and move on.
        exhausted.set(account.id, nextResetAt());
        console.warn(`[cloudflare] ${account.label} allowance spent, switching account`);
      }
      failures.push(`${account.label}: ${e.message}`);
    }
  }
  throw new Error(`All Cloudflare accounts failed - ${failures.join(" | ")}`);
}
