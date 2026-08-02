import { createMockServer, type MockServer } from '@nocobase/test';
import { DOCKER_REGISTRY_DESKTOP_ROUTE_SCHEMA_UID } from '../../shared/routes';
import RemoveManagedDesktopRouteMigration from '../migrations/20260802170000-remove-managed-desktop-route';

describe('Docker Registry desktop route migration', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it('removes only the obsolete plugin-owned desktop route', async () => {
    app = await createMockServer({ plugins: ['nocobase', 'docker-registry-ui'] });
    const repository = app.db.getRepository('desktopRoutes');
    await repository.create({
      values: {
        type: 'link',
        title: 'Docker Registry',
        schemaUid: DOCKER_REGISTRY_DESKTOP_ROUTE_SCHEMA_UID,
        options: { href: '/docker-registry', openInNewWindow: false },
      },
    });
    await repository.create({
      values: {
        type: 'link',
        title: 'User route',
        schemaUid: 'user-owned-route',
        options: { href: '/user-route', openInNewWindow: false },
      },
    });

    const migration = new RemoveManagedDesktopRouteMigration({ db: app.db, app });
    await migration.up();

    expect(await repository.count({ filter: { schemaUid: DOCKER_REGISTRY_DESKTOP_ROUTE_SCHEMA_UID } })).toBe(0);
    expect(await repository.count({ filter: { schemaUid: 'user-owned-route' } })).toBe(1);
  });
});
