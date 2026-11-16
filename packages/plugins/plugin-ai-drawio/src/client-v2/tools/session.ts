// SPDX-License-Identifier: Apache-2.0

/**
 * Session resolution - simplified for single global diagram.
 * Kept for backward compatibility but returns a constant.
 */
export function resolveSessionId(_app: unknown): string {
  return 'global';
}
