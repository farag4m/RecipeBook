// Step budgeting: a recipe is capped, then split into 1-4 comic strips
// of roughly 3 panels each.

export const MAX_STEPS = 12;
export const PANELS_PER_CHUNK = 3;
export const MAX_CHUNKS = 4;

// 1-3 steps -> 1 strip, 4-6 -> 2, 7-9 -> 3, 10-12 -> 4.
export function chunkCountFor(stepCount){
  if(stepCount <= 0) return 0;
  return Math.min(MAX_CHUNKS, Math.ceil(stepCount / PANELS_PER_CHUNK));
}

// Splits n items into `parts` groups as evenly as possible, biggest first.
export function balancedSizes(stepCount, parts){
  if(parts <= 0) return [];
  const base = Math.floor(stepCount / parts);
  let extra = stepCount % parts;
  return Array.from({length: parts}, () => base + (extra-- > 0 ? 1 : 0));
}

export function planChunks(steps){
  const parts = chunkCountFor(steps.length);
  const sizes = balancedSizes(steps.length, parts);
  const chunks = [];
  let cursor = 0;
  for(const size of sizes){
    if(size <= 0) continue;
    chunks.push({
      index: chunks.length,
      startStep: cursor,
      endStep: cursor + size - 1,
      steps: steps.slice(cursor, cursor + size)
    });
    cursor += size;
  }
  return chunks;
}

// Deterministic fallback when a recipe runs past MAX_STEPS and Groq
// condensing is unavailable: repeatedly fold the shortest adjacent pair.
export function condenseLocally(steps, limit = MAX_STEPS){
  const working = steps.map(step => ({...step}));
  while(working.length > limit){
    let bestIdx = 0;
    let bestLen = Infinity;
    for(let i = 0; i < working.length - 1; i++){
      const len = (working[i].text || "").length + (working[i + 1].text || "").length;
      if(len < bestLen){ bestLen = len; bestIdx = i; }
    }
    const a = working[bestIdx];
    const b = working[bestIdx + 1];
    working.splice(bestIdx, 2, {
      title: a.title || b.title || "",
      text: [a.text, b.text].filter(Boolean).join(" Then ")
    });
  }
  return working;
}

export function normalizeSteps(rawSteps){
  return (Array.isArray(rawSteps) ? rawSteps : [])
    .map(step => {
      if(typeof step === "string") return {title: "", text: step.trim()};
      if(!step || typeof step !== "object") return null;
      return {
        title: String(step.title || "").trim(),
        text: String(step.text || step.instruction || step.description || step.title || "").trim()
      };
    })
    .filter(step => step && step.text);
}
