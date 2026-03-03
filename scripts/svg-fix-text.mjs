#!/usr/bin/env node

/**
 * Post-processes mermaid SVG for vector editor compatibility (Inkscape/Illustrator).
 *
 * Fixes three classes of issues:
 * 1. foreignObject → native <text>: Inkscape/Illustrator silently drop HTML in foreignObject
 * 2. Background rect injection: SVG CSS background-color is ignored by standalone SVG viewers
 * 3. Edge label opacity: mermaid hardcodes opacity:0.5 on label backgrounds, creating ghost boxes
 *
 * Usage:
 *   node svg-fix-text.mjs input.svg [output.svg]
 *   If output is omitted, overwrites the input file.
 */

import { readFileSync, writeFileSync } from 'fs';

function main() {
  const input = process.argv[2];
  const output = process.argv[3] || input;

  if (!input) {
    console.error('Usage: node svg-fix-text.mjs <input.svg> [output.svg]');
    process.exit(1);
  }

  let svg = readFileSync(input, 'utf8');
  const stats = { foreignObjects: 0, bgRect: false, opacityFixes: 0 };

  // --- Extract theme colors from SVG CSS ---
  const bgMatch = svg.match(/background-color:\s*rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  const bgColor = bgMatch
    ? `#${[bgMatch[1], bgMatch[2], bgMatch[3]].map(c => parseInt(c).toString(16).padStart(2, '0')).join('')}`
    : null;

  const fillMatch = svg.match(/#my-svg\{[^}]*fill:([^;}]+)/);
  const textFill = fillMatch ? fillMatch[1].trim() : '#1a1a1a';

  const fontMatch = svg.match(/#my-svg\{[^}]*font-family:([^;}]+)/);
  const fontFamily = fontMatch ? fontMatch[1].trim() : 'Inter, system-ui, sans-serif';

  // --- Fix 1: Inject background <rect> ---
  if (bgColor) {
    const vbMatch = svg.match(/viewBox="([^"]+)"/);
    if (vbMatch) {
      const [vbX, vbY, vbW, vbH] = vbMatch[1].split(/\s+/).map(Number);
      const bgRectEl = `<rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="${bgColor}" stroke="none"/>`;
      svg = svg.replace(/(<g><marker )/, `${bgRectEl}$1`);
      stats.bgRect = true;
    }
  }

  // --- Fix 2: Override edge label rect opacity from 0.5 to 1 ---
  const opacityBefore = (svg.match(/opacity:0\.5/g) || []).length;
  svg = svg.replace(
    /\.edgeLabel rect\{opacity:0\.5;/g,
    '.edgeLabel rect{opacity:1;'
  );
  svg = svg.replace(
    /\.icon-shape rect,#my-svg \.image-shape rect\{opacity:0\.5/g,
    '.icon-shape rect,#my-svg .image-shape rect{opacity:1'
  );
  const opacityAfter = (svg.match(/opacity:0\.5/g) || []).length;
  stats.opacityFixes = opacityBefore - opacityAfter;

  // --- Fix 3: Convert foreignObject to native SVG <text> ---
  const originalFOCount = (svg.match(/<foreignObject/g) || []).length;

  svg = svg.replace(
    /<foreignObject\s+width="([^"]*?)"\s+height="([^"]*?)">([\s\S]*?)<\/foreignObject>/g,
    (match, width, height, inner) => {
      const lines = inner
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>\s*<p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0);

      if (lines.length === 0) {
        return `<rect width="${width}" height="${height}" fill="none" stroke="none"/>`;
      }

      const w = parseFloat(width);
      const h = parseFloat(height);
      const lineHeight = 1.4;
      const fontSize = 14;
      const totalTextHeight = lines.length * fontSize * lineHeight;
      const startY = (h - totalTextHeight) / 2 + fontSize;

      const tspans = lines.map((line, i) => {
        const y = startY + i * fontSize * lineHeight;
        return `<tspan x="${w / 2}" y="${y}">${escapeXml(line)}</tspan>`;
      }).join('');

      return `<text text-anchor="middle" dominant-baseline="auto" fill="${textFill}" style="font-size:${fontSize}px;font-family:${fontFamily};">${tspans}</text>`;
    }
  );

  stats.foreignObjects = originalFOCount - (svg.match(/<foreignObject/g) || []).length;

  writeFileSync(output, svg);

  if (stats.foreignObjects > 0) console.log(`Converted ${stats.foreignObjects} foreignObject elements to native SVG text`);
  if (stats.bgRect) console.log(`Injected background rect`);
  if (stats.opacityFixes > 0) console.log(`Fixed ${stats.opacityFixes} semi-transparent label backgrounds`);
  console.log(`Saved to ${output}`);
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

main();
