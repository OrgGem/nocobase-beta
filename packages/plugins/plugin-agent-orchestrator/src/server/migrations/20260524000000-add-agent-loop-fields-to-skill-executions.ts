import { Migration } from '@nocobase/server';
import { DataTypes } from '@nocobase/database';

export default class AddAgentLoopFieldsToSkillExecutions extends Migration {
  on = 'afterLoad';
  appVersion = '>=0.1.0';

  async up() {
    const queryInterface = (this as any).db.sequelize.getQueryInterface();
    const tablePrefix = (this as any).db.options.tablePrefix || '';
    const tableName = `${tablePrefix}skillExecutions`;
    const tableExists = await queryInterface.tableExists(tableName).catch(() => false);
    if (!tableExists) return;

    const tableDesc = await queryInterface.describeTable(tableName);
    const addIfMissing = async (name: string) => {
      if (tableDesc[name]) return;
      await queryInterface.addColumn(tableName, name, {
        type: DataTypes.STRING(100),
        allowNull: true,
      });
    };

    await addIfMissing('agentLoopRunId');
    await addIfMissing('agentLoopStepId');
  }

  async down() {
    // No rollback: these nullable trace-link columns are backward compatible.
  }
}
