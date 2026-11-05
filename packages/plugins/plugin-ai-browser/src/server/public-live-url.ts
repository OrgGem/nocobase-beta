/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

// Older sessions may contain a viewer URL derived from the privileged CDP URL.
// Keep backend credentials out of both REST responses and AI tool results.
export function publicLiveUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const viewer = new URL(value, 'http://viewer.invalid');
    if (viewer.username || viewer.password) return null;
    const backend = new URL(process.env.AI_BROWSER_CDP_URL || 'ws://browser:3000');
    const secrets = [backend.password];
    for (const [key, secret] of backend.searchParams) {
      if (/token|password|secret|api[-_]?key|auth/i.test(key)) secrets.push(secret);
    }
    const decoded = decodeURIComponent(value);
    if (secrets.some((secret) => secret && decoded.includes(decodeURIComponent(secret)))) return null;
    return value;
  } catch {
    return null;
  }
}
