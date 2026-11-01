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
import PluginNextAppClient from '../plugin';
import { NextAppRuntime } from '../NextAppRuntime';

describe('Next App native application registration', () => {
  it('keeps the native page/tab/view children when replacing the layout entry with the isolated Hub runtime', async () => {
    const app = createMockClient();
    const plugin = new PluginNextAppClient({}, app);
    await plugin.load();
    const routes = app.router.getRoutes();
    expect(routes.hub).toMatchObject({ path: '/hub/:appPath', Component: NextAppRuntime, authCheck: true });
    expect(routes['hub.__page']).toMatchObject({ path: ':name', authCheck: true });
    expect(routes['hub.__pageTab']).toMatchObject({ path: ':name/tab/:tabUid' });
    expect(routes['hub.__pageView']).toMatchObject({ path: ':name/view/*' });
    expect(routes['hub.__pageTabView']).toMatchObject({ path: ':name/tab/:tabUid/view/*' });
    expect(app.layoutManager.getLayout('hub').authCheck).toBe(true);
    const menu = app.pluginSettingsManager.getList().find((item) => item.name === 'next-app-routes');
    expect(menu?.aclSnippet).toBe('pm.nextApp');
    expect(menu?.children?.[0].aclSnippet).toBe('pm.nextApp');
  });
});
