import { Database } from '@nocobase/database';

export type ImportFormat = 'json' | 'csv' | 'xlsx';

export interface RawRegionRow {
  [column: string]: string | number | undefined | null;
}

export interface ImportResult {
  parsed: number;
  inserted: number;
  updated: number;
  unchanged: number;
  levels: number[];
  errors: string[];
}

export interface ImportOptions {
  db: Database;
  content: Buffer | string;
  format: ImportFormat;
  table?: string;
  provinceNameColumn?: string;
  districtNameColumn?: string;
  communeNameColumn?: string;
  provinceCodeColumn?: string;
  districtCodeColumn?: string;
  communeCodeColumn?: string;
  clearExisting?: boolean;
  dryRun?: boolean;
}
