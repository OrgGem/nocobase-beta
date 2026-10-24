import type { APIClient, ThemeConfig } from '@nocobase/client-v2';
import { theme } from 'antd';

type ThemeApi = Pick<APIClient, 'request'>;
type ThemeId = number | string;
type StoredConfig = Omit<ThemeConfig, 'algorithm'> & {
  algorithm?: ThemeConfig['algorithm'] | string | string[];
};
export interface StoredThemeItem {
  id: ThemeId;
  config: StoredConfig | null;
  optional?: boolean;
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

export function normalizeTheme(config: ThemeConfig | null, fallback: ThemeConfig): ThemeConfig {
  return config
    ? { ...config, token: { ...config.token, motionUnit: config.token?.motionUnit ?? fallback.token?.motionUnit } }
    : fallback;
}

export function getUserThemeId(user: unknown): ThemeId | undefined {
  if (!user || typeof user !== 'object' || !('systemSettings' in user)) return;
  const settings = user.systemSettings;
  if (!settings || typeof settings !== 'object' || !('themeId' in settings)) return;
  return typeof settings.themeId === 'number' || typeof settings.themeId === 'string' ? settings.themeId : undefined;
}

export function getEffectiveTheme(items: ThemeItem[], id?: ThemeId): ThemeItem | undefined {
  return items.find((item) => id != null && String(item.id) === String(id)) || items.find((item) => item.default);
}

export async function listThemes(api: ThemeApi): Promise<ThemeItem[]> {
  const response = await api.request<{ data: StoredThemeItem[] }>({
    url: 'antdStyleThemeConfig:list',
    params: { sort: 'id', paginate: false },
  });
  return response.data.data.map(deserializeTheme);
}

export async function updateUserTheme(api: ThemeApi, themeId: ThemeId) {
  await api.request({ url: 'users:updateAntdStyleTheme', method: 'post', data: { themeId } });
}
