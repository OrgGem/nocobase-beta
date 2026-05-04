import { Migration } from '@nocobase/server';

export default class ChangeOtherJsonToTextMigration extends Migration {
  async up() {
    const queryInterface = this.db.sequelize.getQueryInterface();
    const dialect = this.db.sequelize.getDialect();
    const fieldRepo = this.db.getRepository('fields');

    const tablePrefix = this.db.options.tablePrefix || '';
    
    // 1. skillWorkerConfigs
    const workerTableName = `${tablePrefix}skillWorkerConfigs`;
    try {
      if (await queryInterface.tableExists(workerTableName)) {
        const tableDesc = await queryInterface.describeTable(workerTableName);
        const columns = ['packageWhitelist', 'customPackages'];
        
        for (const col of columns) {
          if (tableDesc[col]) {
            if (dialect === 'postgres') {
              await this.db.sequelize.query(`ALTER TABLE "${workerTableName}" ALTER COLUMN "${col}" TYPE text USING "${col}"::text;`);
            } else {
              await queryInterface.changeColumn(workerTableName, col, { type: 'TEXT' });
            }
            const fieldMeta = await fieldRepo.findOne({ filter: { name: col, collectionName: 'skillWorkerConfigs' } });
            if (fieldMeta) await fieldRepo.update({ filterByTk: fieldMeta.get('id'), values: { type: 'text' } });
            this.app.logger.info(`[skill-hub] Changed ${col} in skillWorkerConfigs to text`);
          }
        }
      }
    } catch (e) {
      this.app.logger.warn(`[skill-hub] Failed to migrate skillWorkerConfigs: ${e.message}`);
    }

    // 2. skillExecutions
    const execTableName = `${tablePrefix}skillExecutions`;
    try {
      if (await queryInterface.tableExists(execTableName)) {
        const tableDesc = await queryInterface.describeTable(execTableName);
        const col = 'outputFiles';
        
        if (tableDesc[col]) {
          if (dialect === 'postgres') {
            await this.db.sequelize.query(`ALTER TABLE "${execTableName}" ALTER COLUMN "${col}" TYPE text USING "${col}"::text;`);
          } else {
            await queryInterface.changeColumn(execTableName, col, { type: 'TEXT' });
          }
          const fieldMeta = await fieldRepo.findOne({ filter: { name: col, collectionName: 'skillExecutions' } });
          if (fieldMeta) await fieldRepo.update({ filterByTk: fieldMeta.get('id'), values: { type: 'text' } });
          this.app.logger.info(`[skill-hub] Changed ${col} in skillExecutions to text`);
        }
      }
    } catch (e) {
      this.app.logger.warn(`[skill-hub] Failed to migrate skillExecutions: ${e.message}`);
    }
  }
}
