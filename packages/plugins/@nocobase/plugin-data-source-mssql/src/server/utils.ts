/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export const sanitize = (obj: any, depth = 3, seen = new WeakSet()) => {
  if (depth < 0) return '[DepthExceeded]';
  if (obj === null || typeof obj !== 'object') return obj;

  if (seen.has(obj)) {
    return '[Circular]';
  }

  seen.add(obj);

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitize(item, depth - 1, seen));
  }

  const result: any = {};
  for (const key of Object.keys(obj)) {
    result[key] = sanitize(obj[key], depth - 1, seen);
  }
  return result;
};
