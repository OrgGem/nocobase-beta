import { Plugin } from '@nocobase/server';
import { cursorPaginationAction, default as resource } from './resources/database-plus-manager';
import settings from './collections/database-plus-manager-settings';

const PAGINATION_ACL_SNIPPET = 'pm.plugin-database-plus-manager';

function isCursorMode(value: unknown): value is 'keyset' | 'cursor' {
  return value === 'keyset' || value === 'cursor';
}

async function listPaginationOverride(ctx, next) {
  const params = ctx.action?.params || {};
  if (params.paginate === false || params.paginate === 'false' || !isCursorMode(params.paginationMode)) {
    await next();
    return;
  }
  await cursorPaginationAction(ctx, async () => undefined);
}

export class PluginDatabasePlusManagerServer extends Plugin {
  async load() {
    this.app.db.addMigrations({
      name: 'database-plus-manager',
      migrations: [],
    });
    this.app.resourceManager.define(resource);
    this.app.acl.registerSnippet({
      name: PAGINATION_ACL_SNIPPET,
      actions: [
        'databasePlusManager:getSettings',
        'databasePlusManager:saveSettings',
        'databasePlusManager:cursor',
        'databasePlusManager:statistics',
        'databasePlusManager:listIndexes',
        'databasePlusManager:addIndex',
        'databasePlusManager:removeIndex',
        'databasePlusManager:runSql',
        'databasePlusManager:aggregate',
      ],
    });
    this.app.resourceManager.registerPreActionHandler('list', listPaginationOverride, {
      after: 'acl',
    });
    // v2.2.x compat: use this.db.collection() instead of collectionManager.defineCollection()
    this.db.collection(settings);
  }

  async install() {
    const repo = this.db.getRepository('databasePlusManagerSettings');
    if (!(await repo.findOne())) await repo.create({ values: { paginationMode: 'offset' } });
  }
}

export default PluginDatabasePlusManagerServer;


