import { Migration } from '@nocobase/server';

export default class AddCacheInputPriceToModelPrices extends Migration {
  on = 'beforeLoad' as const;

  async up() {
    await this.addDecimalColumn('aiApiModelPrices', 'cacheInputPricePerMillionTokens', false, 0);
    await this.addDecimalColumn('aiApiUsageRecords', 'cacheInputPricePerMillionTokens', true);
  }

  async down() {
    await this.removeColumn('aiApiUsageRecords', 'cacheInputPricePerMillionTokens');
    await this.removeColumn('aiApiModelPrices', 'cacheInputPricePerMillionTokens');
  }

  private async addDecimalColumn(
    collectionName: string,
    columnName: string,
    allowNull: boolean,
    defaultValue?: number,
  ): Promise<void> {
    const collection = this.db.getCollection(collectionName);
    if (!collection || !(await collection.existsInDb())) return;

    const tableName = collection.getTableNameWithSchema();
    if (await this.columnExists(tableName, columnName)) return;

    await this.queryInterface.addColumn(tableName, columnName, {
      type: 'DECIMAL(20,10)',
      allowNull,
      ...(defaultValue === undefined ? {} : { defaultValue }),
    });
  }

  private async removeColumn(collectionName: string, columnName: string): Promise<void> {
    const collection = this.db.getCollection(collectionName);
    if (!collection || !(await collection.existsInDb())) return;

    const tableName = collection.getTableNameWithSchema();
    if (await this.columnExists(tableName, columnName)) {
      await this.queryInterface.removeColumn(tableName, columnName);
    }
  }

  private async columnExists(tableName: string, columnName: string): Promise<boolean> {
    const columns = await this.queryInterface.describeTable(tableName);
    return Object.prototype.hasOwnProperty.call(columns, columnName);
  }
}
