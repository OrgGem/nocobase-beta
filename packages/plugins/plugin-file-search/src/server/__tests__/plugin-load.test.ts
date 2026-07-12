import { PluginFileSearchServer } from '../plugin';

function createMockApp() {
  return {
    resourceManager: {
      registerActionHandlers: vi.fn(),
    },
    acl: {
      registerSnippet: vi.fn(),
      allow: vi.fn(),
    },
    aiManager: {
      toolsManager: {
        registerTools: vi.fn(),
      },
    },
    on: vi.fn(),
    log: {
      warn: vi.fn(),
    },
  };
}

describe('plugin-file-search server plugin load', () => {
  it('loads server registrations without throwing', async () => {
    const app = createMockApp();
    const plugin = new PluginFileSearchServer(app as never, {
      name: 'plugin-file-search',
      packageName: 'plugin-file-search',
      enabled: true,
    });

    await expect(plugin.load()).resolves.toBeUndefined();
    expect(app.resourceManager.registerActionHandlers).toHaveBeenCalled();
    expect(app.acl.registerSnippet).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'pm.plugin-file-search.manage' }),
    );
  });
});
