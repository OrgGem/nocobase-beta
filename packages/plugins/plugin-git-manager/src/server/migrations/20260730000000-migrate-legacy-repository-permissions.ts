import { Migration } from '@nocobase/server';
import type { Model } from '@nocobase/database';

import {
  GIT_READ_ACTIONS,
  GIT_WRITE_ACTIONS,
  REPOSITORY_READ_ACTIONS,
  getRepositoryPermissionScope,
  syncScopedActions,
} from '../actions/role-permissions';

function getRecordValue(record: unknown, key: string) {
  if (!record || typeof record !== 'object') return undefined;
  const model = record as { get?: (attribute: string) => unknown } & Record<string, unknown>;
  return typeof model.get === 'function' ? model.get(key) : model[key];
}

export default class MigrateLegacyRepositoryPermissions extends Migration {
  on = 'afterLoad';

  async up() {
    const resourceRepo = this.db.getRepository('rolesResources');
    const actionsRepo = this.db.getRepository('rolesResourcesActions');
    const repositoryResources = await resourceRepo.find({ filter: { name: 'gitRepositories' } });

    for (const repositoryResource of repositoryResources) {
      const rolesResourceId = getRecordValue(repositoryResource, 'id');
      const roleName = getRecordValue(repositoryResource, 'roleName');
      if (!rolesResourceId || !roleName) continue;

      const actions = await actionsRepo.find({
        filter: { rolesResourceId },
        appends: ['scope'],
      });
      const legacyRead = actions.filter((action) => getRecordValue(action, 'name') === 'read') as Model[];
      const legacyWrite = actions.filter((action) => getRecordValue(action, 'name') === 'write') as Model[];
      if (legacyRead.length === 0 && legacyWrite.length === 0) continue;

      const readPermission = getRepositoryPermissionScope(legacyRead, ['read']);
      const writePermission = getRepositoryPermissionScope(legacyWrite, ['write']);
      if (!readPermission.supported || !writePermission.supported) {
        this.app.log?.warn(
          `[git-manager] skipped repository permission migration for role ${String(
            roleName,
          )} because its legacy scope cannot be represented safely`,
        );
        continue;
      }
      const effectiveReadIds = [...new Set([...readPermission.ids, ...writePermission.ids])];
      const effectiveReadUnrestricted = readPermission.unrestricted || writePermission.unrestricted;
      if (effectiveReadIds.length === 0 && !effectiveReadUnrestricted && !writePermission.unrestricted) continue;

      await syncScopedActions(this.db, repositoryResource, REPOSITORY_READ_ACTIONS, effectiveReadIds, {
        unrestricted: effectiveReadUnrestricted,
      });

      let gitManagerResource = await resourceRepo.findOne({ filter: { roleName, name: 'gitManager' } });
      if (!gitManagerResource) {
        gitManagerResource = await resourceRepo.create({
          values: { roleName, name: 'gitManager', usingActionsConfig: true },
        });
      } else if (!getRecordValue(gitManagerResource, 'usingActionsConfig')) {
        await gitManagerResource.update({ usingActionsConfig: true });
      }

      await syncScopedActions(this.db, gitManagerResource, GIT_READ_ACTIONS, effectiveReadIds, {
        unrestricted: effectiveReadUnrestricted,
      });
      await syncScopedActions(this.db, gitManagerResource, GIT_WRITE_ACTIONS, writePermission.ids, {
        unrestricted: writePermission.unrestricted,
      });

      for (const action of [...legacyRead, ...legacyWrite]) {
        await action.destroy();
      }

      await repositoryResource.writeToACL({ acl: this.app.acl });
      await gitManagerResource.writeToACL({ acl: this.app.acl });
    }
  }
}
