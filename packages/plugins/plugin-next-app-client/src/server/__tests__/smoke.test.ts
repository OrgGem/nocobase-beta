import { createMockServer } from '@nocobase/test';
import PluginFieldSortServer from '@nocobase/plugin-field-sort';
import PluginNextAppServer from '../plugin';

describe('Next App Client plugin smoke', () => {
  let app;

  beforeEach(async () => {
    app = await createMockServer({
      plugins: ['nocobase', PluginFieldSortServer, PluginNextAppServer],
    });
  });

  afterEach(async () => {
    await app?.destroy();
  });

  it('loads without starting the full app', async () => {
    expect(app).toBeTruthy();
  });

  it('can create and query nextAppConfig', async () => {
    const configRepository = app.db.getRepository('nextAppConfig');
    const config = await configRepository.create({
      values: {
        path: 'test-app',
        title: 'Test App',
        enabled: true,
      },
    });

    expect(config.id).toBeTruthy();
    expect(config.path).toBe('test-app');
    expect(config.title).toBe('Test App');
  });

  it('can create nextAppRoutes and respects tree hierarchy', async () => {
    const configRepository = app.db.getRepository('nextAppConfig');
    const routesRepository = app.db.getRepository('nextAppRoutes');

    const config = await configRepository.create({
      values: {
        path: 'test-app',
        title: 'Test App',
      },
    });

    const parentRoute = await routesRepository.create({
      values: {
        title: 'Parent Route',
        configId: config.id,
      },
    });

    const childRoute = await routesRepository.create({
      values: {
        title: 'Child Route',
        parentId: parentRoute.id,
        configId: config.id,
      },
    });

    expect(parentRoute.id).toBeTruthy();
    expect(childRoute.parentId).toBe(parentRoute.id);

    // Test tree hierarchy querying
    const routes = await routesRepository.find({
      tree: true,
      appends: ['children'],
      filter: {
        parentId: null,
        configId: config.id,
      },
    });

    expect(routes.length).toBe(1);
    expect(routes[0].title).toBe('Parent Route');
    expect(routes[0].children.length).toBe(1);
    expect(routes[0].children[0].title).toBe('Child Route');
  });

  it('triggers hooks when updating enableTabs', async () => {
    const routesRepository = app.db.getRepository('nextAppRoutes');

    const parentRoute = await routesRepository.create({
      values: {
        title: 'Parent Route',
        enableTabs: false,
      },
    });

    const childRoute = await routesRepository.create({
      values: {
        title: 'Child Route',
        parentId: parentRoute.id,
        hidden: false,
      },
    });

    // Update parent enableTabs to true
    await routesRepository.update({
      filterByTk: parentRoute.id,
      values: {
        enableTabs: true,
      },
    });

    const updatedChild = await routesRepository.findOne({
      filterByTk: childRoute.id,
    });

    // enableTabs is true -> hidden should be !enableTabs -> false
    expect(updatedChild.hidden).toBe(false);

    // Update parent enableTabs to false
    await routesRepository.update({
      filterByTk: parentRoute.id,
      values: {
        enableTabs: false,
      },
    });

    const updatedChild2 = await routesRepository.findOne({
      filterByTk: childRoute.id,
    });

    // enableTabs is false -> hidden should be !enableTabs -> true
    expect(updatedChild2.hidden).toBe(true);
  });
});
