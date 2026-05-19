import { Migration } from '@nocobase/server';

export default class RemoveWebClientEmbedFieldsMigration extends Migration {
  on = 'afterLoad';
  appVersion = '<=2.x';

  async up() {
    const db = (this as any).db;
    const queryInterface = db.sequelize.getQueryInterface();
    const tablePrefix = db.options?.tablePrefix || '';

    const quoteTable = (tableName: string) => queryInterface.quoteTable(tableName);
    const quoteIdentifier = (identifier: string) => queryInterface.quoteIdentifier(identifier);
    const describeTable = (tableName: string) => queryInterface.describeTable(tableName).catch(() => null);

    const kbTable = `${tablePrefix}aiKnowledgeBases`;
    const kbColumns = await describeTable(kbTable);
    if (kbColumns) {
      await db.sequelize.query(
        `UPDATE ${quoteTable(kbTable)}
         SET ${quoteIdentifier('type')} = 'LOCAL', ${quoteIdentifier('enabled')} = false
         WHERE ${quoteIdentifier('type')} = 'WEB_CLIENT_EMBED'`,
      );

      for (const column of ['embedModelId', 'embedMode']) {
        if (kbColumns[column]) {
          await queryInterface.removeColumn(kbTable, column);
        }
      }
    }

    const vectorStoreTable = `${tablePrefix}aiVectorStores`;
    const vectorStoreColumns = await describeTable(vectorStoreTable);
    if (vectorStoreColumns) {
      if (vectorStoreColumns.embeddingProvider) {
        await db.sequelize.query(
          `UPDATE ${quoteTable(vectorStoreTable)}
           SET ${quoteIdentifier('enabled')} = false
           WHERE ${quoteIdentifier('embeddingProvider')} = 'localEmbed'
             AND (${quoteIdentifier('llmService')} IS NULL OR ${quoteIdentifier('llmService')} = ''
               OR ${quoteIdentifier('embeddingModel')} IS NULL OR ${quoteIdentifier('embeddingModel')} = '')`,
        );
      }

      for (const column of ['embeddingProvider', 'localEmbedModelId', 'localEmbedDtype']) {
        if (vectorStoreColumns[column]) {
          await queryInterface.removeColumn(vectorStoreTable, column);
        }
      }
    }
  }
}
