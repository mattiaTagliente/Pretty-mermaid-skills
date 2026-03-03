#!/usr/bin/env node

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { readdirSync, readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const themesDir = join(__dirname, '..', 'assets', 'themes');

function main() {
  const files = readdirSync(themesDir)
    .filter(f => f.endsWith('.json'))
    .sort();

  console.log('Available Themes:\n');

  for (let i = 0; i < files.length; i++) {
    const name = files[i].replace('.json', '');
    const config = JSON.parse(readFileSync(join(themesDir, files[i]), 'utf8'));
    const vars = config.themeVariables || {};

    const bg = vars.background || '?';
    const fg = vars.primaryTextColor || vars.textColor || '?';
    const line = vars.lineColor || '?';
    const isDark = isDarkColor(bg);

    const label = `${String(i + 1).padStart(2)}. ${name.padEnd(20)}`;
    const colors = `bg:${bg}  fg:${fg}  line:${line}`;
    const mode = isDark ? 'dark' : 'light';

    console.log(`${label} ${colors}  [${mode}]`);
  }

  console.log(`\nTotal: ${files.length} themes`);
  console.log('\nUsage:');
  console.log('  node scripts/render.mjs --input diagram.mmd --theme <theme-name> --output output.svg');
  console.log('  node scripts/render.mjs --input diagram.mmd --theme <theme-name> --format png --output output.png');
}

function isDarkColor(hex) {
  if (!hex || !hex.startsWith('#')) return true;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Relative luminance (sRGB)
  return (0.299 * r + 0.587 * g + 0.114 * b) < 128;
}

main();
