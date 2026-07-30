import { createAdminActions } from '../actions';

describe('skill registry admin contracts', () => {
  it('accepts publish values from the NocoBase values envelope', async () => {
    const publish = {
      publish: vi.fn().mockResolvedValue({ get: (key: string) => ({ id: 'v1', version: '1.0.0' })[key] }),
    };
    const actions = createAdminActions({
      sync: {} as never,
      publish: publish as never,
      database: {} as never,
      installationBridge: {} as never,
    });
    const ctx = {
      action: { params: { values: { sourceItemId: '12', version: '1.0.0', channel: 'stable' } } },
      auth: { user: { id: '1' } },
      body: null,
    };

    await actions.publish(ctx as never, async () => undefined);

    expect(publish.publish).toHaveBeenCalledWith({
      sourceItemId: '12',
      version: '1.0.0',
      channel: 'stable',
      changelog: undefined,
      publishedById: '1',
    });
  });

  it('accepts publish values from the HTTP request body', async () => {
    const publish = { publish: vi.fn().mockResolvedValue({ get: () => '1.0.0' }) };
    const actions = createAdminActions({
      sync: {} as never,
      publish: publish as never,
      database: {} as never,
      installationBridge: {} as never,
    });
    const ctx = {
      action: { params: {} },
      request: { body: { sourceItemId: '12', version: '1.0.0', channel: 'stable' } },
      auth: { user: { id: '1' } },
      body: null,
    };

    await actions.publish(ctx as never, async () => undefined);

    expect(publish.publish).toHaveBeenCalled();
  });

  it('publishes selected candidates independently and reports partial results', async () => {
    const publish = {
      publish: vi
        .fn()
        .mockResolvedValueOnce({ get: (key: string) => (key === 'version' ? '1.0.0' : 'v1') })
        .mockRejectedValueOnce(new Error('provider failed')),
    };
    const actions = createAdminActions({
      sync: {} as never,
      publish: publish as never,
      database: {} as never,
      installationBridge: {} as never,
    });
    const ctx = {
      action: { params: { values: { sourceItemIds: ['1', '2'], version: '1.0.0', channel: 'stable' } } },
      auth: { user: { id: '1' } },
      body: null,
    };

    await actions.publishBatch(ctx as never, async () => undefined);

    expect(ctx.body).toMatchObject({ published: 1, failed: 1 });
  });

  it('accepts numeric source IDs returned by auto-increment collections', async () => {
    const sync = {
      discover: vi.fn().mockResolvedValue({ sourceId: '1', candidates: [] }),
    };
    const actions = createAdminActions({
      sync: sync as never,
      publish: {} as never,
      database: {} as never,
      installationBridge: {} as never,
    });
    const ctx = {
      action: { params: { values: { sourceId: 1 } } },
      body: null,
      throw: vi.fn(),
    };

    await actions.discover(ctx as never, async () => undefined);

    expect(sync.discover).toHaveBeenCalledWith(1);
  });

  it('verifies a published artifact through the installation bridge', async () => {
    const bridge = {
      verify: vi.fn().mockResolvedValue({
        versionId: 'version-1',
        artifactDigest: `sha256:${'a'.repeat(64)}`,
        signatureVerified: true,
      }),
    };
    const actions = createAdminActions({
      sync: {} as never,
      publish: {} as never,
      database: {} as never,
      installationBridge: bridge as never,
    });
    const ctx = {
      action: { params: { values: { versionId: 'version-1' } } },
      body: null,
      throw: vi.fn(),
    };

    await actions.verify(ctx as never, async () => undefined);

    expect(bridge.verify).toHaveBeenCalledWith('version-1');
    expect(ctx.body).toEqual({
      versionId: 'version-1',
      artifactDigest: `sha256:${'a'.repeat(64)}`,
      signatureVerified: true,
    });
  });

  it('restores the target selected by Agent Orchestrator without exposing installation storage to the registry', async () => {
    const bridge = {
      rollback: vi.fn().mockResolvedValue({
        installationId: 'installation-1',
        skillDefinitionId: 'skill-1',
        toolName: 'registry_acme_report',
        status: 'installed',
      }),
    };
    const actions = createAdminActions({
      sync: {} as never,
      publish: {} as never,
      database: {} as never,
      installationBridge: bridge as never,
    });
    const ctx = {
      action: { params: { values: { installationId: 'installation-2' } } },
      auth: { user: { id: 'admin-1' } },
      body: null,
      throw: vi.fn(),
    };

    await actions.rollback(ctx as never, async () => undefined);

    expect(bridge.rollback).toHaveBeenCalledWith('installation-2', 'admin-1');
    expect(ctx.body).toEqual({
      installationId: 'installation-1',
      skillDefinitionId: 'skill-1',
      toolName: 'registry_acme_report',
      status: 'installed',
    });
  });
});
