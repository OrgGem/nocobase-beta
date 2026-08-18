import { createHash } from 'crypto';

export const sha256Hex = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex');

export const md5Hex = (input: string): string => createHash('md5').update(input, 'utf8').digest('hex');

// Collapse whitespace so formatting differences never fork the identity.
export const normalizeSelector = (selector: string): string => selector.trim().replace(/\s+/g, ' ');

// Identity key shared between client and registry. It hashes the element's
// logical identity (app + page + logical id), NOT the selector text, so the
// key survives DOM changes and keeps the healing history attached.
export const computeElementKey = (input: { app: string; pageUrlPattern?: string; logicalId?: string }): string => {
  const app = input.app.trim().toLowerCase();
  const page = (input.pageUrlPattern ?? '').trim().toLowerCase();
  const logicalId = (input.logicalId ?? '').trim();
  if (!logicalId) {
    throw new Error('computeElementKey requires a logicalId');
  }
  return sha256Hex(`${app}|${page}|${logicalId}`);
};

// Fast exact-match fingerprint of a selector's text.
export const selectorFingerprint = (selector: string): string => md5Hex(normalizeSelector(selector));

export const looksLikeDynamicId = (value: string): boolean =>
  /[-_](\d{2,}|[0-9a-f]{6,}|[A-Za-z0-9+/]{16,})$/i.test(value) ||
  /^(uid|guid|ext|gen)-/i.test(value) ||
  /\d{6,}/.test(value);

// Strip the volatile tail of a dynamic id so `[id^="prefix"]` anchors survive
// re-renders that rotate suffixes ("btn-submit-1234" -> "btn-submit").
export const stripDynamicSuffix = (value: string): string | null => {
  const match = value.match(/^(.+?)[-_:]((\d+)|([0-9a-f]{6,})|([A-Za-z0-9]{8,}))$/i);
  if (!match) return null;
  const prefix = match[1];
  return prefix.length >= 3 ? prefix : null;
};
