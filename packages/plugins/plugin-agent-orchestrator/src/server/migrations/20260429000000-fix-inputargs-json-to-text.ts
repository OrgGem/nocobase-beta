import { Migration } from '@nocobase/server';

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
    const queryInterface = (this as any).db.sequelize.getQueryInterface();

    // Check current column type
    const tableDesc = await queryInterface.describeTable('skillExecutions').catch(() => null);
    if (!tableDesc) return;

    const col = tableDesc['inputArgs'];
    if (!col) return;

    // Only migrate if still json type
    if (col.type && col.type.toLowerCase().includes('json')) {
      await (this as any).db.sequelize.query(
        `ALTER TABLE "skillExecutions" ALTER COLUMN "inputArgs" TYPE text USING "inputArgs"::text`,
      );
      console.log('[skill-hub] Migration: converted skillExecutions.inputArgs from json to text');
    }
  }

  async down() {
    // No rollback — keeping as text is safe; json is more restrictive
  }
}
