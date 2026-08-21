// Provider router. Groq cannot generate images, so the pixels come from
// whichever renderer is configured; the SVG storyboard is the last resort
// and never fails.

import * as cloudflare from "./cloudflare.js";
import * as openrouter from "./openrouter.js";
import * as gemini from "./gemini.js";
import * as openai from "./openai.js";
import * as pollinations from "./pollinations.js";
import * as svg from "./svg.js";

const PROVIDERS = { cloudflare, openrouter, gemini, openai, pollinations, svg };
// Pollinations is keyless but far too low-fidelity for the house style, so it
// is opt-in only (IMAGE_PROVIDER=pollinations) and never chosen automatically.
// Cloudflare first: it is the only one with a free image tier.
const AUTO_ORDER = ["cloudflare", "openrouter", "gemini", "openai"];

export function providerStatus(){
  return {
    configured: process.env.IMAGE_PROVIDER || "auto",
    cloudflare: cloudflare.available(),
    cloudflareAccounts: cloudflare.status(),
    openrouter: openrouter.available(),
    gemini: gemini.available(),
    openai: openai.available(),
    pollinations: pollinations.available(),
    svg: true,
    active: resolveOrder()[0]
  };
}

export function resolveOrder(){
  const choice = (process.env.IMAGE_PROVIDER || "auto").toLowerCase();
  if(choice !== "auto" && PROVIDERS[choice]) return [choice, "svg"];
  const order = AUTO_ORDER.filter(name => PROVIDERS[name].available?.() ?? true);
  return [...order, "svg"];
}

// Tries each provider in turn; returns the first image plus any failures.
export async function renderStrip({ prompt, panels, recipeTitle, seed, negative = [] }){
  const attempts = [];
  for(const name of resolveOrder()){
    try{
      const image = await PROVIDERS[name].generate({ prompt, panels, recipeTitle, seed, negative });
      return { ...image, attempts };
    }catch(e){
      attempts.push({ provider: name, error: e.message });
    }
  }
  throw new Error(`All image providers failed: ${JSON.stringify(attempts)}`);
}
