import { Migration } from '@nocobase/server';
import { DOCKER_REGISTRY_DESKTOP_ROUTE_SCHEMA_UID } from '../../shared/routes';

export default class RemoveManagedDesktopRouteMigration extends Migration {
  on = 'afterLoad' as const;

  async up() {
    await this.db
      .getRepository('desktopRoutes')
      .destroy({ filter: { schemaUid: DOCKER_REGISTRY_DESKTOP_ROUTE_SCHEMA_UID } });
  }
}
