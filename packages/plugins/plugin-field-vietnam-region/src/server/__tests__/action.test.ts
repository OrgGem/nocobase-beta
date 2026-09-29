import { Database } from '@nocobase/database';
import { MockServer, createMockServer } from '@nocobase/test';

describe('vietnam region actions test', () => {
  let app: MockServer;
  let db: Database;
  beforeEach(async () => {
    app = await createMockServer({
      plugins: ['plugin-field-vietnam-region'],
    });

    db = app.db;
  });

  afterEach(async () => {
    await app.destroy();
  });

  it('should allow list action only on vietnamRegions resource', async () => {
    const listResponse = await app.agent().resource('vietnamRegions').list();

    expect(listResponse.statusCode).toEqual(200);

    const createResponse = await app.agent().resource('vietnamRegions').create();

    expect(createResponse.statusCode).toEqual(404);
  });

  it('should register the vietnamRegion interface', () => {
    expect(db.interfaceManager.getInterfaceType('vietnamRegion')).toBeDefined();
  });
});
