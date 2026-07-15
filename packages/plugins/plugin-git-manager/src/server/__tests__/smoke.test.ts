import { createMockServer } from '@nocobase/test';

describe('Git Manager plugin smoke', () => {
  let app;

  afterEach(async () => {
    await app?.destroy();
  });

  it('loads without starting the full app', async () => {
    app = await createMockServer({
      plugins: ['nocobase', 'git-manager'],
    });

    expect(app).toBeTruthy();
  });
});
