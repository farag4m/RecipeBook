// Lays real comic lettering over generated art.
//
// Image models cannot draw legible text, so the art is generated clean and
// the narration boxes are drawn as vector text on top. Composing at serve
// time means lettering can be restyled without redrawing anything.

import { PALETTE } from "../style.js";
import { imageSize } from "./dimensions.js";

const FALLBACK = { width: 1024, height: 1024 };

// A panel is shown one-per-row on a phone, so the lettering is sized as a
// fraction of the panel width. At ~3.6% a 1024px panel still reads clearly
// when scaled down to a 390px screen.
const FONT_RATIO = 0.038;
const MIN_FONT_RATIO = 0.024;


// Manhwa lettering: bold all-caps sans in a white bubble with a pointed tail,
// rather than a serif narration box. Matches how webtoon dialogue reads.
const BUBBLE_FONT = "'Trebuchet MS', 'Helvetica Neue', Arial, sans-serif";

function bubblePath(x, y, w, h, r, tailX){
  const tw = Math.max(14, Math.round(w * 0.055));   // tail half-width
  const th = Math.max(16, Math.round(h * 0.22));    // tail height
  const tx = Math.min(Math.max(tailX, x + r + tw * 2), x + w - r - tw * 2);
  return [
    `M ${x + r} ${y}`,
    `H ${tx - tw}`,
    `L ${tx} ${y - th}`,                              // tail, pointing up
    `L ${tx + tw} ${y}`,
    `H ${x + w - r}`,
    `A ${r} ${r} 0 0 1 ${x + w} ${y + r}`,
    `V ${y + h - r}`,
    `A ${r} ${r} 0 0 1 ${x + w - r} ${y + h}`,
    `H ${x + r}`,
    `A ${r} ${r} 0 0 1 ${x} ${y + h - r}`,
    `V ${y + r}`,
    `A ${r} ${r} 0 0 1 ${x + r} ${y}`,
    "Z"
  ].join(" ");
}

