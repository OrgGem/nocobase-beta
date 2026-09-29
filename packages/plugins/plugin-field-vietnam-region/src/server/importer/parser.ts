import { ImportFormat, RawRegionRow } from './types';

export interface FlatRegion {
  code: string;
  name: string;
  level: number;
  parentCode?: string;
}

// A tree node used during normalization before flattening into DB rows.
interface TreeNode {
  // Grouping key: normalized (prefix-stripped, lower-cased) name for de-duplication.
  key: string;
  // Display name preserved verbatim as it appears in the source data.
  name: string;
  code?: string;
  children: Map<string, TreeNode>;
}

// Vietnam post-2025 administrative structure is two levels: province -> commune.
export const PROVINCE_LEVEL = 1;
export const COMMUNE_LEVEL = 2;

// Normalizes a name for grouping only: strips type prefixes and lower-cases so that
// "Phường A" and "A" are treated as the same node. The verbatim name is still stored.
function normalizeKey(value: unknown): string {
  if (value == null) {
    return '';
  }
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/^\s*(tp\.?|thanh phố|thành phố|tỉnh|t\.p)\.?\s+/, '')
    .replace(/^\s*(xã|phường|thị trấn|đặc khu|thị xã)\s+/, '')
    .replace(/\s+/g, ' ');
}

function displayOf(value: unknown): string {
  return String(value == null ? '' : value)
    .trim()
    .replace(/\s+/g, ' ');
}

function getCode(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  const code = String(value).trim();
  return code.length ? code : undefined;
}

export function detectFormat(filename: string): ImportFormat | undefined {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.json')) {
    return 'json';
  }
  if (lower.endsWith('.csv')) {
    return 'csv';
  }
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    return 'xlsx';
  }
  return undefined;
}

function findKey(row: RawRegionRow, candidates: string[]): string | undefined {
  for (const key of candidates) {
    if (row[key] !== undefined) {
      return key;
    }
  }
  const keys = Object.keys(row);
  for (const key of keys) {
    const normalized = key.toLowerCase().replace(/[\s_-]/g, '');
    if (candidates.some((candidate) => candidate.toLowerCase().replace(/[\s_-]/g, '') === normalized)) {
      return key;
    }
  }
  return undefined;
}

function findColumnIndex(header: string[], candidates: string[]): number {
  const normalizedCandidates = candidates.map((candidate) => candidate.toLowerCase().replace(/[\s_-]/g, ''));
  for (let i = 0; i < header.length; i++) {
    const normalized = header[i].toLowerCase().replace(/[\s_-]/g, '');
    if (normalizedCandidates.includes(normalized)) {
      return i;
    }
  }
  return -1;
}

const PROVINCE_KEYS = ['province', 'tinh', 'tp', 'thanhpho', 'tinhthanh', 'province_name'];
const COMMUNE_KEYS = ['commune', 'xaphuong', 'phuong', 'xa', 'thitran', 'thixax', 'daccu', 'commune_name'];
const PROVINCE_CODE_KEYS = ['province_code', 'tinh_code', 'matinh'];
const COMMUNE_CODE_KEYS = ['commune_code', 'xa_code', 'maxa'];

function isFlatJson(data: unknown): data is RawRegionRow[] {
  if (!Array.isArray(data) || !data.length) {
    return false;
  }
  const first = data[0] as RawRegionRow;
  return 'code' in first && 'name' in first && 'level' in first;
}

