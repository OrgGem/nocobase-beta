// SPDX-License-Identifier: Apache-2.0

import type { RcloneProviderOption } from '../../shared/types';

export function coerceRemoteParamsForForm(
  rawParams: Readonly<Record<string, unknown>>,
  providerOptions?: readonly RcloneProviderOption[],
): Record<string, unknown> {
  const coerced: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawParams)) {
    const opt = providerOptions?.find((item) => item.Name === key);
    const fieldType = (opt?.Type ?? '').toLowerCase();
    const isBool = Boolean(opt) && (fieldType === 'bool' || typeof opt?.Default === 'boolean');
    const isInt =
      Boolean(opt) &&
      (fieldType === 'int' || fieldType === 'int64' || fieldType === 'uint32') &&
      (!opt?.Examples || opt.Examples.length === 0);

    if (isBool && typeof value === 'string') {
      coerced[key] = value.trim().toLowerCase() === 'true';
    } else if (isInt && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      coerced[key] = Number(value);
    } else {
      coerced[key] = value;
    }
  }
  return coerced;
}

export function formatBytes(bytes: number | null | undefined): string {
  const num = Number(bytes ?? 0);
  if (!Number.isFinite(num) || num <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exp = Math.min(Math.floor(Math.log(num) / Math.log(1024)), units.length - 1);
  const val = num / 1024 ** exp;
  return `${val >= 100 || exp === 0 ? Math.round(val) : val.toFixed(val >= 10 ? 1 : 2)} ${units[exp]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '—';
  }
  const sec = Math.round(seconds);
  if (sec < 60) {
    return `${sec}s`;
  }
  const mins = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (mins < 60) {
    return `${mins}m ${remSec}s`;
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m`;
}

export function getErrorMessage(error: unknown, fallback = 'Request failed'): string {
  if (typeof error === 'string' && error.trim()) {
    return error;
  }
  if (error && typeof error === 'object') {
    const maybeResponse = (error as { response?: { data?: { errors?: Array<{ message?: string }> } } }).response;
    const apiMsg = maybeResponse?.data?.errors?.[0]?.message;
    if (apiMsg) {
      return apiMsg;
    }
    const directErrors = (error as { errors?: Array<{ message?: string }> }).errors;
    if (directErrors?.[0]?.message) {
      return directErrors[0].message;
    }
    if ('message' in error && typeof (error as { message?: unknown }).message === 'string') {
      return (error as { message: string }).message;
    }
  }
  return fallback;
}
