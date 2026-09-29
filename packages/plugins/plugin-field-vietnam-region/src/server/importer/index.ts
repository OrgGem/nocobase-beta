import { Database, Model } from '@nocobase/database';
import { detectFormat, excelToTree, parseTree, treeToFlatRows, FlatRegion } from './parser';
import { ImportFormat, ImportOptions, ImportResult } from './types';

const TABLE = 'vietnamRegions';

function toFlatRegions(content: Buffer | string, format: ImportFormat, sheet?: string): FlatRegion[] {
  if (format === 'xlsx') {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
    return treeToFlatRows(excelToTree(buffer, sheet));
  }
  return treeToFlatRows(parseTree(content, format));
}

async function upsertRegions(db: Database, rows: FlatRegion[], result: ImportResult) {
  const model = db.getModel(TABLE) as typeof Model;

  // Fetch all existing rows in one query and diff in memory, avoiding one query per row.
  const existingByCode = new Map<string, { name: string; level: number; parentCode?: string | null }>();
  const existingRows = (await model.findAll()) as unknown as Array<{
    code: string;
    name: string;
    level: number;
    parentCode?: string | null;
  }>;
  for (const existing of existingRows) {
    existingByCode.set(existing.code, existing);
  }

  for (const row of rows) {
    const existing = existingByCode.get(row.code);

    if (!existing) {
      result.inserted += 1;
      await model.create({ values: row });
      continue;
    }

    const changed =
      existing.name !== row.name || existing.level !== row.level || existing.parentCode !== row.parentCode;
    if (changed) {
      result.updated += 1;
      await model.update({
        values: { name: row.name, level: row.level, parentCode: row.parentCode ?? null },
        where: { code: row.code },
      });
    } else {
      result.unchanged += 1;
    }
  }
}

export async function importVietnamRegions(options: ImportOptions): Promise<ImportResult> {
  const { db, content, table, clearExisting, dryRun } = options;
  const format = options.format;
  const result: ImportResult = {
    parsed: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    levels: [],
    errors: [],
  };

  const rows = toFlatRegions(content, format, table);
  result.parsed = rows.length;
  result.levels = Array.from(new Set(rows.map((row) => row.level))).sort((a, b) => a - b);

  if (!rows.length) {
    result.errors.push('No valid region rows parsed from the input.');
    return result;
  }

  const model = db.getModel(TABLE) as typeof Model;

  if (dryRun) {
    return result;
  }

  if (clearExisting) {
    await model.destroy({ truncate: true, force: true });
  }

  await upsertRegions(db, rows, result);
  return result;
}

export async function importFromContent(
  db: Database,
  content: Buffer | string,
  filename: string,
  overrides: Partial<ImportOptions> = {},
): Promise<ImportResult> {
  const format = overrides.format || detectFormat(filename);
  if (!format) {
    throw new Error(`Cannot detect import format for "${filename}". Use --format json|csv|xlsx.`);
  }
  return importVietnamRegions({ db, content, format, ...overrides });
}
