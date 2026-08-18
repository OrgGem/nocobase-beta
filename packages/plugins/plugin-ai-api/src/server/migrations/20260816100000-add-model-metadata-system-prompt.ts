import { Migration } from '@nocobase/server';

export default class AddSystemPromptToModelMetadata extends Migration {
  on = 'beforeLoad' as const;

  async up() {
    const collection = this.db.getCollection('aiApiModelMetadata');
    if (!collection) return;

    const field = collection.getField('systemPrompt');
    if (!field) {
      collection.addField('systemPrompt', { type: 'text', allowNull: true });
    }

    if (await collection.existsInDb()) {
      const tableName = collection.getTableNameWithSchema();
      const exists = await this.tableColumnExists(tableName, 'systemPrompt');
      if (!exists) {
        await this.queryInterface.addColumn(tableName, 'systemPrompt', {
          type: 'TEXT',
          allowNull: true,
        });
      }
    }
  }

  async down() {
    const collection = this.db.getCollection('aiApiModelMetadata');
    if (!collection) return;

    if (await collection.existsInDb()) {
      const tableName = collection.getTableNameWithSchema();
      const exists = await this.tableColumnExists(tableName, 'systemPrompt');
      if (exists) {
        await this.queryInterface.removeColumn(tableName, 'systemPrompt');
      }
    }

    collection.removeField('systemPrompt');
  }

  private async tableColumnExists(tableName: string, columnName: string): Promise<boolean> {
    const columns = await this.queryInterface.describeTable(tableName);
    return Object.prototype.hasOwnProperty.call(columns, columnName);
  }
}
