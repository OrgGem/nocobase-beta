import { createAdminActions } from '../actions';

describe('skill registry admin contracts', () => {
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
