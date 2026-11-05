/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { ACL } from '@nocobase/acl';
import { expect, it, vi } from 'vitest';
import { PluginFilePreviewAuthServer } from '../plugin';

it('does not expose generic OCR results to an ordinary authenticated user', async () => {
  const acl = new ACL();
  acl.define({ role: 'member' });
  const plugin = Object.create(PluginFilePreviewAuthServer.prototype);
  Object.defineProperties(plugin, {
    app: { value: { acl, resourcer: { define: vi.fn() } } },
    log: { value: { info: vi.fn() } },
  });
  plugin.registerDownloadApi();
  for (const actionName of ['get', 'list', 'create', 'update']) {
    const handler = vi.fn();
    const ctx = {
      state: { currentUser: { id: 7 }, currentRoles: ['member'] },
      action: { resourceName: 'attachmentOcrResults', actionName, params: { filterByTk: 99 } },
      throw: (status: number) => {
        throw Object.assign(new Error('denied'), { status });
      },
    };
    await expect(acl.middleware()(ctx, handler)).rejects.toMatchObject({ status: 403 });
    expect(handler).not.toHaveBeenCalled();
  }
  expect(
    await acl.allowManager.isAllowed('filePreviewAuth', 'getOcrStatus', { state: { currentUser: { id: 7 } } }),
  ).toBe(true);
});
