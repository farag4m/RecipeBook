// Lays real comic lettering over generated art.
//
// Image models cannot draw legible text, so the art is generated clean and
// the narration boxes are drawn as vector text on top. Composing at serve
// time means lettering can be restyled without redrawing anything.

import { PALETTE } from "../style.js";
import { imageSize } from "./dimensions.js";

const FALLBACK = { width: 1440, height: 576 };

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
  const fontSize = Math.max(13, Math.round(W * 0.0165));
  const lineHeight = Math.round(fontSize * 1.32);
  const boxW = panelW - pad * 2;
  const badge = Math.round(fontSize * 1.5);
  const textInset = pad * 0.9 + badge * 1.05;
  const textW = boxW - textInset - pad * 0.9;
  const maxChars = Math.max(14, Math.floor(textW / (fontSize * 0.56)));

  const wrapped = panels.map(panel => wrapText(panel.text, maxChars, 4));
  const maxLines = Math.max(1, ...wrapped.map(lines => lines.length));
  // One height for every box so the strip reads as a single row of lettering.
  const boxH = maxLines * lineHeight + pad * 1.6;

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
