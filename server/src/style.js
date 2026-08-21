// House art style for The Family Recipe Box.
// Derived from the existing hand-made step art (warm cream ground, soft
// watercolour wash over clean ink linework, hands only, orange action marks).
// Every generated comic panel must read as part of that same set.

export const STYLE_NAME = "family-recipe-box/watercolor-comic/v1";

export const PALETTE = {
  paper: "#F6EDDA",
  paperDeep: "#EFE1C8",
  ink: "#2A2118",
  red: "#D8493F",
  butter: "#F2B33D",
  accent: "#E8912A",
  sage: "#7C9A6B",
  wood: "#B0783F"
};

// Positive style contract - always appended to the generated scene text.
export const STYLE_POSITIVE = [
  "soft watercolour illustration over clean dark-brown ink linework",
  "warm cream paper background (#F6EDDA) with subtle paper grain",
  "muted warm palette: cream, terracotta red, butter yellow, sage green, wood brown",
  "gentle washes, visible brush texture, no harsh shading, no photorealism",
  "small orange action marks (three short strokes) near motion or heat",
  "hands only - no faces, no people, no characters",
  "one clear centred subject per panel with generous negative space",
  "cosy home-kitchen cookbook feel, flat even lighting, eye-level view"
].join(", ");

// Negative contract - things that break the set.
export const STYLE_NEGATIVE = [
  "no text", "no letters", "no numbers", "no captions", "no speech bubbles",
  "no logos", "no watermark", "no signature", "no borders drawn inside a panel",
  "no faces", "no people", "no cartoon characters",
  "no photorealism", "no 3d render", "no neon", "no dark background"
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
