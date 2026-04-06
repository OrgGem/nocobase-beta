/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';
import * as XLSX from 'xlsx';
import type { InternalParserHandler, InternalParseResult, AttachmentLike } from './internal-parser-registry';
import { resolveExtname } from './utils';

const XLSX_EXTNAMES = new Set(['.xlsx', '.xls']);
const XLSX_MIMETYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]);

/**
 * Built-in Excel handler for plugin-document-parser.
 * Converts each worksheet to a Markdown table so LLMs can read spreadsheet content.
 * Registered with higher priority than BuiltinAIDocumentHandler (prepend: true).
 *
 * Uses the same SheetJS (xlsx) library as plugin-file-preview-auth's client-side
 * preview, but bundled server-side here as a direct dependency.
 */
export class BuiltinExcelHandler implements InternalParserHandler {
  readonly name = 'builtin-excel-handler';

  constructor(
    /** Injected file buffer fetcher — avoids circular pm.get() at runtime */
    private readonly getFileBuffer?: (
      ctx: Context,
      attachment: AttachmentLike,
    ) => Promise<{ buffer: Buffer; url: string }>,
  ) {}

  supports(attachment: AttachmentLike): boolean {
    if (attachment.mimetype && XLSX_MIMETYPES.has(attachment.mimetype)) return true;
    return XLSX_EXTNAMES.has(resolveExtname(attachment));
  }

  async parse(attachment: AttachmentLike, ctx: Context): Promise<InternalParseResult> {
    const fetchFn = this.getFileBuffer;
    if (!fetchFn) {
      ctx.log?.warn?.('[BuiltinExcelHandler] fetchFileBuffer not available');
      return { text: '', handled: false };
    }

    const { buffer } = await fetchFn(ctx, attachment);
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
      const colCount = Math.max(...rows.map((r) => r.length));
      const toRow = (cells: string[]) =>
        `| ${Array.from({ length: colCount }, (_, i) => escape(cells[i] ?? '')).join(' | ')} |`;

      const header = toRow(rows[0]);
      const separator = `| ${Array(colCount).fill('---').join(' | ')} |`;
      const body = rows.slice(1).map(toRow);

      parts.push(`### Sheet: ${sheetName}\n\n${[header, separator, ...body].join('\n')}`);
    }

    return { text: parts.join('\n\n'), handled: true };
  }
}
