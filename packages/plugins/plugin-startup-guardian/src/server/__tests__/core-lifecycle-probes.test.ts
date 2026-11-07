/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { mockServer, type MockServer } from '@nocobase/test';
import { Plugin, type PluginConfiguration } from '@nocobase/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Core startup failure behavior probes', () => {
  let app: MockServer;
  afterEach(async () => {
    await app?.destroy();
    vi.restoreAllMocks();
  });
  const create = (plugins: PluginConfiguration[]) =>
    mockServer({ database: { dialect: 'sqlite', storage: ':memory:' }, plugins });

  it.each(['beforeLoad', 'loadCollections', 'loadAI', 'load'] as const)(
    '%s rejection aborts load and leaves registered side effects',
    async (phase) => {
      class Broken extends Plugin {}
      Broken.prototype[phase] = async function () {
        this.app.on('probe-side-effect', () => {});
        throw new Error(`broken-${phase}`);
      };
      const healthyLoad = vi.fn();
      class Healthy extends Plugin {
        async load() {
          healthyLoad();
        }
      }
      app = create([
        [Broken, { name: 'broken' }],
        [Healthy, { name: 'healthy' }],
      ]);
      const beforeLoadPlugin = vi.fn();
      app.on('beforeLoadPlugin', beforeLoadPlugin);
      await expect(app.load()).rejects.toThrow(`broken-${phase}`);
      expect(healthyLoad).not.toHaveBeenCalled();
      expect(app.listenerCount('probe-side-effect')).toBe(1);
      expect(app.pm.get('broken').enabled).toBe(true);
      if (phase === 'beforeLoad') expect(beforeLoadPlugin).not.toHaveBeenCalled();
    },
  );

  it('afterAdd rejection is logged but the registered plugin can still reach load', async () => {
    const loaded = vi.fn();
    class Broken extends Plugin {
      async afterAdd() {
        throw new Error('broken-afterAdd');
      }
      async load() {
        loaded();
      }
    }
    app = create([[Broken, { name: 'broken' }]]);
    await app.load();
    expect(loaded).toHaveBeenCalledTimes(1);
    expect(app.pm.get('broken').state.loaded).toBe(true);
  });

  it('a guardian registered last can wrap beforeLoad through the application beforeLoad event', async () => {
    const captured: string[] = [];
    class Broken extends Plugin {
      async beforeLoad() {
        throw new Error('broken-beforeLoad');
      }
    }
    class Guardian extends Plugin {
      afterAdd() {
        this.app.on('beforeLoad', () => {
          for (const plugin of this.app.pm.getPlugins().values()) {
            const original = plugin.beforeLoad;
            plugin.beforeLoad = async () => {
              try {
                await original.call(plugin);
              } catch (error) {
                captured.push(plugin.name);
                throw error;
              }
            };
          }
        });
      }
    }
    app = create([
      [Broken, { name: 'broken' }],
      [Guardian, { name: 'guardian' }],
    ]);
    await expect(app.load()).rejects.toThrow('broken-beforeLoad');
    expect(captured).toEqual(['broken']);
  });

  it('an afterStart listener rejection aborts startup', async () => {
    class Broken extends Plugin {
      async load() {
        this.app.on('afterStart', async () => {
          throw new Error('broken-afterStart');
        });
      }
    }
    app = create([[Broken, { name: 'broken' }]]);
    await app.load();
    await expect(app.start()).rejects.toThrow('broken-afterStart');
  });

  it('pm disable CLI preloads and cannot reach disable when a plugin beforeLoad fails', async () => {
    class Broken extends Plugin {
      async beforeLoad() {
        throw new Error('broken-preload');
      }
    }
    app = create([[Broken, { name: 'broken' }]]);
    const disable = vi.spyOn(app.pm, 'disable');
    await expect(app.runCommandThrowError('pm', 'disable', 'broken')).rejects.toThrow('broken-preload');
    expect(disable).not.toHaveBeenCalled();
  });
});
