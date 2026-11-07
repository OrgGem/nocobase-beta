/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockServer, type MockServer } from '@nocobase/test';
import PluginStartupGuardianServer from '../plugin';

describe('Startup Guardian resource ACL over HTTP', () => {
  let app: MockServer;
  let reader: ReturnType<MockServer['agent']>;
  let manager: ReturnType<MockServer['agent']>;
  let stateDirectory = '';
  const originalStateDirectory = process.env.STARTUP_GUARDIAN_STATE_DIR;
  const originalAppId = process.env.STARTUP_GUARDIAN_APP_ID;
  const originalDialect = process.env.DB_DIALECT;

  beforeAll(async () => {
    stateDirectory = mkdtempSync(join(tmpdir(), 'startup-guardian-acl-'));
    process.env.STARTUP_GUARDIAN_STATE_DIR = stateDirectory;
    process.env.STARTUP_GUARDIAN_APP_ID = 'main';
    process.env.DB_DIALECT = 'sqlite';
    app = await createMockServer({
      name: 'main',
      acl: true,
      resourcer: { prefix: '/api' },
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: [
        'field-sort',
        'system-settings',
        'users',
        'auth',
        'acl',
        'data-source-manager',
        'data-source-main',
        'error-handler',
        [PluginStartupGuardianServer, { name: 'plugin-startup-guardian', enabled: true, isPreset: true }],
      ],
    });
    expect(app.resourceManager.isDefined('startupGuardian')).toBe(true);

    await app.db.getRepository('roles').create({ values: { name: 'guardian-reader', title: 'Reader' } });
    await app.db.getRepository('roles').create({ values: { name: 'guardian-manager', title: 'Manager' } });
    const readerUser = await app.db.getRepository('users').create({
      values: { username: 'guardian-reader', roles: ['guardian-reader'] },
    });
    const managerUser = await app.db.getRepository('users').create({
      values: { username: 'guardian-manager', roles: ['guardian-manager'] },
    });
    app.acl.define({ role: 'guardian-reader' }).snippets.add('pm.plugin-startup-guardian.read');
    const managerRole = app.acl.define({ role: 'guardian-manager' });
    managerRole.snippets.add('pm.plugin-startup-guardian.read');
    managerRole.snippets.add('pm.plugin-startup-guardian.manage');
    reader = await app.agent().login(readerUser, 'guardian-reader');
    manager = await app.agent().login(managerUser, 'guardian-manager');
  }, 120000);

  afterAll(async () => {
    await app?.destroy();
    if (originalStateDirectory === undefined) delete process.env.STARTUP_GUARDIAN_STATE_DIR;
    else process.env.STARTUP_GUARDIAN_STATE_DIR = originalStateDirectory;
    if (originalAppId === undefined) delete process.env.STARTUP_GUARDIAN_APP_ID;
    else process.env.STARTUP_GUARDIAN_APP_ID = originalAppId;
    if (originalDialect === undefined) delete process.env.DB_DIALECT;
    else process.env.DB_DIALECT = originalDialect;
    if (stateDirectory) rmSync(stateDirectory, { recursive: true, force: true });
  });

  it('enforces read and manage snippets on the real HTTP resource', async () => {
    expect(app.acl.snippetManager.snippets.has('pm.plugin-startup-guardian.read')).toBe(true);
    expect(app.acl.snippetManager.snippets.has('pm.plugin-startup-guardian.manage')).toBe(true);

    const anonymous = app.agent();
    const anonymousStatus = await anonymous.resource('startupGuardian').status();
    const readerStatus = await reader.resource('startupGuardian').status();
    const managerStatus = await manager.resource('startupGuardian').status();
    expect([401, 403]).toContain(anonymousStatus.status);
    expect(readerStatus.status).toBe(200);
    expect(managerStatus.status).toBe(200);
    expect(readerStatus.body.data.mode).toBe('observe-only');

    const beforePolicy = await manager.resource('startupGuardian').status();
    const deniedApprove = await reader.resource('startupGuardian').approve({
      values: {
        packageName: 'plugin-example',
        pluginName: 'example',
        pluginVersion: '1.0.0',
        phase: 'load',
        fingerprint: 'a'.repeat(64),
      },
    });
    const deniedAuto = await reader.resource('startupGuardian').setAutoRecovery({ values: { enabled: true } });
    const deniedRetry = await reader.resource('startupGuardian').retry({
      values: { packageName: 'plugin-example', expectedRevision: 1 },
    });
    expect(deniedApprove.status).toBe(403);
    expect(deniedAuto.status).toBe(403);
    expect(deniedRetry.status).toBe(403);

    const afterPolicy = await manager.resource('startupGuardian').status();
    expect(afterPolicy.body.data.policy).toEqual(beforePolicy.body.data.policy);
    expect(existsSync(join(stateDirectory, 'audit'))).toBe(false);

    const allowedAuto = await manager.resource('startupGuardian').setAutoRecovery({ values: { enabled: true } });
    expect(allowedAuto.status).toBe(200);
    expect(allowedAuto.body.data.policy.autoRecoveryEnabled).toBe(true);
  });
});
