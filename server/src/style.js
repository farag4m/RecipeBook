// House art style for The Family Recipe Box.
// Bright, flat-shaded webtoon art with hard ink outlines - the look of the
// manhwa reference, kept deliberately light and high-contrast because the
// model drifts towards dark semi-photographic renders otherwise.

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
const STYLE_BASE = [
  "clean bright webtoon illustration in polished Korean manhwa style",
  "crisp confident black ink outlines on every shape, strong readable silhouettes",
  "flat cel shading in two or three tones, vivid saturated colour",
  "bright even daylight, light airy background, high contrast, no gloom",
  "clear and legible at a glance, simple uncluttered composition",
  "drawn illustration, not a photograph"
].join(", ");

// Panels are shot over a cook's hands; a plated cover is not.
export const STYLE_POSITIVE = STYLE_BASE + ", hands only - no faces, no characters, no people in frame";
export const STYLE_COVER = STYLE_BASE;

// Negative contract - things that break the set.
export const STYLE_NEGATIVE = [
  "no text", "no letters", "no numbers", "no captions", "no speech bubbles",
  "no logos", "no watermark", "no signature", "no panel borders", "no grid",
  "no faces", "no people", "no characters",
  "no photorealism", "no photograph", "no 3d render", "no cgi",
  "no dark scene", "no dim lighting", "no heavy shadows", "no murky colour",
  "no muddy brown wash", "no motion blur", "no depth of field blur",
  "no grain", "no noise", "no cluttered background"
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

// The card cover: the finished dish, plated. Cropping a step panel gives you
// whatever that step happened to show - often a closed pressure cooker - so
// the hero shot is generated in its own right.
export function buildCoverPrompt({ recipeTitle, ingredients = [] }){
  return [
    `Appetising hero food illustration of the finished dish "${recipeTitle}", plated and ready to eat.`,
    ingredients.length ? `The dish contains ${ingredients.slice(0, 8).join(", ")}.` : "",
    "The finished dish is served in a bowl or on a plate resting on a table,",
    "filling the frame, seen from slightly above, freshly made with garnish and gentle steam.",
    `Art style: ${STYLE_COVER}.`,
    `Strictly avoid: ${STYLE_NEGATIVE}.`
  ].filter(Boolean).join(" ");
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
