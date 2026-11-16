// SPDX-License-Identifier: Apache-2.0

import { createMockServer, type MockServer } from '@nocobase/test';
import Plugin from '../plugin';

describe('Authenticated File Previewer plugin smoke', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it('loads the source plugin and registers its OCR collection and resource', async () => {
    app = await createMockServer({
      plugins: ['field-sort', 'users', 'auth', 'file-manager', [Plugin, { name: 'plugin-file-preview-auth' }]],
    });

    expect(app.pm.get('plugin-file-preview-auth')).toBeInstanceOf(Plugin);
    expect(await app.db.getCollection('attachmentOcrResults').existsInDb()).toBe(true);
    expect(app.resourceManager.getResource('filePreviewAuth')).toBeTruthy();
  });
});
