// SPDX-License-Identifier: Apache-2.0

import { theme } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import {
  deserializeTheme,
  getEffectiveTheme,
  getUserThemeId,
  isSameThemeId,
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

  it('supplies required fallback tokens without overwriting custom header tokens or explicit zero', () => {
    const fallback = { token: { motionUnit: 0.1, colorSettings: '#F18B62', colorBgHeader: '#001529' } };
    const config = { token: { colorPrimary: 'red', colorBgHeader: '#FFFFFF', colorTextHeaderMenu: '#2E3A5B' } };
    const normalized = normalizeTheme(config, fallback);
    expect(normalized.token?.motionUnit).toBe(0.1);
    expect(normalized.token?.colorSettings).toBe('#F18B62');
    expect(normalized.token?.colorBgHeader).toBe('#FFFFFF');
    expect(normalized.token?.colorTextHeaderMenu).toBe('#2E3A5B');
    expect(config).toEqual({
      token: { colorPrimary: 'red', colorBgHeader: '#FFFFFF', colorTextHeaderMenu: '#2E3A5B' },
    });
    expect(normalizeTheme({ token: { motionUnit: 0, colorSettings: '#111111' } }, fallback).token).toMatchObject({
      motionUnit: 0,
      colorSettings: '#111111',
    });
    expect(normalizeTheme(null, fallback)).toBe(fallback);
  });

  it('prefers antdStyleThemeId over legacy themeId and matches numeric/string IDs', () => {
    expect(getUserThemeId({ systemSettings: { antdStyleThemeId: 7, themeId: 2 } })).toBe(7);
    expect(getUserThemeId({ systemSettings: { antdStyleThemeId: null, themeId: 2 } })).toBeUndefined();
    expect(getUserThemeId({ systemSettings: { themeId: 3 } })).toBe(3);

    expect(isSameThemeId(5, '5')).toBe(true);
    expect(isSameThemeId('5', 5)).toBe(true);
    expect(isSameThemeId(5, 6)).toBe(false);
    expect(isSameThemeId(null, '5')).toBe(false);
    expect(isSameThemeId(undefined, undefined)).toBe(false);
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
