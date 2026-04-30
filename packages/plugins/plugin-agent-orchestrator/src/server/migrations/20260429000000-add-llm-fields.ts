import { Migration } from '@nocobase/server';

export default class AddLlmFieldsToOrchestratorConfig extends Migration {
  on = 'afterLoad';
  appVersion = '>=0.1.0';

  async up() {
    const queryInterface = this.db.sequelize.getQueryInterface();
    const tablePrefix = this.db.options.tablePrefix || '';
    const tableName = `${tablePrefix}orchestratorConfig`;

    const tableExists = await queryInterface.tableExists(tableName);
    if (!tableExists) return;

    const tableDesc = await queryInterface.describeTable(tableName);

    if (!tableDesc['llmService']) {
      await queryInterface.addColumn(tableName, 'llmService', {
        type: 'VARCHAR(255)',
        allowNull: true,
      });
      console.log(`[AgentOrchestrator] Added llmService column to ${tableName}`);
    }

    if (!tableDesc['model']) {
      await queryInterface.addColumn(tableName, 'model', {
        type: 'VARCHAR(255)',
        allowNull: true,
      });
      console.log(`[AgentOrchestrator] Added model column to ${tableName}`);
    }

    if (!tableDesc['recursionLimit']) {
      await queryInterface.addColumn(tableName, 'recursionLimit', {
        type: 'INTEGER',
        allowNull: true,
        defaultValue: 50,
      });
      console.log(`[AgentOrchestrator] Added recursionLimit column to ${tableName}`);
    }
  }

  async down() {
    // No rollback
  }
}
