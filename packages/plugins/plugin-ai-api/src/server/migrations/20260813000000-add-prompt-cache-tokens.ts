import { Migration } from '@nocobase/server';

export default class AddPromptCacheTokensToUsageRecords extends Migration {
  on = 'beforeLoad' as const;

  async up() {
    const collection = this.db.getCollection('aiApiUsageRecords');
    if (!collection) return;

    const field = collection.getField('promptCacheTokens');
    if (!field) {
      collection.addField('promptCacheTokens', { type: 'integer', allowNull: true });
    }

    if (await collection.existsInDb()) {
      const tableName = collection.getTableNameWithSchema();
      const exists = await this.tableColumnExists(tableName, 'promptCacheTokens');
      if (!exists) {
        await this.queryInterface.addColumn(tableName, 'promptCacheTokens', {
          type: this.db.sequelize.getDialect() === 'sqlite' ? 'INTEGER' : 'INTEGER',
          allowNull: true,
        });
      }
    }
  }

  async down() {
    const collection = this.db.getCollection('aiApiUsageRecords');
    if (!collection) return;

    if (await collection.existsInDb()) {
      const tableName = collection.getTableNameWithSchema();
      const exists = await this.tableColumnExists(tableName, 'promptCacheTokens');
      if (exists) {
        await this.queryInterface.removeColumn(tableName, 'promptCacheTokens');
      }
    }

    collection.removeField('promptCacheTokens');
  }

  private async tableColumnExists(tableName: string, columnName: string): Promise<boolean> {
    const columns = await this.queryInterface.describeTable(tableName);
    return Object.prototype.hasOwnProperty.call(columns, columnName);
  }
}
