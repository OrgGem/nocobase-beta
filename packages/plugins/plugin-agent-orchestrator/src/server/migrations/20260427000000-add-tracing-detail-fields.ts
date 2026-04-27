import { Migration } from '@nocobase/server';

export default class AddTracingDetailFieldsMigration extends Migration {
  on = 'afterLoad';
  appVersion = '<=2.x';

  async up() {
    const queryInterface = this.db.sequelize.getQueryInterface();
    const DataTypes = this.db.sequelize.constructor['DataTypes'];
    const tableName = `${this.db.options.tablePrefix || ''}orchestratorLogs`;

    const tableExists = await queryInterface
      .describeTable(tableName)
      .then(() => true)
      .catch(() => false);

    if (!tableExists) {
      return;
    }

    const columns = await queryInterface.describeTable(tableName);
    const addIfMissing = async (name: string, definition: any) => {
      if (!columns[name]) {
        await queryInterface.addColumn(tableName, name, definition);
      }
    };

    await addIfMissing('context', { type: DataTypes.TEXT, allowNull: true });
    await addIfMissing('trace', { type: DataTypes.JSON, allowNull: true, defaultValue: [] });
    await addIfMissing('messages', { type: DataTypes.JSON, allowNull: true, defaultValue: [] });
  }

  async down() {
    const queryInterface = this.db.sequelize.getQueryInterface();
    const tableName = `${this.db.options.tablePrefix || ''}orchestratorLogs`;

    for (const column of ['context', 'trace', 'messages']) {
      await queryInterface.removeColumn(tableName, column).catch(() => {});
    }
  }
}
