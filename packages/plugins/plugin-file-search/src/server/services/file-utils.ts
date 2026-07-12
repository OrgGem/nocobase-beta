import crypto from 'crypto';
import path from 'path';

export function resolveExtname(file: Record<string, unknown>): string {
  const explicit = file.extname;
  if (typeof explicit === 'string' && explicit) {
    return normalizeExtname(explicit);
  }
  const name = file.filename || file.name;
  if (typeof name !== 'string') return '';
  const ext = path.extname(name);
  return normalizeExtname(ext);
}

export function normalizeExtname(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return '';
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

export function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function isDirectPageIndexFile(extname: string): boolean {
  return ['.pdf', '.md', '.markdown'].includes(normalizeExtname(extname));
}

export function getDisplayFilename(file: Record<string, unknown>): string {
  return String(file.filename || file.name || file.id || 'file');
}

export function getWorkerId() {
  return [process.env.HOSTNAME || process.env.COMPUTERNAME || 'worker', process.pid].join(':');
}

export function workerModeServesFileSearch() {
  const raw = process.env.WORKER_MODE || '';
  if (!raw || raw === 'main' || raw === 'app' || raw === '-') return false;
  if (raw === '*' || raw === 'worker' || raw === 'task') return true;
  return raw
    .split(',')
    .map((item) => item.trim())
    .some((item) => item === 'file-search:index' || item === 'plugin-file-search.index');
}
