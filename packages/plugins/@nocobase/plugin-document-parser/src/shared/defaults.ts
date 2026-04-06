/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Single source of truth for default settings values.
 * Shared between server (ParseRouter / resource handlers) and client (GlobalSettings).
 */
export const DEFAULT_SETTINGS = {
  mode: 'default' as const,
  fallbackToDefault: true,
  imagePassThrough: true,
  includedExtnames: [] as string[],
  useDocpixie: false,
} as const;
