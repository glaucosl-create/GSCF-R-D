import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { createWorker } = require('tesseract.js');

const pdfPath = process.argv[2];
if (!pdfPath) {
  console.error('PDF nao informado.');
  process.exit(1);
}

const poppler = process.env.POPPLER_PDFTOPPM || (process.platform === 'win32'
  ? 'C:\\Users\\limag\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\native\\poppler\\Library\\bin\\pdftoppm.exe'
  : 'pdftoppm');
const tempDir = mkdtempSync(join(tmpdir(), 'finance-ocr-'));
const prefix = join(tempDir, 'page');
let worker;
const dateRegex = /\b\d{1,2}\s*(?:[/.-]\s*\d{1,2}|\s+[A-Za-zÀ-ÿ]{3,9})\b/g;
const moneyRegex = /(?:R\$\s*)?-?\d{1,3}(?:\.\d{3})*,\d{2}-?/g;
const totalLineRegex = /^\s*(?:total|subtotal)\b/i;

function pngSize(path) {
  const buffer = readFileSync(path);
  if (buffer.toString('ascii', 1, 4) !== 'PNG') throw new Error('Imagem OCR invalida.');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function likelyInterleavedColumns(text) {
  return String(text || '').split(/\r?\n/).some(line => (
    (line.match(dateRegex) || []).length >= 2
    && (line.match(moneyRegex) || []).length >= 2
  ));
}

function columnsText(leftText, rightText) {
  const regularLines = [];
  const totalLines = [];
  for (const text of [leftText, rightText]) {
    for (const line of String(text || '').split(/\r?\n/)) {
      if (totalLineRegex.test(line)) totalLines.push(line);
      else regularLines.push(line);
    }
  }
  return [...regularLines, ...totalLines].filter(line => line.trim()).join('\n');
}

async function recognizeText(imagePath, options = {}) {
  const result = await worker.recognize(imagePath, options);
  return result.data.text || '';
}

try {
  const rendered = spawnSync(poppler, ['-png', '-r', '180', pdfPath, prefix], { encoding: 'utf8' });
  if (rendered.status !== 0) {
    console.error(rendered.stderr || 'Falha ao renderizar PDF para OCR.');
    process.exit(rendered.status || 1);
  }

  const images = readdirSync(tempDir).filter(file => file.endsWith('.png')).sort();
  const pages = [];
  worker = await createWorker('por+eng', 1, { logger: () => {} });
  for (const image of images) {
    const imagePath = join(tempDir, image);
    let text = await recognizeText(imagePath);
    if (likelyInterleavedColumns(text)) {
      try {
        const { width, height } = pngSize(imagePath);
        const split = Math.floor(width * 0.58);
        const leftText = await recognizeText(imagePath, { rectangle: { left: 0, top: 0, width: split, height } });
        const rightText = await recognizeText(imagePath, { rectangle: { left: split, top: 0, width: width - split, height } });
        const splitText = columnsText(leftText, rightText);
        if (splitText.trim()) text = splitText;
      } catch {
        // Keep the full-page OCR result if cropped OCR is unavailable.
      }
    }
    pages.push(text);
  }
  process.stdout.write(pages.join('\n'));
} finally {
  if (worker) await worker.terminate().catch(() => {});
  rmSync(tempDir, { recursive: true, force: true });
}
