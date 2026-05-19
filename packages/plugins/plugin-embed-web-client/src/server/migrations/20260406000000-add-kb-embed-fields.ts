import { Migration } from '@nocobase/server';

/**
 * Deprecated no-op.
 *
 * Knowledge Base no longer integrates with this plugin, so this migration must
 * not add legacy Knowledge Base embedding columns.
 */
export default class AddKbEmbedFieldsMigration extends Migration {
  on = 'afterLoad' as const;

  async up() {}

  async down() {}
}
