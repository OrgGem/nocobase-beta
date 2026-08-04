import { Migration } from '@nocobase/server';

export default class ChangePackagesToTextMigration extends Migration {
  on = 'afterLoad';
  appVersion = '>=0.1.0';

  async up() {
    const queryInterface = (this as any).db.sequelize.getQueryInterface();
    const tableName = `${(this as any).db.options.tablePrefix || ''}skillDefinitions`;

    try {
      const tableExists = await queryInterface.tableExists(tableName);
      if (!tableExists) return;

      const tableDesc = await queryInterface.describeTable(tableName);
      const columnsToChange = ['packages', 'inputSchema', 'interactionSchema'];
      const fieldRepo = (this as any).db.getRepository('fields');
      const collectionName = 'skillDefinitions';

      for (const col of columnsToChange) {
        if (tableDesc[col]) {
          // Change physical column type in Postgres if needed
          const dialect = (this as any).db.sequelize.getDialect();
          if (dialect === 'postgres') {
            await (this as any).db.sequelize.query(
              `ALTER TABLE "${tableName}" ALTER COLUMN "${col}" TYPE text USING "${col}"::text;`,
            );
          } else {
            await queryInterface.changeColumn(tableName, col, {
              type: 'TEXT',
            });
          }

          // Also update NocoBase metadata
          const fieldMeta = await fieldRepo.findOne({
            filter: { name: col, collectionName },
          });

          if (fieldMeta) {
            await fieldRepo.update({
              filterByTk: fieldMeta.get('id'),
              values: { type: 'text' },
            });
          }
          (this as any).app.logger.info(`[skill-hub] Changed ${col} column type to text to support markdown`);
        }
      }
    } catch (error) {
      (this as any).app.logger.error(`[skill-hub] Failed to change packages field type: ${error.message}`);
    }
  }
}
