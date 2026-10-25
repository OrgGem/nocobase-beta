/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockClient } from '@nocobase/client-v2';
import NativeFileManager from '@nocobase/plugin-file-manager/client-v2';
import { describe, expect, it, vi } from 'vitest';
import Plugin from '../plugin';
import { STORAGE_TYPE_S3_PRIVATE } from '../../constants';

describe('private S3 native V2 storage contract', () => {
  it('registers the lazy native form and credential defaults in File Manager', async () => {
    const app = createMockClient();
    const manager = new NativeFileManager({}, app);
    vi.spyOn(app.pm, 'get').mockReturnValue(manager);
    await new Plugin({}, app).load();
    const storage = manager.getStorageType(STORAGE_TYPE_S3_PRIVATE);
    expect(storage.defaultValues).toMatchObject({
      renameMode: 'appendRandomID',
      baseUrl: '',
      options: { endpoint: '' },
    });
    expect((await storage.formLoader()).default).toBeTypeOf('function');
    vi.restoreAllMocks();
  });
});
