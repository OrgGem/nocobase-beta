import { Migration } from '@nocobase/server';

export default class AddInteractionSchemaMigration extends Migration {
  async up() {
    const queryInterface = this.db.sequelize.getQueryInterface();
    const tableName = `${this.db.options.tablePrefix || ''}skillDefinitions`;

    try {
      const tableExists = await queryInterface.tableExists(tableName);
      if (!tableExists) return;

      const tableDesc = await queryInterface.describeTable(tableName);
      const fieldRepo = this.db.getRepository('fields');
      const collectionName = 'skillDefinitions';

      const fieldMeta = await fieldRepo.findOne({
        filter: { name: 'interactionSchema', collectionName },
      });

      if (!fieldMeta && tableDesc.interactionSchema) {
        await fieldRepo.create({
          values: {
            name: 'interactionSchema',
            type: 'text',
            collectionName,
            interface: 'textarea',
          },
        });
        this.app.logger.info('[skill-hub] Restored NocoBase metadata for preexisting column interactionSchema');
      }
    } catch (error) {
      this.app.logger.error(`[skill-hub] Failed to check interactionSchema field: ${error.message}`);
    }
  }
}
