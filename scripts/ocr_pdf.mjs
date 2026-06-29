import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { recognize } = require('tesseract.js');

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

try {
  const rendered = spawnSync(poppler, ['-png', '-r', '180', pdfPath, prefix], { encoding: 'utf8' });
  if (rendered.status !== 0) {
    console.error(rendered.stderr || 'Falha ao renderizar PDF para OCR.');
    process.exit(rendered.status || 1);
  }

  const images = readdirSync(tempDir).filter(file => file.endsWith('.png')).sort();
  const pages = [];
  for (const image of images) {
    const result = await recognize(join(tempDir, image), 'por+eng', { logger: () => {} });
    pages.push(result.data.text || '');
  }
  process.stdout.write(pages.join('\n'));
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
