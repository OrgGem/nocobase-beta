/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context } from '@nocobase/actions';
import * as XLSX from 'xlsx';

// Local copies of plugin-document-parser contracts — avoids a compile-time dependency.

interface AttachmentLike {
  id?: string | number;
  filename?: string;
  name?: string;
  mimetype?: string;
  extname?: string;
  url?: string;
  storageId?: number;
  size?: number;
  meta?: Record<string, any>;
  [key: string]: any;
}

interface InternalParseResult {
  text: string;
  handled: boolean;
}

export interface InternalParserHandler {
  name: string;
  supports(attachment: AttachmentLike): boolean;
  parse(attachment: AttachmentLike, ctx: Context): Promise<InternalParseResult>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const XLSX_EXTNAMES = new Set(['.xlsx', '.xls']);
const XLSX_MIMETYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]);

function resolveExtname(attachment: AttachmentLike): string {
  if (attachment.extname) return attachment.extname.toLowerCase();
  const name = attachment.filename ?? attachment.name ?? '';
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * Server-side Excel parser handler.
 *
 * Uses SheetJS (xlsx) — the same library already bundled by this plugin for
 * client-side XLSX preview — to extract plain text from .xlsx/.xls files on
 * the server.
 *
 * Each worksheet is converted to CSV and separated by a section header so LLMs
 * can distinguish sheet boundaries:
 *
 *   === Sheet: Sheet1 ===
 *   col1,col2,col3
 *   val1,val2,val3
 *
 *   === Sheet: Sheet2 ===
 *   ...
 *
 * This handler is registered into plugin-document-parser's InternalParserRegistry
 * by PluginFilePreviewAuthServer with `prepend: true` so it takes priority over
 * any other handlers that might be registered later.
 *
 * File bytes are fetched via plugin-document-parser's public `fetchFileBuffer`
 * helper, which transparently handles both S3 URLs and local file paths.
 */
export class ExcelParserHandler implements InternalParserHandler {
  readonly name = 'file-preview-auth-excel-parser';

  supports(attachment: AttachmentLike): boolean {
    if (attachment.mimetype && XLSX_MIMETYPES.has(attachment.mimetype)) return true;
    return XLSX_EXTNAMES.has(resolveExtname(attachment));
  }

  async parse(attachment: AttachmentLike, ctx: Context): Promise<InternalParseResult> {
    const docParserPlugin = (ctx.app as any).pm?.get('@nocobase/plugin-document-parser') as any;
    if (!docParserPlugin?.fetchFileBuffer) {
      ctx.log?.warn?.('[ExcelParser] plugin-document-parser not available — cannot fetch file bytes');
      return { text: '', handled: false };
    }

    const { buffer } = await docParserPlugin.fetchFileBuffer(ctx, attachment);

    const workbook = XLSX.read(buffer, { type: 'buffer' });

    const parts: string[] = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: '' }) as string[][];
      // Drop trailing fully-empty rows
      while (rows.length > 0 && rows[rows.length - 1].every((c) => String(c).trim() === '')) {
        rows.pop();
      }
      if (rows.length === 0) continue;

      const escape = (v: any) =>
        String(v ?? '')
          .replace(/\|/g, '\\|')
          .replace(/\n/g, ' ');
      const toRow = (cells: string[], colCount: number) => {
        const padded = Array.from({ length: colCount }, (_, i) => escape(cells[i] ?? ''));
        return `| ${padded.join(' | ')} |`;
      };

      const colCount = Math.max(...rows.map((r) => r.length));
      const header = toRow(rows[0], colCount);
      const separator = `| ${Array(colCount).fill('---').join(' | ')} |`;
      const body = rows.slice(1).map((r) => toRow(r, colCount));

      parts.push(`### Sheet: ${sheetName}\n\n${[header, separator, ...body].join('\n')}`);
    }

    return { text: parts.join('\n\n'), handled: true };
  }
}