function escapeXml(s){
  return String(s || "").replace(/[&<>"']/g, m =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[m]));
}

// Rough proportional-width wrap. Georgia at weight 700 measures ~0.56em per
// character in practice, so characters-per-line is derived from the box width.
function wrapText(text, maxChars, maxLines){
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for(const word of words){
    const candidate = line ? `${line} ${word}` : word;
    if(candidate.length > maxChars && line){
      lines.push(line);
      line = word;
      if(lines.length === maxLines) break;
    }else{
      line = candidate;
    }
  }
  if(lines.length < maxLines && line) lines.push(line);
  if(lines.length === maxLines && words.length){
    // Signal truncation rather than silently dropping instructions.
    const joined = lines.join(" ");
    if(joined.length < String(text).trim().length){
      lines[lines.length - 1] = lines[lines.length - 1].replace(/[,;:]?$/, "") + "…";
    }
  }
  return lines;
}

/**
 * @param {Buffer} bytes    the generated art
 * @param {string} mime     its content type
 * @param {Array}  captions [{ n, text }] - one per panel, left to right
 */
export function composeComicSvg({ bytes, mime, captions }){
  const size = imageSize(bytes) || FALLBACK;
  const { width: W, height: H } = size;
  const panels = (captions || []).filter(c => c && c.text);
  const count = panels.length || 1;

  const dataUri = `data:${mime};base64,${bytes.toString("base64")}`;

  // Geometry scales with the art so it holds up at any output size.
  const panelW = W / count;
  const pad = Math.round(W * 0.014);
  const baseFont = Math.max(14, Math.round(W * (count === 1 ? FONT_RATIO : 0.0165)));
  const minFont = Math.max(11, Math.round(W * (count === 1 ? MIN_FONT_RATIO : 0.0092)));
  const boxW = panelW - pad * 2;
  // A recipe step is a whole sentence, so the lettering is sized to fit the
  // longest one rather than truncating it. Shrink until it fits, and only
  // clip if even the smallest size cannot hold it.
  const MAX_LINES = 7;
  const maxBoxH = H * 0.46;
  let fontSize = baseFont;
  let wrapped, lineHeight, badge, textInset, boxH;

  for(;;){
    lineHeight = Math.round(fontSize * 1.32);
    badge = Math.round(fontSize * 1.5);
    textInset = pad * 0.9 + badge * 1.05;
    const textW = boxW - textInset - pad * 0.9;
    const maxChars = Math.max(12, Math.floor(textW / (fontSize * 0.56)));
    wrapped = panels.map(panel => wrapText(panel.text, maxChars, MAX_LINES));
    const lines = Math.max(1, ...wrapped.map(l => l.length));
    boxH = lines * lineHeight + pad * 1.6;
    const clipped = wrapped.some(l => l.some(line => line.endsWith("…")));
    if((boxH <= maxBoxH && !clipped) || fontSize <= minFont) break;
    fontSize -= 1;
  }

  const boxes = panels.map((panel, i) => {
    const lines = wrapped[i];
    const x = Math.round(i * panelW + pad);
    const y = Math.round(H - boxH - pad);
    const textX = x + textInset;
    const firstBaseline = y + pad * 0.8 + fontSize;

    return `
  <g>
    <rect x="${x + 3}" y="${y + 3}" width="${Math.round(boxW)}" height="${Math.round(boxH)}"
          rx="${Math.round(fontSize * 0.5)}" fill="${PALETTE.ink}" fill-opacity="0.85"/>
    <rect x="${x}" y="${y}" width="${Math.round(boxW)}" height="${Math.round(boxH)}"
          rx="${Math.round(fontSize * 0.5)}" fill="#FFF8E7"
          stroke="${PALETTE.ink}" stroke-width="${Math.max(2, Math.round(W * 0.0021))}"/>
    <circle cx="${Math.round(x + pad * 0.7 + badge / 2)}" cy="${Math.round(y + pad * 0.8 + badge / 2)}"
            r="${Math.round(badge / 2)}" fill="${PALETTE.red}"
            stroke="${PALETTE.ink}" stroke-width="${Math.max(2, Math.round(W * 0.0017))}"/>
    <text x="${Math.round(x + pad * 0.7 + badge / 2)}" y="${Math.round(y + pad * 0.8 + badge / 2 + fontSize * 0.36)}"
          font-family="Georgia, 'Times New Roman', serif" font-size="${Math.round(fontSize * 0.95)}"
          font-weight="bold" fill="#FFFFFF" text-anchor="middle">${panel.n}</text>
    ${lines.map((line, li) => `<text x="${Math.round(textX)}" y="${Math.round(firstBaseline + li * lineHeight)}"
          font-family="Georgia, 'Times New Roman', serif" font-size="${fontSize}"
          font-weight="bold" fill="${PALETTE.ink}">${escapeXml(line)}</text>`).join("")}
  </g>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <image href="${dataUri}" xlink:href="${dataUri}" x="0" y="0" width="${W}" height="${H}"/>${boxes}
</svg>`;
}

/**
 * One comic panel, sized to fill a phone screen.
 *
 * Existing art was drawn as a wide multi-panel strip, which shrinks to
 * unreadable slivers on a narrow screen. Rather than redraw it, the strip is
 * cropped to a single panel through the SVG viewBox and the caption is
 * lettered at panel scale. Natively single-panel art passes straight through.
 *
 * @param {Buffer} bytes       the stored art
 * @param {string} mime        its content type
 * @param {object} caption     { n, text } for this panel
 * @param {number} panelIndex  which panel of the strip to show
 * @param {number} panelCount  how many panels the strip holds
 */
export function composePanelSvg({ bytes, mime, caption, panelIndex = 0, panelCount = 1 }){
  const size = imageSize(bytes) || FALLBACK;
  const { width: W, height: H } = size;
  const count = Math.max(1, panelCount);
  const index = Math.min(Math.max(0, panelIndex), count - 1);

  const panelW = W / count;
  const originX = index * panelW;
  const dataUri = `data:${mime};base64,${bytes.toString("base64")}`;

  const pad = Math.round(panelW * 0.04);
  const baseFont = Math.max(16, Math.round(panelW * FONT_RATIO));
  const minFont = Math.max(12, Math.round(panelW * MIN_FONT_RATIO));
  const boxW = panelW - pad * 2;
  const text = String(caption?.text || "").toUpperCase();

  let fontSize = baseFont;
  let lines, lineHeight, boxH;
  for(;;){
    lineHeight = Math.round(fontSize * 1.3);
    // All-caps sans runs wider than mixed-case serif.
    const maxChars = Math.max(10, Math.floor((boxW - fontSize * 1.6) / (fontSize * 0.62)));
    lines = wrapText(text, maxChars, 8);
    boxH = lines.length * lineHeight + fontSize * 1.25;
    const clipped = lines.some(line => line.endsWith("…"));
    if((boxH <= H * 0.40 && !clipped) || fontSize <= minFont) break;
    fontSize -= 1;
  }

  const x = Math.round(originX + pad);
  const y = Math.round(H - boxH - pad);
  const stroke = Math.max(3, Math.round(panelW * 0.007));
  const radius = Math.round(fontSize * 0.9);
  const badgeR = Math.round(fontSize * 0.85);

  const bubble = text ? `
  <path d="${bubblePath(x, y, Math.round(boxW), Math.round(boxH), radius, Math.round(originX + panelW * 0.3))}"
        fill="#FFFFFF" stroke="${PALETTE.ink}" stroke-width="${stroke}" stroke-linejoin="round"/>
  <circle cx="${Math.round(x + badgeR + stroke)}" cy="${Math.round(y + badgeR + stroke)}" r="${badgeR}"
          fill="${PALETTE.red}" stroke="${PALETTE.ink}" stroke-width="${Math.max(2, Math.round(stroke * 0.6))}"/>
  <text x="${Math.round(x + badgeR + stroke)}" y="${Math.round(y + badgeR + stroke + fontSize * 0.34)}"
        font-family="${BUBBLE_FONT}" font-size="${Math.round(fontSize * 0.85)}" font-weight="bold"
        fill="#FFFFFF" text-anchor="middle">${caption.n}</text>
  ${lines.map((line, li) => `<text x="${Math.round(originX + panelW / 2)}" y="${Math.round(y + fontSize * 1.5 + li * lineHeight)}"
        font-family="${BUBBLE_FONT}" font-size="${fontSize}" font-weight="bold"
        letter-spacing="${(fontSize * 0.02).toFixed(2)}"
        fill="${PALETTE.ink}" text-anchor="middle">${escapeXml(line)}</text>`).join("")}` : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${Math.round(panelW)}" height="${H}" viewBox="${Math.round(originX)} 0 ${Math.round(panelW)} ${H}">
  <image href="${dataUri}" xlink:href="${dataUri}" x="0" y="0" width="${W}" height="${H}"/>${bubble}
</svg>`;
}
