// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'child_process';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';

export interface OcrRect {
  x: number;
  y: number;
  width: number;
  height: number;
  unit: string;
}

export interface OcrWordItem {
  id: string;
  key: string;
  value: string;
  page: number;
  confidence: number;
  rect: OcrRect;
  status: string;
}

const MAX_STDERR_BYTES = 64 * 1024;
const OCR_COMMAND_TIMEOUT_MS = Math.max(
  5_000,
  Number.parseInt(process.env.FILE_PREVIEW_OCR_CMD_TIMEOUT_MS || '', 10) || 120_000,
);
const OCR_PDF_MAX_PAGES = Math.max(1, Number.parseInt(process.env.FILE_PREVIEW_OCR_MAX_PAGES || '', 10) || 50);

export class TesseractRunner {
  private readonly commandTimeoutMs: number;
  private readonly maxPdfPages: number;

  constructor(_app?: unknown, options?: { commandTimeoutMs?: number; maxPdfPages?: number }) {
    this.commandTimeoutMs = options?.commandTimeoutMs ?? OCR_COMMAND_TIMEOUT_MS;
    this.maxPdfPages = options?.maxPdfPages ?? OCR_PDF_MAX_PAGES;
  }

  async runOcr(
    filePath: string,
    _attachmentId: number | string,
  ): Promise<{ pages: Array<{ page_number: number; items: OcrWordItem[] }> }> {
    if (!existsSync(filePath)) throw new Error('OCR input file not found');
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nocobase-ocr-'));
    try {
      const imagePaths =
        path.extname(filePath).toLowerCase() === '.pdf' ? await this.convertPdfToImages(filePath, tempDir) : [filePath];
      if (!imagePaths.length) throw new Error('PDF conversion produced no pages');
      const pages: Array<{ page_number: number; items: OcrWordItem[] }> = [];
      for (let i = 0; i < imagePaths.length; i++) {
        const outBase = path.join(tempDir, `page_${i + 1}_raw`);
        await this.executeTesseract(imagePaths[i], outBase);
        const tsvContent = await fs.readFile(`${outBase}.tsv`, 'utf-8');
        pages.push({ page_number: i + 1, items: this.parseTsv(tsvContent, i + 1) });
      }
      return { pages };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  private executeTesseract(imagePath: string, outputPathBase: string): Promise<void> {
    return this.runCommand('tesseract', [imagePath, outputPathBase, '-l', 'eng+vie', 'tsv']);
  }

  private runCommand(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      let settled = false;
      let stderr = '';
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };

      const timer = setTimeout(() => {
        try {
          child.kill?.('SIGKILL');
        } catch {
          // Ignore kill errors if the process already exited.
        }
        finish(new Error(`${command} timed out after ${this.commandTimeoutMs}ms`));
      }, this.commandTimeoutMs);
      timer.unref?.();

      child.stderr?.on('data', (data) => {
        if (stderr.length < MAX_STDERR_BYTES) {
          stderr += data.toString().slice(0, MAX_STDERR_BYTES - stderr.length);
        }
      });

      child.on('close', (code) => {
        if (code === 0) {
          finish();
        } else {
          finish(new Error(`${command} exited with code ${code}. Stderr: ${stderr}`));
        }
      });

      child.on('error', (err) => {
        finish(err);
      });
    });
  }

  private parseTsv(tsvContent: string, pageNum: number): OcrWordItem[] {
    const lines = tsvContent.split('\n');
    const items: OcrWordItem[] = [];

    const headers = lines[0].split('\t').map((h) => h.trim());
    const required = [
      'level',
      'block_num',
      'par_num',
      'line_num',
      'word_num',
      'left',
      'top',
      'width',
      'height',
      'conf',
      'text',
    ];
    if (!required.every((header) => headers.includes(header))) throw new Error('Invalid OCR TSV output');

    // Pass 1: Tìm kích thước trang ảnh gốc ở level = 1
    let pageWidth = 0;
    let pageHeight = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].replace(/\r$/, '');
      if (!line) continue;

      const cols = line.split('\t');
      if (cols.length < headers.length) throw new Error('Invalid OCR TSV row');

      const level = parseInt(cols[headers.indexOf('level')], 10);
      if (level === 1) {
        pageWidth = parseInt(cols[headers.indexOf('width')], 10);
        pageHeight = parseInt(cols[headers.indexOf('height')], 10);
        break;
      }
    }

    if (!(pageWidth > 0 && pageHeight > 0)) throw new Error('Invalid OCR page dimensions');

    // Pass 2: Parse toàn bộ từ đơn ở level = 5
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].replace(/\r$/, '');
      if (!line) continue;

      const cols = line.split('\t');
      if (cols.length < headers.length) throw new Error('Invalid OCR TSV row');

      const row: Record<string, string> = {};
      headers.forEach((header, idx) => {
        row[header] = cols[idx];
      });

      const level = parseInt(row['level'], 10);
      const text = row['text']?.trim();
      const conf = parseFloat(row['conf']);

      // level = 5 là cấp độ Từ (Word level) của Tesseract
      if (level === 5 && text && conf > 0) {
        const blockNum = row['block_num'];
        const paragraphNum = row['par_num'];
        const lineNum = row['line_num'];
        const wordNum = row['word_num'];

        const left = parseInt(row['left'], 10);
        const top = parseInt(row['top'], 10);
        const width = parseInt(row['width'], 10);
        const height = parseInt(row['height'], 10);

        if (![left, top, width, height].every(Number.isFinite)) throw new Error('Invalid OCR word coordinates');

        // Chuẩn hóa tọa độ thành tỉ lệ phần trăm (0.0 - 1.0) so với ảnh gốc
        const x_norm = left / pageWidth;
        const y_norm = top / pageHeight;
        const w_norm = width / pageWidth;
        const h_norm = height / pageHeight;

        items.push({
          id: `w_p${pageNum}_b${blockNum}_p${paragraphNum}_l${lineNum}_w${wordNum}`,
          key: `P${pageNum}_B${blockNum}_P${paragraphNum}_L${lineNum}_W${wordNum}`,
          value: text,
          page: pageNum,
          confidence: conf / 100,
          rect: {
            x: x_norm,
            y: y_norm,
            width: w_norm,
            height: h_norm,
            unit: 'normalized', // Đơn vị chuẩn hóa giúp PdfJsViewer tự động scale trên mọi kích cỡ màn hình!
          },
          status: 'pending',
        });
      }
    }

    return items;
  }

  private async convertPdfToImages(pdfPath: string, outputDir: string): Promise<string[]> {
    await this.runCommand('pdftoppm', [
      '-png',
      '-r',
      '150',
      '-f',
      '1',
      '-l',
      String(this.maxPdfPages),
      pdfPath,
      path.join(outputDir, 'page'),
    ]);
    const files = await fs.readdir(outputDir);
    return files
      .filter((f) => f.startsWith('page-') && f.endsWith('.png'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((f) => path.join(outputDir, f));
  }
}
