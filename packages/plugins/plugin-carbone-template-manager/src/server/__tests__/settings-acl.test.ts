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
import Plugin from '../plugin';

vi.mock('../services/ha-lock', () => ({ runWithDistributedLock: vi.fn() }));

it('grants all child actions through Settings alone without granting unrelated resources', async () => {
  const acl = new ACL();
  const app = {
    acl,
    db: { import: vi.fn(), on: vi.fn() },
    resourcer: { registerActionHandlers: vi.fn() },
    pm: { get: vi.fn() },
    on: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn() },
  };
  const plugin = new Plugin(app as never, { name: 'plugin-carbone-template-manager' });
  Object.defineProperty(plugin, 'cleanupTempFiles', { value: vi.fn(async () => undefined) });
  await plugin.load();
  const parent = 'pm.plugin-carbone-template-manager.settings';
  acl.define({ role: 'operator' }).snippets.add(parent);
  for (const suffix of ['connection', 'templates', 'render', 'versions', 'monitoring']) {
    const child = acl.snippetManager.snippets.get(`pm.plugin-carbone-template-manager.${suffix}`);
    for (const action of child.actions) {
      const [resource, actionName] = action.split(':');
      expect(acl.can({ role: 'operator', resource, action: actionName === '*' ? 'get' : actionName })).toBeTruthy();
    }
  }
  expect(acl.can({ role: 'operator', resource: 'users', action: 'destroy' })).toBeNull();
});
