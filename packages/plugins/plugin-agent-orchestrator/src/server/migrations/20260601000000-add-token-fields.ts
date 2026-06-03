import { Migration } from '@nocobase/server';

export default class AddTokenFieldsMigration extends Migration {
  on = 'afterLoad';
  appVersion = '<=2.x';

  async up() {
    const queryInterface = (this as any).db.sequelize.getQueryInterface();
    const DataTypes = (this as any).db.sequelize.constructor['DataTypes'];
    const prefix = (this as any).db.options.tablePrefix || '';

    // ── agentExecutionSpans ──
    const spansTable = `${prefix}agentExecutionSpans`;
    const spansExists = await queryInterface
      .describeTable(spansTable)
      .then(() => true)
      .catch(() => false);
    if (spansExists) {
      const spansCols = await queryInterface.describeTable(spansTable);
      const addSpanIfMissing = async (name: string, definition: any) => {
        if (!spansCols[name]) {
          await queryInterface.addColumn(spansTable, name, definition);
        }
      };
      await addSpanIfMissing('inputTokens', { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });
      await addSpanIfMissing('outputTokens', { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });
      await addSpanIfMissing('totalTokens', { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });
      await addSpanIfMissing('cost', { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 });
    }

    // ── agentLoopRuns ──
    const runsTable = `${prefix}agentLoopRuns`;
    const runsExists = await queryInterface
      .describeTable(runsTable)
      .then(() => true)
      .catch(() => false);
    if (runsExists) {
      const runsCols = await queryInterface.describeTable(runsTable);
      const addRunIfMissing = async (name: string, definition: any) => {
        if (!runsCols[name]) {
          await queryInterface.addColumn(runsTable, name, definition);
        }
      };
      await addRunIfMissing('totalInputTokens', { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });
      await addRunIfMissing('totalOutputTokens', { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });
      await addRunIfMissing('totalTokens', { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });
      await addRunIfMissing('totalCost', { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 });
      await addRunIfMissing('budgetMaxTokens', { type: DataTypes.INTEGER, allowNull: true });
      await addRunIfMissing('budgetMaxCost', { type: DataTypes.FLOAT, allowNull: true });
    }

    // ── orchestratorConfig ──
    const configTable = `${prefix}orchestratorConfig`;
    const configExists = await queryInterface
      .describeTable(configTable)
      .then(() => true)
      .catch(() => false);
    if (configExists) {
      const configCols = await queryInterface.describeTable(configTable);
      const addConfigIfMissing = async (name: string, definition: any) => {
        if (!configCols[name]) {
          await queryInterface.addColumn(configTable, name, definition);
        }
      };
      await addConfigIfMissing('budgetMaxTokens', { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 });
      await addConfigIfMissing('budgetMaxCost', { type: DataTypes.FLOAT, allowNull: true, defaultValue: 0 });
    }
  }

  async down() {
    const queryInterface = (this as any).db.sequelize.getQueryInterface();
    const prefix = (this as any).db.options.tablePrefix || '';

    const tables = [
      { name: `${prefix}agentExecutionSpans`, cols: ['inputTokens', 'outputTokens', 'totalTokens', 'cost'] },
      {
        name: `${prefix}agentLoopRuns`,
        cols: ['totalInputTokens', 'totalOutputTokens', 'totalTokens', 'totalCost', 'budgetMaxTokens', 'budgetMaxCost'],
      },
      { name: `${prefix}orchestratorConfig`, cols: ['budgetMaxTokens', 'budgetMaxCost'] },
    ];

    for (const { name, cols } of tables) {
      for (const col of cols) {
        await queryInterface.removeColumn(name, col).catch(() => {});
      }
    }
  }
}
