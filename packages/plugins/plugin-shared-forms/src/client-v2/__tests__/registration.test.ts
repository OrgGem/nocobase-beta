/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockClient } from '@nocobase/client-v2';
import { describe, expect, it } from 'vitest';
import SharedFormsPlugin from '../plugin';

describe('Shared Forms registration in a native V2 application', () => {
  it('keeps the form route authenticated and registers the native hidden designer under settings', async () => {
    const app = createMockClient();
    await new SharedFormsPlugin({}, app).load();
    expect(app.router.getRoutes()['shared-forms']).toMatchObject({ path: '/shared-forms/:name', authCheck: true });
    expect(app.router.getRoutes()['shared-forms'].skipAuthCheck).not.toBe(true);
    const menu = app.pluginSettingsManager.getList().find((item) => item.name === 'shared-forms');
    expect(menu?.aclSnippet).toBe('pm.shared-forms');
    expect(menu?.children?.find((item) => item.pageKey === ':name')).toMatchObject({
      hidden: true,
      aclSnippet: 'pm.shared-forms',
    });
    expect(app.flowEngine.getModelClass('SharedFormModel')).toBeDefined();
    expect(app.flowEngine.getModelClass('SharedFormSubmitActionModel')).toBeDefined();
  });
});
