/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { afterEach, expect, it, vi } from 'vitest';
import { PlaywrightDriver } from '../drivers/PlaywrightDriver';
import { publicLiveUrl } from '../public-live-url';

afterEach(() => {
  vi.unstubAllEnvs();
});

it('withholds stored URLs containing backend credentials and preserves session viewer URLs', () => {
  vi.stubEnv('AI_BROWSER_CDP_URL', 'wss://service:password@browser.example/?token=BACKEND_TOKEN');
  expect(publicLiveUrl('https://browser.example/?token=BACKEND_TOKEN&id=session')).toBeNull();
  expect(publicLiveUrl('https://viewer.example/?ws=browser.example%2F%3Ftoken%3DBACKEND_TOKEN')).toBeNull();
  expect(publicLiveUrl('https://service:password@browser.example/')).toBeNull();
  expect(publicLiveUrl('/ai-browser-live/?id=session')).toBe('/ai-browser-live/?id=session');
});

it('does not derive a public viewer URL from the privileged CDP endpoint', () => {
  vi.stubEnv('AI_BROWSER_CDP_URL', 'wss://service-user:service-password@browser.example/?token=BACKEND_TOKEN');
  vi.stubEnv('AI_BROWSER_LIVE_URL', '');
  const driver = new PlaywrightDriver() as unknown as { liveUrl: string };
  expect(driver.liveUrl).toBe('/ai-browser-live/');
});

it('supports an explicitly configured public viewer URL', () => {
  vi.stubEnv('AI_BROWSER_LIVE_URL', 'https://viewer.example/debugger');
  const driver = new PlaywrightDriver() as unknown as { liveUrl: string };
  expect(driver.liveUrl).toBe('https://viewer.example/');
});
