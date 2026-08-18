import { Migration } from '@nocobase/server';
import { DataTypes } from 'sequelize';

export default class MarkdownSkillsSchemaMigration extends Migration {
  // Runs after sync: plugin collections are registered and their tables exist
  // (sync creates them on fresh installs), so the guards below make this a
  // no-op for new deployments and a schema patch for upgrades.
  on = 'afterSync' as const;

  async up() {
    const packages = this.db.getCollection('skillRegistryPackages');
    if (packages && (await packages.existsInDb())) {
      const tableName = packages.getTableNameWithSchema();
      const columns = await this.queryInterface.describeTable(tableName);
      if (!columns.ownerId) {
        await this.queryInterface.addColumn(tableName, 'ownerId', {
          type: DataTypes.BIGINT,
          allowNull: true,
        });
      }
    }

    const versions = this.db.getCollection('skillRegistryVersions');
    if (versions && (await versions.existsInDb())) {
      const tableName = versions.getTableNameWithSchema();
      const columns = await this.queryInterface.describeTable(tableName);
      const sourceItemId = columns.sourceItemId;
      if (sourceItemId && sourceItemId.allowNull === false) {
        await this.queryInterface.changeColumn(tableName, 'sourceItemId', {
          type: sourceItemId.type,
          allowNull: true,
        });
      }
    }
  }

  async down() {
    const versions = this.db.getCollection('skillRegistryVersions');
    if (versions && (await versions.existsInDb())) {
      const tableName = versions.getTableNameWithSchema();
      const columns = await this.queryInterface.describeTable(tableName);
      const sourceItemId = columns.sourceItemId;
      if (sourceItemId && sourceItemId.allowNull) {
        await this.queryInterface.changeColumn(tableName, 'sourceItemId', {
          type: sourceItemId.type,
          allowNull: false,
        });
      }
    }

    const packages = this.db.getCollection('skillRegistryPackages');
    if (packages && (await packages.existsInDb())) {
      const tableName = packages.getTableNameWithSchema();
      const columns = await this.queryInterface.describeTable(tableName);
      if (columns.ownerId) {
        await this.queryInterface.removeColumn(tableName, 'ownerId');
      }
    }
  }
}
