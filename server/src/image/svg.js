// Always-available fallback renderer. Draws an on-brand storyboard strip
// from the Groq panel text so the app never fails to produce a comic,
// even with no image-model credentials configured.

import { PALETTE } from "../style.js";

const ICONS = [
  [/chop|dice|slice|mince|cut/i, "M18 46 L46 18 M40 12 l14 14 M14 50 h8"],
  [/fry|saut|sizzle|pan|skillet/i, "M12 40 a20 12 0 0 0 40 0 z M52 40 h14"],
  [/boil|simmer|water|stock|broth/i, "M16 34 h32 v20 a16 16 0 0 1 -32 0 z M24 26 q4 -8 8 0 M36 26 q4 -8 8 0"],
  [/bake|oven|roast/i, "M14 18 h36 v36 h-36 z M14 30 h36 M22 24 h6"],
  [/mix|stir|whisk|fold|beat/i, "M16 44 a16 10 0 0 0 32 0 z M44 12 l-10 30"],
  [/chill|cool|fridge|freeze|rest/i, "M32 12 v40 M16 22 l32 20 M48 22 l-32 20"],
  [/serve|plate|garnish|finish/i, "M12 40 a20 14 0 0 1 40 0 z M8 46 h48"]
];

function iconFor(text){
  for(const [re, path] of ICONS) if(re.test(text)) return path;
  return "M32 14 a18 18 0 1 0 0.1 0 M24 32 h16 M32 24 v16";
}

function escapeXml(s){
  return String(s || "").replace(/[&<>"']/g, m =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[m]));
}

function wrap(text, perLine, maxLines){
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for(const word of words){
    if((line + " " + word).trim().length > perLine){
      lines.push(line.trim());
      line = word;
      if(lines.length === maxLines) break;
    }else{
      line = (line + " " + word).trim();
    }
  }
  if(lines.length < maxLines && line) lines.push(line.trim());
  return lines.slice(0, maxLines);
}

export function renderStripSvg({ panels, title }){
  const count = Math.max(1, panels.length);
  const panelW = 460;
  const panelH = 560;
  const gutter = 18;
  const pad = 18;
  const width = pad * 2 + panelW * count + gutter * (count - 1);
  const height = pad * 2 + panelH;

  const cells = panels.map((panel, i) => {
    const x = pad + i * (panelW + gutter);
    const y = pad;
    const captionLines = wrap(panel.caption, 26, 2);
    const sceneLines = wrap(panel.scene, 34, 4);
    return `
  <g>
    <rect x="${x}" y="${y}" width="${panelW}" height="${panelH}" rx="10"
          fill="${PALETTE.paper}" stroke="${PALETTE.ink}" stroke-width="6"/>
    <rect x="${x + 16}" y="${y + 16}" width="52" height="52" rx="10"
          fill="${PALETTE.red}" stroke="${PALETTE.ink}" stroke-width="5"/>
    <text x="${x + 42}" y="${y + 53}" font-family="Georgia,serif" font-size="30"
          font-weight="bold" fill="#FFFFFF" text-anchor="middle">${i + 1}</text>
    <g transform="translate(${x + panelW / 2 - 64}, ${y + 150}) scale(2)"
       fill="none" stroke="${PALETTE.ink}" stroke-width="3.2"
       stroke-linecap="round" stroke-linejoin="round">
      <path d="${iconFor(panel.scene + " " + panel.caption)}"/>
    </g>
    <g stroke="${PALETTE.accent}" stroke-width="7" stroke-linecap="round">
      <path d="M${x + panelW - 78} ${y + 108} l16 -16"/>
      <path d="M${x + panelW - 54} ${y + 116} l20 -12"/>
      <path d="M${x + panelW - 62} ${y + 138} l18 -6"/>
    </g>
    ${captionLines.map((line, li) => `<text x="${x + panelW / 2}" y="${y + 336 + li * 34}"
          font-family="Georgia,serif" font-size="28" font-weight="bold"
          fill="${PALETTE.ink}" text-anchor="middle">${escapeXml(line)}</text>`).join("")}
    ${sceneLines.map((line, li) => `<text x="${x + panelW / 2}" y="${y + 424 + li * 26}"
          font-family="Georgia,serif" font-size="19"
          fill="${PALETTE.ink}" fill-opacity="0.72" text-anchor="middle">${escapeXml(line)}</text>`).join("")}
  </g>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <pattern id="grain" width="14" height="14" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1.1" fill="${PALETTE.ink}" fill-opacity="0.07"/>
    </pattern>
  </defs>
  <rect width="${width}" height="${height}" fill="${PALETTE.paperDeep}"/>
  <rect width="${width}" height="${height}" fill="url(#grain)"/>
  <title>${escapeXml(title || "Recipe comic")}</title>${cells}
</svg>`;
}

export async function generate({ panels, recipeTitle }){
  // Nothing to letter means nothing to draw.
  if(!panels || panels.length === 0){
    throw new Error("The storyboard fallback needs at least one panel");
  }
  const svg = renderStripSvg({ panels, title: recipeTitle });
  return {
    provider: "svg",
    mime: "image/svg+xml",
    base64: Buffer.from(svg, "utf8").toString("base64")
  };
}
