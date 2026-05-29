import { Migration } from '@nocobase/server';

export default class extends Migration {
  on = 'afterLoad';

  async up() {
    const attachments = this.db.getCollection('attachments');
    if (!attachments) {
      return;
    }

    const queryInterface = this.db.sequelize.getQueryInterface();
    const tableName = attachments.getTableNameWithSchema();
    const columns = await queryInterface.describeTable(tableName).catch(() => null);
    if (!columns) {
      return;
    }

    await this.db.sequelize.transaction(async (transaction) => {
      if (columns.ocrStatus) {
        await queryInterface.removeColumn(tableName, 'ocrStatus', { transaction });
      }
      if (columns.ocrData) {
        await queryInterface.removeColumn(tableName, 'ocrData', { transaction });
      }

      const fieldRepo = this.db.getRepository('fields');
      if (fieldRepo) {
        await fieldRepo.destroy({
          filter: {
            collectionName: 'attachments',
            name: ['ocrStatus', 'ocrData'],
          },
          transaction,
        });
      }
    });
  }
}
