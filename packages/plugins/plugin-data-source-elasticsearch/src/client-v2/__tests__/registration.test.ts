/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockClient } from '@nocobase/client-v2';
import NativeManager from '@nocobase/plugin-data-source-manager/client-v2';
import { describe, expect, it, vi } from 'vitest';
import Plugin from '../plugin';
import { toCollectionOptions } from '../ElasticsearchConfigForm';

describe('Elasticsearch native V2 datasource contract', () => {
  it('registers current manager capabilities and keeps selective collection options', async () => {
    const app = createMockClient();
    const manager = new NativeManager({}, app);
    vi.spyOn(app.pm, 'get').mockReturnValue(manager);
    await new Plugin({}, app).load();
    const type = manager.getType('elasticsearch');
    expect(type.disableTestConnection).toBe(false);
    expect(type.disableAddFields).toBe(true);
    expect(
      type.normalizeValues({
        options: { addAllCollections: false, indexPattern: 'logs-*' },
        collections: ['logs-one'],
      }),
    ).toMatchObject({ options: { addAllCollections: false, indexPattern: 'logs-*' }, collections: ['logs-one'] });
    expect(toCollectionOptions({ data: { data: ['logs-one', { name: 'logs-two' }, null] } })).toEqual([
      { label: 'logs-one', value: 'logs-one' },
      { label: 'logs-two', value: 'logs-two' },
    ]);
    vi.restoreAllMocks();
  });
});
