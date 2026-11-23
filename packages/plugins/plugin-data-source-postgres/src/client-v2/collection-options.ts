/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function toCollectionOptions(result: unknown): { label: string; value: string }[] {
  const data = isRecord(result) ? result.data : result;
  const list = isRecord(data) ? data.data : data;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item: unknown) => {
    const name = typeof item === 'string' ? item : isRecord(item) ? item.name : undefined;
    return typeof name === 'string' ? [{ label: name, value: name }] : [];
  });
}
