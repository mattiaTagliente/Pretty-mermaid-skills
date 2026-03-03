#!/usr/bin/env node

import { execSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, readdirSync } from 'fs';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillRoot = join(__dirname, '..');
const themesDir = join(skillRoot, 'assets', 'themes');
const fontsCSS = join(skillRoot, 'assets', 'fonts.css');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    input: null,
    output: null,
    format: 'svg',
    theme: null,
    scale: 2,
    width: 1200,
    bg: null,
    fg: null,
    line: null,
    font: null,
    transparent: false,
    // ASCII-specific options (beautiful-mermaid fallback)
    useAscii: false,
    paddingX: 5,
    paddingY: 5,
    boxBorderPadding: 1,
  };

  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const val = args[i + 1];

    switch (key) {
      case '--input': case '-i': opts.input = val; i++; break;
      case '--output': case '-o': opts.output = val; i++; break;
      case '--format': case '-f': opts.format = val; i++; break;
      case '--theme': case '-t': opts.theme = val; i++; break;
      case '--scale': case '-s': opts.scale = parseInt(val); i++; break;
      case '--width': case '-w': opts.width = parseInt(val); i++; break;
      case '--bg': opts.bg = val; i++; break;
      case '--fg': opts.fg = val; i++; break;
      case '--line': opts.line = val; i++; break;
      case '--font': opts.font = val; i++; break;
      case '--transparent': opts.transparent = true; break;
      case '--use-ascii': opts.useAscii = true; break;
      case '--padding-x': opts.paddingX = parseInt(val); i++; break;
      case '--padding-y': opts.paddingY = parseInt(val); i++; break;
      case '--box-border-padding': opts.boxBorderPadding = parseInt(val); i++; break;
      case '--help': case '-h':
        console.log(`Usage: node render.mjs --input <file> [options]

Options:
  -i, --input <file>       Input Mermaid file (.mmd) [required]
  -o, --output <file>      Output file (default: input with .svg/.png extension)
  -f, --format <fmt>       Output format: svg | png | ascii (default: svg)
  -t, --theme <name>       Theme name (e.g. tokyo-night, dracula, github-dark)
  -s, --scale <n>          PNG scale factor (default: 2, higher = better quality)
  -w, --width <n>          Max width in pixels (default: 1200)
      --bg <hex>           Override background color
      --fg <hex>           Override text color
      --line <hex>         Override edge/connector color
      --font <name>        Override font family (default: Inter)
      --transparent        Transparent background
      --use-ascii          Pure ASCII instead of Unicode (ASCII only)
      --padding-x <n>      Horizontal spacing (ASCII only, default: 5)
      --padding-y <n>      Vertical spacing (ASCII only, default: 5)
      --box-border-padding <n>  Padding inside node boxes (ASCII only, default: 1)

Themes: engineering, tokyo-night, catppuccin-mocha, nord, dracula, github-dark, github-light, solarized-dark, one-dark
Run: node themes.mjs   to list all available themes with previews.`);
        process.exit(0);
    }
  }

  if (!opts.input) {
    console.error('Error: --input is required. Use --help for usage.');
    process.exit(1);
  }

  if (!existsSync(opts.input)) {
    console.error(`Error: Input file not found: ${opts.input}`);
    process.exit(1);
  }

  return opts;
}

function buildMmdcConfig(opts) {
  // Start from theme file or blank base config
  let config;
  if (opts.theme) {
    const themeFile = join(themesDir, `${opts.theme}.json`);
    if (!existsSync(themeFile)) {
      const available = readdirSync(themesDir)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''));
      console.error(`Error: Unknown theme "${opts.theme}".`);
      console.error(`Available themes: ${available.join(', ')}`);
      process.exit(1);
    }
    config = JSON.parse(readFileSync(themeFile, 'utf8'));
  } else {
    config = {
      theme: 'base',
      themeVariables: {
        fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, sans-serif',
        fontSize: '14px',
      },
      flowchart: { curve: 'basis', padding: 20 },
    };
  }

  // Apply CLI overrides
  if (opts.bg) config.themeVariables.background = opts.bg;
  if (opts.fg) {
    config.themeVariables.primaryTextColor = opts.fg;
    config.themeVariables.textColor = opts.fg;
    config.themeVariables.nodeTextColor = opts.fg;
  }
  if (opts.line) config.themeVariables.lineColor = opts.line;
  if (opts.font) config.themeVariables.fontFamily = opts.font;

  return config;
}

