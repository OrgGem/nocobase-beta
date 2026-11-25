// SPDX-License-Identifier: Apache-2.0

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes / 1024;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIdx]}`;
}

export function formatDurationSeconds(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) {
    return '—';
  }
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days > 0) {
    return `${days}d ${hours}h ${mins}m`;
  }
  if (hours > 0) {
    return `${hours}h ${mins}m ${secs}s`;
  }
  if (mins > 0) {
    return `${mins}m ${secs}s`;
  }
  return `${secs}s`;
}

export function getErrorMessage(err: unknown, fallback = 'Operation failed'): string {
  if (!err) return fallback;
  if (typeof err === 'object') {
    const rec = err as {
      response?: { data?: { errors?: Array<{ message?: string }>; message?: string } };
      message?: string;
    };
    const apiErr = rec.response?.data?.errors?.[0]?.message ?? rec.response?.data?.message;
    if (apiErr) return apiErr;
    if (rec.message) return rec.message;
  }
  return typeof err === 'string' ? err : fallback;
}
