import { createMockServer } from '@nocobase/test';

describe('Authenticated File Previewer plugin smoke', () => {
  let app;

  afterEach(async () => {
    await app?.destroy();
  });

  it('loads without starting the full app', async () => {
    app = await createMockServer({
      plugins: ['nocobase', 'file-preview-auth'],
    });

    expect(app).toBeTruthy();
  });
});
