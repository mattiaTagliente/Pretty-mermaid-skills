#!/usr/bin/env node

import { execSync } from 'child_process';
import { createRequire } from 'module';
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
    pdf: false,
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
      case '--pdf': opts.pdf = true; break;
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
      --pdf               Also generate PDF from the processed SVG (vector output)
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
        fontSize: '18px',
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

/**
 * Resolve puppeteer from mmdc's global installation (avoids adding ~200MB dependency).
 */
let _puppeteer = null;
function loadPuppeteer() {
  if (_puppeteer) return _puppeteer;
  const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  const mmdcEntry = join(npmRoot, '@mermaid-js', 'mermaid-cli', 'src', 'index.js');
  const mmdcRequire = createRequire(mmdcEntry);
  _puppeteer = mmdcRequire('puppeteer');
  return _puppeteer;
}

/**
 * Build an HTML wrapper that renders the SVG at its natural viewBox dimensions.
 * Removes the max-width constraint so Puppeteer captures at full size.
 */
function buildSvgHtml(svgContent, vbW, vbH) {
  const fixed = svgContent
    .replace(/width="100%"/, `width="${vbW}" height="${vbH}"`)
    .replace(/max-width:\s*[\d.]+px;\s*/, '');
  return `<!DOCTYPE html><html><head><style>body{margin:0;padding:0;overflow:hidden}svg{display:block}</style></head><body>${fixed}</body></html>`;
}

function parseSvgViewBox(svgContent) {
  const m = svgContent.match(/viewBox="([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)"/);
  if (!m) throw new Error('SVG missing viewBox dimensions');
  return { minX: parseFloat(m[1]), minY: parseFloat(m[2]), w: parseFloat(m[3]), h: parseFloat(m[4]) };
}

/**
 * Convert a post-processed SVG to PNG via Puppeteer.
 * Uses deviceScaleFactor for crisp high-DPI output.
 */
async function svgToPng(svgPath, pngPath, scale = 2) {
  const puppeteer = loadPuppeteer();
  const svgContent = readFileSync(svgPath, 'utf8');
  const vb = parseSvgViewBox(svgContent);
  const w = Math.ceil(vb.w);
  const h = Math.ceil(vb.h);

  const tmpHtml = join(tmpdir(), `mermaid-png-${Date.now()}.html`);
  writeFileSync(tmpHtml, buildSvgHtml(svgContent, w, h));

  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, deviceScaleFactor: scale });
    await page.goto(`file:///${tmpHtml.replace(/\\/g, '/')}`, { waitUntil: 'networkidle0' });
    await page.screenshot({ path: pngPath, fullPage: true, omitBackground: false });
  } finally {
    await browser.close();
    try { unlinkSync(tmpHtml); } catch {}
  }
}

/**
 * Convert a post-processed SVG to PDF via Puppeteer.
 * Page dimensions match the SVG viewBox for a tight-fit vector PDF.
 */
async function svgToPdf(svgPath, pdfPath) {
  const puppeteer = loadPuppeteer();
  const svgContent = readFileSync(svgPath, 'utf8');
  const vb = parseSvgViewBox(svgContent);
  const w = Math.ceil(vb.w);
  const h = Math.ceil(vb.h);

  const tmpHtml = join(tmpdir(), `mermaid-pdf-${Date.now()}.html`);
  writeFileSync(tmpHtml, buildSvgHtml(svgContent, w, h));

  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`file:///${tmpHtml.replace(/\\/g, '/')}`, { waitUntil: 'networkidle0' });
    await page.pdf({
      path: pdfPath,
      width: `${w}px`,
      height: `${h}px`,
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
  } finally {
    await browser.close();
    try { unlinkSync(tmpHtml); } catch {}
  }
}

function printStats(stats) {
  if (stats.foreignObjects > 0) console.log(`Converted ${stats.foreignObjects} foreignObject elements to native SVG text`);
  if (stats.bgRect) console.log(`Injected background rect`);
  if (stats.opacityFixes > 0) console.log(`Fixed ${stats.opacityFixes} semi-transparent label backgrounds`);
  if (stats.edgeLabelShifts > 0) console.log(`Shifted ${stats.edgeLabelShifts} horizontal edge labels above edge paths`);
}

/**
 * Main rendering pipeline.
 * Always renders SVG first via mmdc, post-processes it, then converts
 * to PNG and/or PDF as requested. This ensures all outputs reflect
 * the same post-processing (text conversion, label shifts, opacity fixes).
 */
