// SPDX-License-Identifier: Apache-2.0

import type { APIClient, ThemeConfig } from '@nocobase/client-v2';
import { theme } from 'antd';
import type { ThemeId } from '../types';

export const THEME_STORAGE_KEY = 'antd-style-theme';
export const ANTD_STYLE_THEME_REFRESH_EVENT = 'antd-style-theme:refresh';

type ThemeApi = Pick<APIClient, 'request'>;
type StoredConfig = Omit<ThemeConfig, 'algorithm'> & {
  algorithm?: ThemeConfig['algorithm'] | string | string[];
};
export interface StoredThemeItem {
  id: ThemeId;
  config: StoredConfig | null;
  optional?: boolean;
  isBuiltIn?: boolean;
  uid?: string;
  default?: boolean;
}
export interface ThemeItem extends Omit<StoredThemeItem, 'config'> {
  config: ThemeConfig | null;
}
const algorithms = {
  defaultAlgorithm: theme.defaultAlgorithm,
  darkAlgorithm: theme.darkAlgorithm,
  compactAlgorithm: theme.compactAlgorithm,
};

function decodeAlgorithm(value: NonNullable<StoredConfig['algorithm']>) {
  const values = Array.isArray(value) ? value : [value];
  const decoded = values.flatMap((algorithm) => {
    if (typeof algorithm === 'function') return [algorithm];
    return Object.prototype.hasOwnProperty.call(algorithms, algorithm)
      ? [algorithms[algorithm as keyof typeof algorithms]]
      : [];
  });
  return Array.isArray(value) ? decoded : decoded[0];
}

export function isSameThemeId(a: unknown, b: unknown): boolean {
  return (
    (typeof a === 'number' || typeof a === 'string') &&
    (typeof b === 'number' || typeof b === 'string') &&
    String(a) === String(b)
  );
}

export function deserializeTheme(item: StoredThemeItem): ThemeItem {
  if (!item.config) return { ...item, config: null };
  const { algorithm, ...config } = item.config;
  return { ...item, config: { ...config, ...(algorithm ? { algorithm: decodeAlgorithm(algorithm) } : {}) } };
}

export function serializeTheme(item: ThemeItem): string {
  if (!item.config) return JSON.stringify(item);
  const { algorithm, ...config } = item.config;
  const values = Array.isArray(algorithm) ? algorithm : algorithm ? [algorithm] : [];
  const encoded = values.flatMap((value) => {
    const name = Object.entries(algorithms).find(([, fn]) => fn === value || fn.toString() === value.toString())?.[0];
    return name ? [name] : [];
  });
  return JSON.stringify({
    ...item,
    config: { ...config, ...(encoded.length ? { algorithm: Array.isArray(algorithm) ? encoded : encoded[0] } : {}) },
  });
}

export function normalizeTheme(config: ThemeConfig | null | undefined, fallback: ThemeConfig): ThemeConfig {
  if (!config) return fallback;
  const mergedToken = {
    ...fallback.token,
    ...config.token,
    motionUnit: config.token?.motionUnit ?? fallback.token?.motionUnit,
    colorSettings: config.token?.colorSettings ?? fallback.token?.colorSettings,
  };
  return { ...config, token: mergedToken };
}

export function getUserThemeId(user: unknown): ThemeId | undefined {
  if (!user || typeof user !== 'object' || !('systemSettings' in user)) return;
  const settings = user.systemSettings;
  if (!settings || typeof settings !== 'object') return;
  if ('antdStyleThemeId' in settings) {
    const preferredId = (settings as { antdStyleThemeId?: unknown }).antdStyleThemeId;
    if (preferredId === null) return undefined;
    if (typeof preferredId === 'number' || typeof preferredId === 'string') return preferredId;
  }
  if ('themeId' in settings) {
    const legacyId = (settings as { themeId?: unknown }).themeId;
    return typeof legacyId === 'number' || typeof legacyId === 'string' ? legacyId : undefined;
  }
}

export function getEffectiveTheme(items: ThemeItem[], id?: ThemeId): ThemeItem | undefined {
  return items.find((item) => isSameThemeId(item.id, id)) || items.find((item) => item.default);
}

export async function listThemes(api: ThemeApi): Promise<ThemeItem[]> {
  const response = await api.request<{ data: StoredThemeItem[] }>({
    url: 'antdStyleThemeConfig:list',
    params: { sort: 'id', paginate: false },
  });
  return response.data.data.map(deserializeTheme);
}

export async function updateUserTheme(api: ThemeApi, themeId: ThemeId | null) {
  await api.request({ url: 'users:updateAntdStyleTheme', method: 'post', data: { themeId } });
}
