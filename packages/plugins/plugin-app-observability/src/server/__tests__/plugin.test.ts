import { describe, expect, it, vi } from 'vitest';
import { getAppObservability } from '../contracts';
import PluginAppObservabilityServer from '../plugin';
import { DEFAULT_SETTINGS, type ObservabilitySettings } from '../repositories/settings-repository';

function createApp(settingsRef: { current: ObservabilitySettings }) {
  const events = new Map<string, () => Promise<void>>();
  const settings = {
    findOne: async () => ({ toJSON: () => ({ key: 'default', ...settingsRef.current }) }),
    create: async () => undefined,
    update: async () => undefined,
  };
  const app = {
    name: 'main',
    db: {
      sequelize: {},
      getRepository: (name: string) => {
        if (name === 'appObservabilitySettings') return settings;
        if (name === 'appObservabilityBuckets') return { create: async () => undefined, destroy: async () => 0 };
        return { destroy: async () => 0 };
      },
    },
    resourceManager: { define: vi.fn() },
    acl: { registerSnippet: vi.fn(), allow: vi.fn() },
    dataSourceManager: { use: vi.fn() },
    logger: { warn: vi.fn() },
    on: vi.fn((event: string, handler: () => Promise<void>) => events.set(event, handler)),
    off: vi.fn(),
  };
  return { app, events };
}

describe('PluginAppObservabilityServer', () => {
  it('exposes an independent NocoBase server plugin class', () => {
    expect(PluginAppObservabilityServer).toBeTypeOf('function');
    expect(PluginAppObservabilityServer.prototype.load).toBeTypeOf('function');
    expect(PluginAppObservabilityServer.prototype.beforeLoad).toBeTypeOf('function');
  });

  it('keeps contract observations as no-ops while persisted settings are disabled', async () => {
    const settingsRef = { current: { ...DEFAULT_SETTINGS, enabled: false } };
    const { app, events } = createApp(settingsRef);
    const plugin = new PluginAppObservabilityServer(app as never);
    await plugin.load();
    await events.get('afterStart')?.();

    const contract = getAppObservability(app);
    contract?.start({ service: 'llm.chat', operation: 'chat' }).finish({ status: 'succeeded' });
    expect(Object.values(contract?.getNodeSnapshot().services ?? {})).toHaveLength(0);

    await plugin.afterEnable();
    contract?.start({ service: 'llm.chat', operation: 'chat' }).finish({ status: 'succeeded' });
    expect(Object.values(contract?.getNodeSnapshot().services ?? {})).toHaveLength(0);
    await plugin.beforeUnload();
  });

  it('applies a shared settings change when a node refreshes its settings', async () => {
    const settingsRef = { current: { ...DEFAULT_SETTINGS, enabled: false } };
    const first = createApp(settingsRef);
    const second = createApp(settingsRef);
    const firstPlugin = new PluginAppObservabilityServer(first.app as never);
    const secondPlugin = new PluginAppObservabilityServer(second.app as never);
    await firstPlugin.load();
    await secondPlugin.load();
    await first.events.get('afterStart')?.();
    await second.events.get('afterStart')?.();

    settingsRef.current = { ...settingsRef.current, activeUserWindowSeconds: 900 };
    const sync = (plugin: PluginAppObservabilityServer) =>
      (plugin as unknown as { syncSettings: () => Promise<void> }).syncSettings();
    await Promise.all([sync(firstPlugin), sync(secondPlugin)]);

    const localSettings = (plugin: PluginAppObservabilityServer) =>
      (plugin as unknown as { settings: ObservabilitySettings }).settings;
    expect(localSettings(firstPlugin).activeUserWindowSeconds).toBe(900);
    expect(localSettings(secondPlugin).activeUserWindowSeconds).toBe(900);
    await firstPlugin.beforeUnload();
    await secondPlugin.beforeUnload();
  });
});
