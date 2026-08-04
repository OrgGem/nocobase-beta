import { Migration } from '@nocobase/server';
import { DataTypes } from '@nocobase/database';

/**
 * Fix: inputArgs column in skillExecutions was json type but should be text.
 *
 * Root cause: The column was created as `json` from an older schema version,
 * but the collection defines it as `text`. The `stringifyJsonText()` utility
 * wraps values in markdown code fences (```json\n...\n```) which PostgreSQL
 * rejects as invalid JSON syntax, causing SequelizeDatabaseError on every
 * skill execution attempt.
 */
export default class FixInputArgsJsonToText extends Migration {
  on = 'afterLoad';
  appVersion = '>=0.1.0';

  async up() {
    const db = (this as any).db;
    const queryInterface = db.sequelize.getQueryInterface();
    const tableName = `${db.options.tablePrefix || ''}skillExecutions`;

    // Check current column type
    const tableDesc = await queryInterface.describeTable(tableName).catch(() => null);
    if (!tableDesc) return;

    const col = tableDesc['inputArgs'];
    if (!col) return;

    // Only migrate if still json type
    if (col.type && col.type.toLowerCase().includes('json')) {
      if (db.sequelize.getDialect() === 'postgres') {
        await db.sequelize.query(
          `ALTER TABLE "${tableName}" ALTER COLUMN "inputArgs" TYPE text USING "inputArgs"::text`,
        );
      } else {
        await queryInterface.changeColumn(tableName, 'inputArgs', { type: DataTypes.TEXT });
      }
      db.logger?.info?.('[skill-hub] Migration: converted skillExecutions.inputArgs from json to text');
    }
  }

  async down() {
    // No rollback — keeping as text is safe; json is more restrictive
  }
}
