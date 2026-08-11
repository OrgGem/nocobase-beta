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
import type { AttachmentLike } from './internal-parser-registry';
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
export class BuiltinExcelHandler {
  readonly engine = 'excel' as const;

  supports(attachment: AttachmentLike): boolean {
    if (attachment.mimetype && XLSX_MIMETYPES.has(attachment.mimetype)) return true;
    return XLSX_EXTNAMES.has(resolveExtname(attachment));
  }

  async parseBuffer(_ctx: Context, buffer: Buffer, _attachment: AttachmentLike): Promise<string | null> {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const parts: string[] = [];

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: '' }) as string[][];

      while (rows.length > 0 && rows[rows.length - 1].every((cell) => String(cell).trim() === '')) {
        rows.pop();
      }
      if (rows.length === 0) continue;

      const escape = (value: unknown) =>
        String(value ?? '')
          .replace(/\|/g, '\\|')
          .replace(/\n/g, ' ');
      const columnCount = Math.max(...rows.map((row) => row.length));
      const toRow = (cells: string[]) =>
        `| ${Array.from({ length: columnCount }, (_, index) => escape(cells[index] ?? '')).join(' | ')} |`;
      const header = toRow(rows[0]);
      const separator = `| ${Array(columnCount).fill('---').join(' | ')} |`;
      const body = rows.slice(1).map(toRow);

      parts.push(`### Sheet: ${sheetName}\n\n${[header, separator, ...body].join('\n')}`);
    }

    return parts.join('\n\n') || null;
  }
}
