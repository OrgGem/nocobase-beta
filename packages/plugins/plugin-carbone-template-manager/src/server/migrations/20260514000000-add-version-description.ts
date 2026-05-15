import { Migration } from '@nocobase/server';
import { DataTypes } from 'sequelize';
import { COLLECTION } from '../../shared/constants';

export default class AddVersionDescriptionMigration extends Migration {
  on = 'afterLoad';

  async up() {
    const queryInterface = (this as any).db.sequelize.getQueryInterface();
    const tablePrefix = (this as any).db.options?.tablePrefix || '';
    const tableName = `${tablePrefix}${COLLECTION.versions}`;
    const tableInfo = await queryInterface.describeTable(tableName).catch(() => null);
    if (!tableInfo || tableInfo.description) return;

    await queryInterface.addColumn(tableName, 'description', {
      type: DataTypes.TEXT,
      allowNull: true,
    });
  }

  async down() {
    const queryInterface = (this as any).db.sequelize.getQueryInterface();
    const tablePrefix = (this as any).db.options?.tablePrefix || '';
    const tableName = `${tablePrefix}${COLLECTION.versions}`;
    const tableInfo = await queryInterface.describeTable(tableName).catch(() => null);
    if (!tableInfo?.description) return;

    await queryInterface.removeColumn(tableName, 'description');
  }
}
