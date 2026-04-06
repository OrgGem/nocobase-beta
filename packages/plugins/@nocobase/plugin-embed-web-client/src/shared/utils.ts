/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Shared utilities used by both server and client code.
 */

import { join, resolve } from 'path';

/**
 * Safely join a path ensuring no traversal outside the root directory.
 * Throws on path traversal attempts.
 */
export function safeJoin(root: string, ...parts: string[]): string {
  const resolved = resolve(root, join(...parts));
  if (!resolved.startsWith(root)) {
    throw new Error('Path traversal detected');
  }
  return resolved;
}

/**
 * Validate that a value is a safe integer within the valid PGVector dimensions range.
 * Returns the validated integer or throws.
 */
export function validateDimensions(value: unknown): number {
  const dims = Math.floor(Number(value));
  if (!Number.isInteger(dims) || dims < 1 || dims > 4096) {
    throw new Error(`Invalid dimensions: ${value}. Must be an integer between 1 and 4096.`);
  }
  return dims;
}