// Rebuild a province->commune tree from already-flat rows carrying code/name/level/parentCode.
function buildTreeFromFlatRows(rows: RawRegionRow[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const byCode = new Map<string, TreeNode>();
  const parentOf = new Map<string, string>();

  for (const row of rows) {
    const code = getCode(row.code);
    const name = displayOf(row.name);
    if (!code || !name) {
      continue;
    }
    const level = Number(row.level);
    const node: TreeNode = { key: normalizeKey(name), name, code, children: new Map() };
    byCode.set(code, node);
    if (row.parentCode != null) {
      const parentCode = getCode(row.parentCode);
      if (parentCode) {
        parentOf.set(code, parentCode);
      }
    }
    if (level === PROVINCE_LEVEL) {
      roots.push(node);
    }
  }

  for (const [code, node] of byCode) {
    const parentCode = parentOf.get(code);
    if (parentCode && parentCode !== code) {
      const parent = byCode.get(parentCode);
      if (parent && parent !== node) {
        parent.children.set(node.key, node);
      }
    }
  }

  return roots;
}

function parseJsonTree(content: string): TreeNode[] {
  const data = JSON.parse(content);
  if (isFlatJson(data)) {
    return buildTreeFromFlatRows(data);
  }
  const roots: TreeNode[] = [];
  const findRoot = (key: string) => roots.find((node) => node.key === key);

  if (Array.isArray(data)) {
    for (const row of data as RawRegionRow[]) {
      const provinceRaw = row[findKey(row, PROVINCE_KEYS) || 'province'];
      const communeRaw = row[findKey(row, COMMUNE_KEYS) || 'commune'];
      const provinceKey = normalizeKey(provinceRaw);
      const communeKey = normalizeKey(communeRaw);
      if (!provinceKey) {
        continue;
      }
      let province = findRoot(provinceKey);
      if (!province) {
        province = {
          key: provinceKey,
          name: displayOf(provinceRaw),
          code: getCode(row[findKey(row, PROVINCE_CODE_KEYS) || 'province_code']),
          children: new Map(),
        };
        roots.push(province);
      }
      if (!communeKey) {
        continue;
      }
      if (!province.children.has(communeKey)) {
        province.children.set(communeKey, {
          key: communeKey,
          name: displayOf(communeRaw),
          code: getCode(row[findKey(row, COMMUNE_CODE_KEYS) || 'commune_code']),
          children: new Map(),
        });
      }
    }
    return roots;
  }

  if (data && typeof data === 'object') {
    // Object map: { "Hà Nội": ["Phường A", "Xã B", ...], ... }
    for (const [provinceNameRaw, communes] of Object.entries(data as Record<string, unknown>)) {
      const provinceKey = normalizeKey(provinceNameRaw);
      if (!provinceKey || !Array.isArray(communes)) {
        continue;
      }
      const province: TreeNode = {
        key: provinceKey,
        name: displayOf(provinceNameRaw),
        code: undefined,
        children: new Map(),
      };
      for (const communeNameRaw of communes) {
        const communeKey = normalizeKey(communeNameRaw);
        if (communeKey) {
          province.children.set(communeKey, {
            key: communeKey,
            name: displayOf(communeNameRaw),
            code: undefined,
            children: new Map(),
          });
        }
      }
      roots.push(province);
    }
  }

  return roots;
}

function parseCsvTree(content: string): TreeNode[] {
  const rows = parseCsv(content);
  const roots: TreeNode[] = [];
  if (!rows.length) {
    return roots;
  }
  const header = rows[0];
  const provinceIdx = findColumnIndex(header, PROVINCE_KEYS);
  const communeIdx = findColumnIndex(header, COMMUNE_KEYS);
  const provinceCodeIdx = findColumnIndex(header, PROVINCE_CODE_KEYS);
  const communeCodeIdx = findColumnIndex(header, COMMUNE_CODE_KEYS);

  const read = (row: string[], idx: number) => (idx >= 0 ? row[idx] : '');

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const provinceKey = normalizeKey(read(row, provinceIdx));
    if (!provinceKey) {
      continue;
    }
    let province = roots.find((node) => node.key === provinceKey);
    if (!province) {
      province = {
        key: provinceKey,
        name: displayOf(read(row, provinceIdx)),
        code: getCode(read(row, provinceCodeIdx)),
        children: new Map(),
      };
      roots.push(province);
    }
    const communeKey = normalizeKey(read(row, communeIdx));
    if (!communeKey) {
      continue;
    }
    if (!province.children.has(communeKey)) {
      province.children.set(communeKey, {
        key: communeKey,
        name: displayOf(read(row, communeIdx)),
        code: getCode(read(row, communeCodeIdx)),
        children: new Map(),
      });
    }
  }
  return roots;
}

// Minimal RFC4180 CSV parser supporting quoted fields and CRLF.
export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char === '\r') {
      // swallow; handled with following \n
    } else {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

// Flatten a normalized tree into DB-ready rows, generating sequential codes for nodes
// that did not carry an explicit code.
export function treeToFlatRows(roots: TreeNode[]): FlatRegion[] {
  const rows: FlatRegion[] = [];
  let counter = 0;
  const nextCode = (prefix: string, parentCode: string) =>
    `${prefix}${parentCode}${String(++counter).padStart(5, '0')}`;

  for (const province of roots) {
    const provinceCode = province.code || nextCode('VN', '');
    rows.push({ code: provinceCode, name: province.name, level: PROVINCE_LEVEL });
    for (const commune of province.children.values()) {
      const communeCode = commune.code || nextCode('C', provinceCode);
      rows.push({ code: communeCode, name: commune.name, level: COMMUNE_LEVEL, parentCode: provinceCode });
    }
  }
  return rows;
}

export function parseTree(content: Buffer | string, format: ImportFormat): TreeNode[] {
  if (format === 'json') {
    return parseJsonTree(content.toString('utf-8'));
  }
  if (format === 'csv') {
    return parseCsvTree(content.toString('utf-8'));
  }
  return [];
}

export function excelToTree(content: Buffer, sheetName?: string): TreeNode[] {
  // Imported lazily so the plugin does not hard-depend on xlsx at module load.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const XLSX = require('xlsx');
  const workbook = XLSX.read(content, { type: 'buffer' });
  const sheet = sheetName && workbook.SheetNames.includes(sheetName) ? sheetName : workbook.SheetNames[0];
  const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheet]);
  return parseCsvTree(csv);
}
