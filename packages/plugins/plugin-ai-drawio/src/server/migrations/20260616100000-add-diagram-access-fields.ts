import { Migration } from '@nocobase/server';

/**
 * Adds the row-level access policy columns to aiDiagrams:
 *   - accessLevel:   'BASIC' | 'SHARED' | 'PUBLIC' (default 'BASIC')
 *   - allowedRoles:  JSON array of role names granted access (SHARED diagrams)
 *   - agentAccess:   'inherit' | 'explicit' | 'none' (default 'inherit')
 *   - allowedAgents: JSON array of AI Employee usernames granted explicit access
 *
 * Pre-existing rows are backfilled to PUBLIC: before this migration every
 * logged-in user could read any diagram (loadXml/getMeta were open to all), so
 * PUBLIC preserves that read-for-all behavior. New diagrams created afterwards
 * keep the BASIC column default (owner-private). Management (delete + policy
 * changes) on PUBLIC rows still resolves to admin-only via canManageDiagram.
 */
export default class AddDiagramAccessFields extends Migration {
  on = 'afterLoad';
  appVersion = '<=2.x';

  async up() {
    const db = (this as any).db;
    const queryInterface = db.sequelize.getQueryInterface();
    const DataTypes = db.sequelize.constructor['DataTypes'];
    const tablePrefix = db.options?.tablePrefix || '';
    const tableName = `${tablePrefix}aiDiagrams`;

    const tableInfo = await queryInterface.describeTable(tableName).catch(() => null);
    if (!tableInfo) {
      return;
    }

    if (!tableInfo.accessLevel) {
      await queryInterface.addColumn(tableName, 'accessLevel', {
        type: DataTypes.STRING,
        defaultValue: 'BASIC',
        allowNull: true,
      });
      // Backfill pre-existing rows to PUBLIC. Before this migration every
      // logged-in user could read any diagram (loadXml/getMeta were open), so
      // defaulting legacy rows to BASIC would silently hide them from everyone
      // but their owner. PUBLIC preserves read-for-all; management (delete and
      // policy changes) still resolves to admin-only via canManageDiagram.
      // New diagrams created after this point keep the BASIC column default.
      await db.sequelize.query(
        `UPDATE "${tableName}" SET "accessLevel" = 'PUBLIC' WHERE "accessLevel" IS NULL OR "accessLevel" = 'BASIC'`,
      );
    }

    if (!tableInfo.allowedRoles) {
      await queryInterface.addColumn(tableName, 'allowedRoles', {
        type: DataTypes.JSON,
        allowNull: true,
      });
    }

    if (!tableInfo.agentAccess) {
      await queryInterface.addColumn(tableName, 'agentAccess', {
        type: DataTypes.STRING,
        defaultValue: 'inherit',
        allowNull: true,
      });
    }

    if (!tableInfo.allowedAgents) {
      await queryInterface.addColumn(tableName, 'allowedAgents', {
        type: DataTypes.JSON,
        allowNull: true,
      });
    }
  }
}
