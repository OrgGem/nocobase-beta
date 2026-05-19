import { Migration } from '@nocobase/server';

/**
 * Deprecated no-op.
 *
 * Legacy web-client embedding support was removed from plugin-knowledge-base.
 * The cleanup migration drops old columns when they exist.
 */
export default class AddWebClientEmbedFields extends Migration {
  on = 'afterLoad';
  appVersion = '<=2.x';

  async up() {}
}
