import { theme } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import {
  deserializeTheme,
  getEffectiveTheme,
  getUserThemeId,
  listThemes,
  normalizeTheme,
  serializeTheme,
  updateUserTheme,
} from '../themeApi';

vi.mock('antd', () => ({
  theme: { defaultAlgorithm: () => 'default', darkAlgorithm: () => 'dark', compactAlgorithm: () => 'compact' },
}));

describe('V2 custom theme persistence', () => {
  it('restores scalar and combined algorithms without mutating the stored config', () => {
    const stored = {
      id: 1,
      config: { algorithm: ['darkAlgorithm', 'compactAlgorithm'], token: { colorPrimary: 'red' } },
    };
    const restored = deserializeTheme(stored);
    expect(restored.config?.algorithm).toEqual([theme.darkAlgorithm, theme.compactAlgorithm]);
    expect(stored.config.algorithm).toEqual(['darkAlgorithm', 'compactAlgorithm']);
    expect(JSON.parse(serializeTheme(restored))).toEqual(stored);
    expect(deserializeTheme({ id: 2, config: { algorithm: 'darkAlgorithm' } }).config?.algorithm).toBe(
      theme.darkAlgorithm,
    );
  });

  it('handles null config and drops unknown algorithm names instead of reading object prototypes', () => {
    expect(deserializeTheme({ id: 1, config: null }).config).toBeNull();
    expect(
      deserializeTheme({ id: 1, config: { algorithm: ['__proto__', 'unknown', 'darkAlgorithm'] } }).config?.algorithm,
    ).toEqual([theme.darkAlgorithm]);
  });

  it('uses the V2 current user shape, matches string IDs, and falls back when a saved theme was deleted', () => {
    const items = [
      { id: 1, default: true, config: {} },
      { id: '9007199254740993', config: {} },
    ];
    expect(getUserThemeId({ id: 5, systemSettings: { themeId: '9007199254740993' } })).toBe('9007199254740993');
    expect(getUserThemeId({ systemSettings: null })).toBeUndefined();
    expect(getEffectiveTheme(items, '1')).toBe(items[0]);
    expect(getEffectiveTheme(items, '9007199254740993')).toBe(items[1]);
    expect(getEffectiveTheme(items, 99)).toBe(items[0]);
    expect(getEffectiveTheme([])).toBeUndefined();
  });

  it('supplies the required motion token without overwriting an explicit zero or changing the input', () => {
    const fallback = { token: { motionUnit: 0.1 } };
    const config = { token: { colorPrimary: 'red' } };
    expect(normalizeTheme(config, fallback).token?.motionUnit).toBe(0.1);
    expect(config).toEqual({ token: { colorPrimary: 'red' } });
    expect(normalizeTheme({ token: { motionUnit: 0 } }, fallback).token?.motionUnit).toBe(0);
    expect(normalizeTheme(null, fallback)).toBe(fallback);
  });

  it('uses the custom collection and user action while preserving large persisted IDs', async () => {
    const request = vi.fn().mockResolvedValue({ data: { data: [{ id: 7, config: { algorithm: 'darkAlgorithm' } }] } });
    const items = await listThemes({ request });
    expect(request).toHaveBeenCalledWith({ url: 'antdStyleThemeConfig:list', params: { sort: 'id', paginate: false } });
    expect(items[0].config?.algorithm).toBe(theme.darkAlgorithm);
    await updateUserTheme({ request }, '9007199254740993');
    expect(request).toHaveBeenLastCalledWith({
      url: 'users:updateAntdStyleTheme',
      method: 'post',
      data: { themeId: '9007199254740993' },
    });
  });
});
