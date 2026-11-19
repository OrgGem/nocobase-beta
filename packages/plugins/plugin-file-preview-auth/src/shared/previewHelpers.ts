// SPDX-License-Identifier: Apache-2.0

const MAX_CACHED_BLOBS = 20;

const INTERNAL_AUTHENTICATED_DOWNLOAD_PATHS = [
  '/api/filePreviewAuth:download',
  '/api/extStorage:download',
  '/api/skillHub:download',
  '/api/worker-monitor',
  '/api/carboneTemplates:download',
  '/api/attachments:stream',
  '/api/attachments:sftpStream',
];

export function isInternalAuthenticatedDownloadUrl(url: string): boolean {
  if (!url) return false;
  try {
    const baseOrigin = typeof location !== 'undefined' ? location.origin : 'http://local';
    const parsed = new URL(url, baseOrigin);
    if (parsed.origin !== baseOrigin) {
      return false;
    }
    return INTERNAL_AUTHENTICATED_DOWNLOAD_PATHS.some(
      (pathname) =>
        parsed.pathname === pathname ||
        parsed.pathname.startsWith(`${pathname}/`) ||
        parsed.pathname.startsWith(`${pathname}:`),
    );
  } catch {
    return false;
  }
}

export function toPdfBlob(blob: Blob): Blob {
  if (blob.type === 'application/pdf') {
    return blob;
  }
  return new Blob([blob], { type: 'application/pdf' });
}

export interface LruBlobCache {
  getOrLoad(token: string, key: string, loader: () => Promise<Blob>): Promise<Blob>;
  clear(): void;
  size(): number;
}

export function createLruBlobCache(maxEntries = MAX_CACHED_BLOBS): LruBlobCache {
  const entries = new Map<string, Promise<Blob>>();
  let activeToken: string | null = null;

  return {
    getOrLoad(token: string, key: string, loader: () => Promise<Blob>): Promise<Blob> {
      if (activeToken !== null && activeToken !== token) {
        entries.clear();
      }
      activeToken = token;

      const existing = entries.get(key);
      if (existing) {
        entries.delete(key);
        entries.set(key, existing);
        return existing;
      }

      const pending = loader().catch((err) => {
        if (entries.get(key) === pending) {
          entries.delete(key);
        }
        throw err;
      });

      if (entries.size >= maxEntries) {
        const oldestKey = entries.keys().next().value;
        if (oldestKey !== undefined) {
          entries.delete(oldestKey);
        }
      }
      entries.set(key, pending);
      return pending;
    },
    clear() {
      entries.clear();
      activeToken = null;
    },
    size() {
      return entries.size;
    },
  };
}

export interface ParsedWorkbookSheets {
  sheetNames: string[];
  sheetsRows: Record<string, string[][]>;
}

interface SheetJsWorkbookLike {
  SheetNames: string[];
  Sheets: Record<string, unknown>;
}

interface SheetJsUtilsLike {
  sheet_to_json: <T = unknown>(sheet: unknown, options: { header: number; defval: string }) => T[];
}

export function parseXlsxSheetsToRows(workbook: SheetJsWorkbookLike, utils: SheetJsUtilsLike): ParsedWorkbookSheets {
  const sheetNames = Array.isArray(workbook.SheetNames) ? workbook.SheetNames : [];
  const sheetsRows: Record<string, string[][]> = {};

  for (const name of sheetNames) {
    const sheet = workbook.Sheets[name];
    const rawRows = utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
    const rows = rawRows.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : []));
    while (rows.length > 0 && rows[rows.length - 1].every((cell) => cell.trim() === '')) {
      rows.pop();
    }
    sheetsRows[name] = rows;
  }

  return { sheetNames, sheetsRows };
}
