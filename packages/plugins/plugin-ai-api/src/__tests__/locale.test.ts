/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const LOCALE_DIR = join(__dirname, '..', 'locale');
const FILES = ['en-US.json', 'zh-CN.json', 'vi-VN.json'] as const;

function loadLocale(file: string): Record<string, string> {
  return JSON.parse(readFileSync(join(LOCALE_DIR, file), 'utf8')) as Record<string, string>;
}

describe('plugin-ai-api locale files', () => {
  it('all locale files are valid JSON with no empty values', () => {
    for (const file of FILES) {
      const locale = loadLocale(file);
      expect(Object.keys(locale).length, `${file} should not be empty`).toBeGreaterThan(0);
      for (const [key, value] of Object.entries(locale)) {
        expect(typeof value, `${file}[${JSON.stringify(key)}] must be a string`).toBe('string');
        expect(value.trim().length, `${file}[${JSON.stringify(key)}] must not be blank`).toBeGreaterThan(0);
      }
    }
  });

  it('all locales expose the identical set of keys', () => {
    const [base, ...rest] = FILES;
    const baseKeys = Object.keys(loadLocale(base)).sort();
    for (const file of rest) {
      const keys = Object.keys(loadLocale(file)).sort();
      const missing = baseKeys.filter((key) => !keys.includes(key));
      const extra = keys.filter((key) => !baseKeys.includes(key));
      expect({ file, missing, extra }).toEqual({ file, missing: [], extra: [] });
    }
  });
});