function renderWithMmdc(opts) {
  const config = buildMmdcConfig(opts);

  // Write temp config
  const tmpConfig = join(tmpdir(), `mermaid-config-${Date.now()}.json`);
  writeFileSync(tmpConfig, JSON.stringify(config, null, 2));

  // Determine output path
  const ext = opts.format === 'png' ? '.png' : '.svg';
  const output = opts.output || opts.input.replace(/\.mmd$/, ext);

  // Ensure output directory exists
  const outputDir = dirname(resolve(output));
  mkdirSync(outputDir, { recursive: true });

  // Build mmdc args
  const mmdcArgs = [
    '-i', opts.input,
    '-o', output,
    '-c', tmpConfig,
  ];

  if (existsSync(fontsCSS)) {
    mmdcArgs.push('--cssFile', fontsCSS);
  }

  if (opts.transparent) {
    mmdcArgs.push('-b', 'transparent');
  } else if (config.themeVariables.background) {
    mmdcArgs.push('-b', config.themeVariables.background);
  }

  if (opts.format === 'png') {
    mmdcArgs.push('-s', String(opts.scale));
  }

  mmdcArgs.push('-w', String(opts.width));

  // Build command string with proper quoting
  const cmd = ['mmdc', ...mmdcArgs.map(a => `"${a}"`)].join(' ');

  try {
    execSync(cmd, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60000,
    });

    // Post-process SVG for vector editor compatibility (Inkscape/Illustrator)
    if (opts.format === 'svg') {
      const stats = postProcessSvg(output);
      if (stats.foreignObjects > 0) {
        console.log(`Converted ${stats.foreignObjects} foreignObject elements to native SVG text`);
      }
      if (stats.bgRect) console.log(`Injected background rect`);
      if (stats.opacityFixes > 0) console.log(`Fixed ${stats.opacityFixes} semi-transparent label backgrounds`);
    }

    console.log(`${opts.format.toUpperCase()} diagram saved to ${output}`);
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString() : e.message;
    console.error(`Error rendering diagram: ${stderr}`);
    process.exit(1);
  } finally {
    try { unlinkSync(tmpConfig); } catch {}
  }
}

/**
 * Comprehensive SVG post-processing for vector editor compatibility.
 *
 * Fixes three classes of issues:
 * 1. foreignObject → native <text>: Inkscape/Illustrator silently drop HTML in foreignObject
 * 2. Background rect injection: SVG CSS background-color is ignored by standalone SVG viewers
 * 3. Edge label opacity: mermaid hardcodes opacity:0.5 on label backgrounds, creating ghost boxes
 */
function postProcessSvg(svgPath) {
  let svg = readFileSync(svgPath, 'utf8');
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
  // SVG CSS background-color is not rendered by Inkscape/Illustrator/standalone viewers.
  // We inject a <rect> covering the full viewBox as the first child of the root <g>.
  if (bgColor) {
    const vbMatch = svg.match(/viewBox="([^"]+)"/);
    if (vbMatch) {
      const [vbX, vbY, vbW, vbH] = vbMatch[1].split(/\s+/).map(Number);
      const bgRectEl = `<rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="${bgColor}" stroke="none"/>`;
      // Insert after the first <g> opening tag (markers group)
      svg = svg.replace(/(<g><marker )/, `${bgRectEl}$1`);
      stats.bgRect = true;
    }
  }

  // --- Fix 2: Override edge label rect opacity from 0.5 to 1 ---
  // Mermaid hardcodes opacity:0.5 on .edgeLabel rect, creating semi-transparent ghost boxes.
  const opacityBefore = (svg.match(/opacity:0\.5/g) || []).length;
  svg = svg.replace(
    /\.edgeLabel rect\{opacity:0\.5;/g,
    '.edgeLabel rect{opacity:1;'
  );
  // Also fix icon-shape and image-shape rects that have the same issue
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

      // Explicit fill and font-family so text renders correctly without CSS cascade (Inkscape)
      return `<text text-anchor="middle" dominant-baseline="auto" fill="${textFill}" style="font-size:${fontSize}px;font-family:${fontFamily};">${tspans}</text>`;
    }
  );

  stats.foreignObjects = originalFOCount - (svg.match(/<foreignObject/g) || []).length;

  writeFileSync(svgPath, svg);
  return stats;
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function renderAscii(opts) {
  // ASCII rendering still uses beautiful-mermaid (no mmdc equivalent)
  let lib;
  try {
    lib = await import('beautiful-mermaid');
  } catch {
    console.error('ASCII output requires beautiful-mermaid. Install with:');
    console.error(`  cd "${skillRoot}" && npm install beautiful-mermaid`);
    process.exit(1);
  }

  const input = readFileSync(opts.input, 'utf8');
  const ascii = lib.renderMermaidAscii(input, {
    useAscii: opts.useAscii,
    paddingX: opts.paddingX,
    paddingY: opts.paddingY,
    boxBorderPadding: opts.boxBorderPadding,
  });

  if (opts.output) {
    writeFileSync(opts.output, ascii);
    console.log(`ASCII diagram saved to ${opts.output}`);
  } else {
    console.log(ascii);
  }
}

async function main() {
  const opts = parseArgs();

  if (opts.format === 'ascii') {
    await renderAscii(opts);
  } else {
    renderWithMmdc(opts);
  }
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
