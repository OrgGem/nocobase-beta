// SPDX-License-Identifier: Apache-2.0

import type { Context } from '@nocobase/actions';

export function normalizeRecordId(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
}

export function requireRecordId(ctx: Context, value: unknown): string {
  const id = normalizeRecordId(value);
  if (id === null) {
    ctx.throw(400, ctx.t('A valid single record ID is required', { ns: 'plugin-knowledge-base' }));
  }
  return id;
}
