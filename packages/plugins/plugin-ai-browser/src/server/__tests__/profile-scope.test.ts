/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Application } from '@nocobase/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IBrowserDriver } from '../drivers';
import { BrowserSessionService } from '../services/BrowserSessionService';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function setup() {
  const profileRepo = { findOne: vi.fn() };
  const sessionRepo = { create: vi.fn().mockResolvedValue({ get: () => 'session-1' }) };
  const configRepo = { findOne: vi.fn().mockResolvedValue(null) };
  const app = {
    db: {
      getRepository: (name: string) =>
        ({ aiBrowserProfiles: profileRepo, aiBrowserSessions: sessionRepo, aiBrowserConfig: configRepo })[name],
    },
    i18n: { t: (key: string) => key },
    logger: { info: vi.fn() },
  } as unknown as Application;
  const driver = { name: 'test', createSession: vi.fn().mockResolvedValue({ externalSessionId: 'external-1' }) };
  const service = new BrowserSessionService(app, driver as unknown as IBrowserDriver);
  return { service, profileRepo, sessionRepo, driver };
}

describe('AI Browser profile ownership at session creation', () => {
  it('rejects profiles unavailable under the owner/enabled filter before contacting the driver', async () => {
    const { service, profileRepo, sessionRepo, driver } = setup();
    profileRepo.findOne.mockResolvedValue(null);
    await expect(service.createSession({ ownerId: 7, profileId: 'another-profile' })).rejects.toMatchObject({
      status: 403,
    });
    expect(profileRepo.findOne).toHaveBeenCalledWith({
      filterByTk: 'another-profile',
      filter: { ownerId: 7, enabled: true },
    });
    expect(driver.createSession).not.toHaveBeenCalled();
    expect(sessionRepo.create).not.toHaveBeenCalled();
  });

  it.each([true, false])('loads an enabled owner profile with explicit selection = %s', async (explicit) => {
    const { service, profileRepo, sessionRepo, driver } = setup();
    const values: Record<string, unknown> = {
      id: 'my-profile',
      launchOptions: { headless: true },
      defaultPolicy: { allowedDomains: ['example.com'] },
    };
    profileRepo.findOne.mockResolvedValue({ get: (key: string) => values[key] });
    await service.createSession({ ownerId: 7, ...(explicit ? { profileId: 'my-profile' } : {}) });
    expect(profileRepo.findOne).toHaveBeenLastCalledWith({
      filterByTk: 'my-profile',
      filter: { ownerId: 7, enabled: true },
    });
    if (!explicit) {
      expect(profileRepo.findOne).toHaveBeenNthCalledWith(1, {
        filter: { ownerId: 7, enabled: true },
        sort: ['-updatedAt'],
      });
    }
    expect(driver.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'my-profile',
        launchOptions: { headless: true },
        policy: expect.objectContaining({ allowedDomains: ['example.com'] }),
      }),
    );
    expect(sessionRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        values: expect.objectContaining({ ownerId: 7, profileId: 'my-profile' }),
      }),
    );
  });
});
