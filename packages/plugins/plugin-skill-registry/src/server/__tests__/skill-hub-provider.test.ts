import { SkillHubSourceProvider } from '../providers/skill-hub-provider';

describe('SkillHubSourceProvider', () => {
  it('maps a provider-owned export denial to a stable registry error', async () => {
    const denied = Object.assign(new Error('not granted'), { code: 'REGISTRY_EXPORT_NOT_GRANTED' });
    const provider = new SkillHubSourceProvider({
      get: () => ({
        registrySkillSnapshotService: {
          listSkillSnapshots: vi.fn().mockResolvedValue([]),
          getSkillSnapshot: vi.fn().mockRejectedValue(denied),
        },
      }),
    });

    await expect(
      provider.getCandidate(
        {
          id: 'source-1',
          providerType: 'skill-hub',
          namespace: 'acme',
          providerConfig: { registryExportEnabled: true },
        },
        'skillDefinitions:42',
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_EXPORT_NOT_GRANTED', status: 403 });
  });
});
