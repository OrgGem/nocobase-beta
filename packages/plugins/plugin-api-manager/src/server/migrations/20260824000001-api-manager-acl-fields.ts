import { Migration } from '@nocobase/server';

/**
 * Adds the ACL integration fields to apiManagerApiKeys:
 *  - roleName: the NocoBase role bound to the key. When present, the gateway
 *    sets ctx.state.currentRole/currentRoles from it and enforces
 *    `apimRoutes:call:<routeName>` ACL checks (role must be allowed to call
 *    the route).
 *  - userId: the user who created the key (nullable; legacy keys are null).
 */
export default class extends Migration {
  on = 'afterLoad';

  async up() {
    const collection = this.app.db.getCollection('apiManagerApiKeys');
    if (!collection) {
      return;
    }
    const tableName = collection.model.tableName;
    const fieldRoleName = collection.getField('roleName');
    const fieldUserId = collection.getField('userId');
    try {
      const hasRoleName = fieldRoleName
        ? await this.app.db.sequelize
            .getQueryInterface()
            .describeTable(tableName)
            .then((table: Record<string, unknown>) => Boolean(table.roleName))
            .catch(() => false)
        : false;
      const hasUserId = fieldUserId
        ? await this.app.db.sequelize
            .getQueryInterface()
            .describeTable(tableName)
            .then((table: Record<string, unknown>) => Boolean(table.userId))
            .catch(() => false)
        : false;

      if (fieldRoleName && !hasRoleName) {
        await this.app.db.sequelize.getQueryInterface().addColumn(tableName, 'roleName', {
          type: this.app.db.sequelize.STRING,
          allowNull: true,
        });
      }
      if (fieldUserId && !hasUserId) {
        await this.app.db.sequelize.getQueryInterface().addColumn(tableName, 'userId', {
          type: this.app.db.sequelize.BIGINT,
          allowNull: true,
        });
      }
      await this.app.db.sequelize.getQueryInterface().addIndex(tableName, ['userId']).catch(() => undefined);
    } catch (error) {
      // The table may not exist yet (fresh install) — the collection sync will
      // create it with the new fields anyway.
      this.app.logger?.warn?.(
        `[api-manager] migration add acl fields skipped: ${(error as Error).message ?? error}`,
      );
    }
  }
}
