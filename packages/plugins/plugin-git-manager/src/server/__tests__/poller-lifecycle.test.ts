/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Application } from '@nocobase/server';
import { getPollerStatus, pollAllRepos, startPoller, stopPoller } from '../poller';

function mockApp(find = vi.fn().mockResolvedValue([])) {
  return { db: { getRepository: () => ({ find }) }, log: {} } as unknown as Application;
}

describe('Poller application isolation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts one timer per application and stops only the requested application', async () => {
    vi.useFakeTimers();
    const firstFind = vi.fn().mockResolvedValue([]);
    const secondFind = vi.fn().mockResolvedValue([]);
    const first = mockApp(firstFind);
    const second = mockApp(secondFind);
    try {
      startPoller(first);
      startPoller(first);
      startPoller(second);
      expect(vi.getTimerCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(firstFind).toHaveBeenCalledTimes(1);
      expect(secondFind).toHaveBeenCalledTimes(1);
      stopPoller(second);
      expect(getPollerStatus(first).running).toBe(true);
      expect(getPollerStatus(second).running).toBe(false);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(firstFind).toHaveBeenCalledTimes(2);
      expect(secondFind).toHaveBeenCalledTimes(1);
    } finally {
      stopPoller(first);
      stopPoller(second);
    }
  });

  it('prevents concurrent cycles in one application while allowing another application', async () => {
    let finish = () => {};
    const pending = new Promise<never[]>((resolve) => {
      finish = () => resolve([]);
    });
    const firstFind = vi.fn().mockReturnValue(pending);
    const secondFind = vi.fn().mockResolvedValue([]);
    const first = mockApp(firstFind);
    const second = mockApp(secondFind);
    const running = pollAllRepos(first);
    try {
      await pollAllRepos(first);
      await pollAllRepos(second);
      expect(firstFind).toHaveBeenCalledTimes(1);
      expect(secondFind).toHaveBeenCalledTimes(1);
      expect(getPollerStatus(first).polling).toBe(true);
      expect(getPollerStatus(second).polling).toBe(false);
    } finally {
      finish();
      await running;
    }
    expect(getPollerStatus(first).polling).toBe(false);
  });
});