async function renderWithMmdc(opts) {
  const config = buildMmdcConfig(opts);

  // Write temp config
  const tmpConfig = join(tmpdir(), `mermaid-config-${Date.now()}.json`);
  writeFileSync(tmpConfig, JSON.stringify(config, null, 2));

  // Determine output paths — all derived from the same base name
  const baseName = opts.output
    ? opts.output.replace(/\.(svg|png|pdf)$/i, '')
    : opts.input.replace(/\.mmd$/, '');
  const svgOutput = baseName + '.svg';

  // Ensure output directory exists
  const outputDir = dirname(resolve(svgOutput));
  mkdirSync(outputDir, { recursive: true });

  // Step 1: Render to SVG via mmdc (always SVG, even for PNG/PDF targets)
  const mmdcArgs = ['-i', opts.input, '-o', svgOutput, '-c', tmpConfig];
  if (existsSync(fontsCSS)) mmdcArgs.push('--cssFile', fontsCSS);
  if (opts.transparent) mmdcArgs.push('-b', 'transparent');
  else if (config.themeVariables.background) mmdcArgs.push('-b', config.themeVariables.background);
  mmdcArgs.push('-w', String(opts.width));

  const cmd = ['mmdc', ...mmdcArgs.map(a => `"${a}"`)].join(' ');

  try {
    execSync(cmd, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000 });
  } catch (e) {
    console.error(`Error rendering diagram: ${e.stderr ? e.stderr.toString() : e.message}`);
    process.exit(1);
  } finally {
    try { unlinkSync(tmpConfig); } catch {}
  }

  // Step 2: Post-process SVG (text conversion, opacity fix, edge label shift)
  const stats = postProcessSvg(svgOutput);
  printStats(stats);
  console.log(`SVG diagram saved to ${svgOutput}`);

  // Step 3: Convert to PNG from the processed SVG
  if (opts.format === 'png') {
    const pngOutput = baseName + '.png';
    await svgToPng(svgOutput, pngOutput, opts.scale);
    console.log(`PNG diagram saved to ${pngOutput}`);
  }

  // Step 4: Convert to PDF from the processed SVG
  if (opts.pdf) {
    const pdfOutput = baseName + '.pdf';
    await svgToPdf(svgOutput, pdfOutput);
    console.log(`PDF diagram saved to ${pdfOutput}`);
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
  const stats = { foreignObjects: 0, bgRect: false, opacityFixes: 0, edgeLabelShifts: 0 };

  // --- Extract theme colors and font size from SVG CSS ---
  const bgMatch = svg.match(/background-color:\s*rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  const bgColor = bgMatch
    ? `#${[bgMatch[1], bgMatch[2], bgMatch[3]].map(c => parseInt(c).toString(16).padStart(2, '0')).join('')}`
    : null;

  const fillMatch = svg.match(/#my-svg\{[^}]*fill:([^;}]+)/);
  const textFill = fillMatch ? fillMatch[1].trim() : '#1a1a1a';

  const fontMatch = svg.match(/#my-svg\{[^}]*font-family:([^;}]+)/);
  const fontFamily = fontMatch ? fontMatch[1].trim() : 'Inter, system-ui, sans-serif';

  const fontSizeMatch = svg.match(/#my-svg\{[^}]*font-size:\s*(\d+(?:\.\d+)?)px/);
  const fontSize = fontSizeMatch ? parseFloat(fontSizeMatch[1]) : 18;

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

  // --- Fix 4: Shift horizontal edge labels above the edge path ---
  // Extract edge path directions from the edgePaths section
  const edgePathDirs = [];
  const edgePathSection = svg.match(/class="edgePaths"[\s\S]*?(?=class="edgeLabels"|class="nodes"|$)/);
  if (edgePathSection) {
    const pathRegex = /<path[^>]*\bd="([^"]+)"[^>]*>/g;
    let pm;
    while ((pm = pathRegex.exec(edgePathSection[0])) !== null) {
      edgePathDirs.push(isHorizontalPath(pm[1]));
    }
  }

  if (edgePathDirs.length > 0) {
    let labelIdx = 0;
    const labelOffset = Math.round(fontSize * 0.85);
    svg = svg.replace(
      /<g\b[^>]*\bclass="edgeLabel"[^>]*>/g,
      (tag) => {
        const isHoriz = labelIdx < edgePathDirs.length ? edgePathDirs[labelIdx] : false;
        labelIdx++;
        if (!isHoriz) return tag;
        return tag.replace(
          /translate\(([^,)]+)[,\s]+([^)]+)\)/,
          (_, xStr, yStr) => {
            stats.edgeLabelShifts++;
            return `translate(${xStr}, ${parseFloat(yStr) - labelOffset})`;
          }
        );
      }
    );
  }

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

/**
 * Extract start and end coordinates from an SVG path d-attribute.
 * Handles M, L, C, Q commands by taking first M and last coordinate pair.
 */
function getPathEndpoints(d) {
  const mMatch = d.match(/M\s*([-+]?\d*\.?\d+)[,\s]+([-+]?\d*\.?\d+)/);
  if (!mMatch) return null;
  const start = { x: parseFloat(mMatch[1]), y: parseFloat(mMatch[2]) };
  const nums = [...d.matchAll(/([-+]?\d*\.?\d+)/g)].map(m => parseFloat(m[1]));
  if (nums.length < 4) return null;
  const end = { x: nums[nums.length - 2], y: nums[nums.length - 1] };
  return { start, end };
}

/**
 * Determine whether an SVG path is predominantly horizontal.
 * Returns true if the angle between start and end points is within
 * thresholdDeg of the horizontal axis.
 */
function isHorizontalPath(d, thresholdDeg = 60) {
  const ep = getPathEndpoints(d);
  if (!ep) return false;
  const dx = Math.abs(ep.end.x - ep.start.x);
  const dy = Math.abs(ep.end.y - ep.start.y);
  if (dx === 0 && dy === 0) return false;
  return Math.atan2(dy, dx) * (180 / Math.PI) <= thresholdDeg;
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
    await renderWithMmdc(opts);
  }
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
