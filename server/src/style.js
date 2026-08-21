// House art style for The Family Recipe Box.
// Derived from the existing hand-made step art (warm cream ground, soft
// watercolour wash over clean ink linework, hands only, orange action marks).
// Every generated comic panel must read as part of that same set.

export const STYLE_NAME = "family-recipe-box/manhwa-webtoon/v2";

export const PALETTE = {
  paper: "#F6EDDA",
  paperDeep: "#EFE1C8",
  ink: "#141414",
  red: "#D8493F",
  butter: "#F2B33D",
  accent: "#E8912A",
  sage: "#7C9A6B",
  wood: "#B0783F"
};

// Positive style contract - appended to every generated scene.
// Modelled on webtoon/manhwa art: glossy full-colour digital painting with
// crisp linework and cel shading, not the softer watercolour look this
// started with.
export const STYLE_POSITIVE = [
  "glossy full-colour digital webtoon illustration in polished Korean manhwa style",
  "clean crisp black ink linework with confident varied line weight",
  "cel shading with smooth airbrushed gradients and soft ambient occlusion",
  "vivid saturated colour, warm kitchen lighting with bright specular highlights",
  "subtle rim light on edges, gentle bloom, glossy sheen on metal and liquid",
  "high detail and sharp focus, clean uncluttered background with soft depth of field",
  "dynamic close-up composition, slight cinematic angle",
  "hands only - no faces, no characters, no people in frame"
].join(", ");

// Negative contract - things that break the set.
export const STYLE_NEGATIVE = [
  "no text", "no letters", "no numbers", "no captions", "no speech bubbles",
  "no logos", "no watermark", "no signature", "no panel borders", "no grid",
  "no faces", "no people", "no characters",
  "no watercolour", "no sketchy pencil", "no muted washed-out colour",
  "no photorealism", "no 3d render", "no blurry low detail"
].join(", ");

// Comic page framing - how the panels sit together on the strip.
export function layoutContract(panelCount){
  return [
    `a single comic strip page divided into exactly ${panelCount} equal panels in one horizontal row`,
    "each panel separated by a thick dark-brown ink gutter of even width",
    "the whole page sits on the same warm cream paper",
    "panels read left to right in cooking order",
    "every panel drawn in the identical style, palette and line weight"
  ].join(", ");
}

// A single comic panel, drawn full-bleed. Panels are generated one per step
// so each one can fill a phone screen instead of being a third of a strip.
export function buildPanelPrompt({ recipeTitle, scene, index, total }){
  return [
    `A single hand-painted comic book panel from "${recipeTitle}" (panel ${index + 1} of ${total}).`,
    "One full-bleed illustration filling the whole frame, no panel grid, no borders, no gutters.",
    `Scene: ${scene}.`,
    "Leave the lower third of the image simple and uncluttered so a caption can sit there.",
    `Art style: ${STYLE_POSITIVE}.`,
    `Strictly avoid: ${STYLE_NEGATIVE}.`
  ].join(" ");
}

// Assembles the final image prompt from an LLM-authored scene list.
export function buildImagePrompt({ recipeTitle, panels }){
  const scenes = panels
    .map((panel, idx) => `PANEL ${idx + 1}: ${panel.scene}`)
    .join(" || ");
  return [
    `Hand-painted recipe comic strip for "${recipeTitle}".`,
    layoutContract(panels.length) + ".",
    scenes + ".",
    `Art style: ${STYLE_POSITIVE}.`,
    `Strictly avoid: ${STYLE_NEGATIVE}.`
  ].join(" ");
}

// Stable seed so re-generating the same recipe keeps the same look.
export function seedFor(text){
  let hash = 2166136261;
  for(let i = 0; i < text.length; i++){
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 1000000;
}
