import type { Database } from '@nocobase/database';

import { RegistrySkillSnapshotService } from '../RegistrySkillSnapshotService';

describe('RegistrySkillSnapshotService', () => {
  it('does not expose registry-installed local projections as Skill Hub sources', async () => {
    const find = vi.fn().mockResolvedValue([{ get: () => 42 }]);
    const database = {
      getRepository: vi.fn().mockReturnValue({ find }),
    } as unknown as Database;
    const service = new RegistrySkillSnapshotService(database);

    await expect(service.listSkillSnapshots()).resolves.toEqual([{ id: '42' }]);
    expect(find).toHaveBeenCalledWith({
      fields: ['id'],
      filter: {
        registryPackageId: null,
        registryVersionId: null,
        registryInstallationId: null,
        registryInstallStatus: null,
        registryExportEnabled: true,
      },
      sort: ['id'],
      limit: 1001,
    });
  });

  it('does not return a snapshot without a provider-owned export grant', async () => {
    const findOne = vi.fn().mockResolvedValue(null);
    const database = {
      getRepository: vi.fn().mockReturnValue({ findOne }),
    } as unknown as Database;
    const service = new RegistrySkillSnapshotService(database);

    await expect(service.getSkillSnapshot('42')).rejects.toMatchObject({
      code: 'REGISTRY_EXPORT_NOT_GRANTED',
    });
    expect(findOne).toHaveBeenCalledWith({
      filter: {
        id: '42',
        registryPackageId: null,
        registryVersionId: null,
        registryInstallationId: null,
        registryInstallStatus: null,
        registryExportEnabled: true,
      },
    });
  });

  it('bounds provider discovery before returning an unbounded definition list', async () => {
    const find = vi
      .fn()
      .mockResolvedValue(Array.from({ length: 1001 }, (_, id) => ({ get: () => id + 1 })));
    const database = {
      getRepository: vi.fn().mockReturnValue({ find }),
    } as unknown as Database;
    const service = new RegistrySkillSnapshotService(database);

    await expect(service.listSkillSnapshots()).rejects.toThrow(
      'Skill Hub registry export exceeds the configured source-item limit.',
    );
  });
});
