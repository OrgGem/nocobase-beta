import { cacheVersionManager } from '../utils/versionManager';

export function registerCacheHooks(app: any) {
  const db = app.db;

  // 1. Collections & Fields changes (Metadata)
  db.on('collections.afterSave', async () => {
    await cacheVersionManager.incrementCollectionVersion(app);
  });
  db.on('collections.afterDestroy', async () => {
    await cacheVersionManager.incrementCollectionVersion(app);
  });
  db.on('fields.afterSave', async () => {
    await cacheVersionManager.incrementCollectionVersion(app);
  });
  db.on('fields.afterDestroy', async () => {
    await cacheVersionManager.incrementCollectionVersion(app);
  });

  // 2. UI Schemas changes (Dynamic Layouts)
  db.on('uiSchemas.afterSave', async () => {
    await cacheVersionManager.incrementSchemaVersion(app);
  });
  db.on('uiSchemas.afterDestroy', async () => {
    await cacheVersionManager.incrementSchemaVersion(app);
  });

  // 3. ACL, Roles & Scopes changes
  const invalidateRole = async (model: any) => {
    const roleName = model.get?.('roleName') || model.get?.('name');
    if (roleName) {
      await cacheVersionManager.incrementAclVersion(app, roleName);
    } else {
      await cacheVersionManager.incrementAllAclVersions(app);
    }
  };

  db.on('roles.afterSave', invalidateRole);
  db.on('roles.afterDestroy', invalidateRole);

  db.on('rolesResources.afterSave', invalidateRole);
  db.on('rolesResources.afterDestroy', invalidateRole);

  db.on('rolesResourcesActions.afterSave', invalidateRole);
  db.on('rolesResourcesActions.afterDestroy', invalidateRole);

  db.on('rolesUsers.afterSave', invalidateRole);
  db.on('rolesUsers.afterDestroy', invalidateRole);

  db.on('scopes.afterSave', async () => {
    await cacheVersionManager.incrementAllAclVersions(app);
  });
  db.on('scopes.afterDestroy', async () => {
    await cacheVersionManager.incrementAllAclVersions(app);
  });

  app.logger.info('[ClusterManager] Cache invalidation hooks registered successfully');
}
