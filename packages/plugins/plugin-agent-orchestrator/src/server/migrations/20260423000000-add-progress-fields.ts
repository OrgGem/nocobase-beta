import { Migration } from '@nocobase/server';

export default class AddProgressFieldsMigration extends Migration {
  async up() {
    const queryInterface = (this as any).db.sequelize.getQueryInterface();
    const tablePrefix = (this as any).db.options.tablePrefix || '';
    const tableName = `${tablePrefix}skillWorkerConfigs`;

    try {
      const tableExists = await queryInterface.tableExists(tableName);
      if (!tableExists) return;

      const tableDesc = await queryInterface.describeTable(tableName);

      // Force NocoBase fields metadata to recognize the physical columns exists
      // so it won't crash trying to ADD COLUMN during db.sync()
      const fieldRepo = (this as any).db.getRepository('fields');
      const collectionName = 'skillWorkerConfigs';

      const fieldsToSync = [
        { name: 'initProgressPercent', type: 'integer', defaultValue: 0 },
        { name: 'initProgressLog', type: 'text' },
      ];

      for (const f of fieldsToSync) {
        const fieldMeta = await fieldRepo.findOne({
          filter: { name: f.name, collectionName },
        });

        if (!fieldMeta && tableDesc[f.name]) {
          // The physical column exists, but NocoBase metadata is missing it!
          // Let's create the metadata right now BEFORE NocoBase's collection.sync()
          // runs and crashes on addColumn.
          await fieldRepo.create({
            values: {
              name: f.name,
              type: f.type,
              collectionName,
              // Avoid trying to physically add it because it already exists
              interface: f.type,
            },
          });
          (this as any).app.logger.info(`[skill-hub] Restored NocoBase metadata for preexisting column ${f.name}`);
        }
      }
    } catch (error) {
      (this as any).app.logger.error(`[skill-hub] Failed to check progress fields: ${error.message}`);
    }
  }
}
