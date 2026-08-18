import { join } from 'path';

import { importModule } from '@nocobase/utils';

describe('skill-registry migrations', () => {
  it('should export a Migration constructor loadable by app.loadMigrations', async () => {
    const file = join(__dirname, '../migrations/20250815000000-markdown-skills.ts');
    const Migration = await importModule(file);
    expect(typeof Migration).toBe('function');

    const instance = new Migration({ app: {}, db: {} });
    expect(instance.on).toBe('afterSync');
    expect(typeof instance.up).toBe('function');
    expect(typeof instance.down).toBe('function');
  });
});
