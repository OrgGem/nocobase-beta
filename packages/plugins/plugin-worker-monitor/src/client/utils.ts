import { useApp } from '@nocobase/client';

const namespace = 'worker-monitor';

/**
 * Shared i18n hook for the worker-monitor plugin.
 */
export function useT() {
  const app = useApp();
  return (key: string) => app.i18n.t(key, { ns: namespace });
}

/**
 * Format bytes into human-readable string (B, KB, MB, GB).
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Format seconds into human-readable uptime string (e.g., "2d 5h 30m").
 */
export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}
