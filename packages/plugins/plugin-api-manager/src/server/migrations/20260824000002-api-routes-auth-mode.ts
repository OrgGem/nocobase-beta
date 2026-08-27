import { Migration } from '@nocobase/server';

/**
 * Adds the authMode column to apiRoutes:
 *  - 'both'    (default) — plugin API key OR app Bearer token
 *  - 'api-key' — plugin API key only (scope check; Bearer rejected)
 *  - 'role'    — app Bearer token only (role ACL; X-API-Key rejected)
 *
 * Also drops the now-unused ACL fields (roleName, userId) from
 * apiManagerApiKeys: route access is no longer bound to a key's role, it is
 * chosen per route via authMode + the role ACL on the route's snippet.
 */
export default class extends Migration {
  on = 'afterLoad';

  async up() {
    const db = this.app.db;
    const routes = db.getCollection('apiRoutes');
    if (routes) {
      const tableName = routes.model.tableName;
      try {
        const hasAuthMode = await db.sequelize
          .getQueryInterface()
          .describeTable(tableName)
          .then((table: Record<string, unknown>) => Boolean(table.authMode))
          .catch(() => false);
        if (!hasAuthMode) {
          await db.sequelize.getQueryInterface().addColumn(tableName, 'authMode', {
            type: db.sequelize.STRING,
            allowNull: false,
            defaultValue: 'both',
          });
        }
      } catch (error) {
        db.logger?.warn?.(`[api-manager] migration add authMode skipped: ${(error as Error).message ?? error}`);
      }
    }

    const keys = db.getCollection('apiManagerApiKeys');
    if (keys) {
      const tableName = keys.model.tableName;
      try {
        const qi = db.sequelize.getQueryInterface();
        const described = await qi.describeTable(tableName).catch(() => ({}) as Record<string, unknown>);
        if (described.roleName) {
          await qi.removeColumn(tableName, 'roleName');
        }
        if (described.userId) {
          await qi.removeColumn(tableName, 'userId');
        }
      } catch (error) {
        db.logger?.warn?.(
          `[api-manager] migration drop key roleName/userId skipped: ${(error as Error).message ?? error}`,
        );
      }
    }
  }
}
