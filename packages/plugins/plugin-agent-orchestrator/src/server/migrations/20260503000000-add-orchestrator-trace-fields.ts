import { Migration } from '@nocobase/server';

export default class AddOrchestratorTraceFieldsToSkillExecutions extends Migration {
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
        type: 'VARCHAR(100)',
        allowNull: true,
      });
    };

    await addIfMissing('orchestratorRootRunId');
    await addIfMissing('orchestratorSpanId');
    await addIfMissing('orchestratorParentSpanId');
    await addIfMissing('orchestratorToolCallId');
  }

  async down() {
    // No rollback: keeping nullable trace-link columns is safe.
  }
}
