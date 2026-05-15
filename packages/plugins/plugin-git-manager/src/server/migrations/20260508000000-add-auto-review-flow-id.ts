import { Migration } from '@nocobase/server';
import { DataTypes } from 'sequelize';

export default class AddAutoReviewFlowIdMigration extends Migration {
  on = 'afterLoad';

  async up() {
    const queryInterface = (this as any).db.sequelize.getQueryInterface();
    const tablePrefix = (this as any).db.options?.tablePrefix || '';
    const tableName = `${tablePrefix}gitRepositories`;
    const tableInfo = await queryInterface.describeTable(tableName).catch(() => null);
    if (!tableInfo || tableInfo.autoReviewFlowId) return;

    await queryInterface.addColumn(tableName, 'autoReviewFlowId', {
      type: DataTypes.INTEGER,
      allowNull: true,
    });
  }

  async down() {
    const queryInterface = (this as any).db.sequelize.getQueryInterface();
    const tablePrefix = (this as any).db.options?.tablePrefix || '';
    const tableName = `${tablePrefix}gitRepositories`;
    const tableInfo = await queryInterface.describeTable(tableName).catch(() => null);
    if (!tableInfo?.autoReviewFlowId) return;

    await queryInterface.removeColumn(tableName, 'autoReviewFlowId');
  }
}
