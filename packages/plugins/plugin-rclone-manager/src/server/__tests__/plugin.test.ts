// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RCLONE_SNIPPETS, RCLONE_TRANSFER_INSTRUCTION_TYPE, RESOURCE_NAME, SECRET_MASK } from '../../shared/constants';
import PluginRcloneManagerServer from '../plugin';

type PluginApp = ConstructorParameters<typeof PluginRcloneManagerServer>[0];

describe('PluginRcloneManagerServer', () => {
  it('registers collections, log redaction, resource guard, ACL snippets, and workflow instruction', async () => {
    const appMiddlewares: Array<(ctx: Record<string, unknown>, next: () => Promise<void>) => Promise<void>> = [];
    const registerSnippet = vi.fn();
    const allow = vi.fn();
    const defineResource = vi.fn();
    const useResourceMiddleware = vi.fn();
    const registerInstruction = vi.fn();
    const dbImport = vi.fn().mockResolvedValue(undefined);

    const app = {
      db: { import: dbImport },
      use: vi.fn((fn) => appMiddlewares.push(fn)),
      resourceManager: {
        use: useResourceMiddleware,
        define: defineResource,
      },
      acl: {
        registerSnippet,
        allow,
      },
      pm: {
        get: vi.fn((name: string) => (name === 'workflow' ? { registerInstruction } : undefined)),
      },
      on: vi.fn(),
      off: vi.fn(),
    };

    const plugin = new PluginRcloneManagerServer(app as unknown as PluginApp, {});
    await plugin.load();

    expect(dbImport).toHaveBeenCalledTimes(1);
    expect(useResourceMiddleware).toHaveBeenCalledTimes(1);
    expect(defineResource).toHaveBeenCalledWith(expect.objectContaining({ name: RESOURCE_NAME }));

    const snippetNames = registerSnippet.mock.calls.map(([arg]: [{ name: string }]) => arg.name);
    expect(snippetNames).toEqual(Object.values(RCLONE_SNIPPETS));
    expect(allow).toHaveBeenCalledWith(RESOURCE_NAME, 'myPermissions', 'loggedIn');
    expect(allow).toHaveBeenCalledWith(RESOURCE_NAME, 'downloadStream', 'public');
    expect(registerInstruction).toHaveBeenCalledWith(RCLONE_TRANSFER_INSTRUCTION_TYPE, expect.any(Function));

    // Verify log redaction middleware scrubs password, raw rclone.conf, and nested values.parameters secrets
    const redactMiddleware = appMiddlewares[0];
    const body = {
      password: 'super-secret-password',
      content: '[s3]\nsecret_access_key = abc',
      values: {
        parameters: {
          provider: 'Minio',
          access_key_id: 'AKIA-SECRET',
          secret_access_key: 'TOP-SECRET-KEY',
          token: '{"access_token":"oauth-secret"}',
          pass: 'sftp-pass',
          password2: 'crypt-salt-secret',
        },
      },
    };
    const ctx = {
      action: {
        resourceName: RESOURCE_NAME,
        params: {
          values: {
            password: 'super-secret-password',
            parameters: {
              provider: 'Minio',
              secret_access_key: 'TOP-SECRET-KEY',
              password2: 'crypt-salt-secret',
            },
          },
        },
      },
      request: { body },
    };

    await redactMiddleware(ctx, async () => {});
    expect(body.password).toBe(SECRET_MASK);
    expect(body.content).toBe(SECRET_MASK);
    expect(body.values.parameters.provider).toBe('Minio');
    expect(body.values.parameters.access_key_id).toBe(SECRET_MASK);
    expect(body.values.parameters.secret_access_key).toBe(SECRET_MASK);
    expect(body.values.parameters.token).toBe(SECRET_MASK);
    expect(body.values.parameters.pass).toBe(SECRET_MASK);
    expect(body.values.parameters.password2).toBe(SECRET_MASK);
    expect(ctx.action.params.values.password).toBe(SECRET_MASK);
    expect(ctx.action.params.values.parameters.secret_access_key).toBe(SECRET_MASK);
    expect(ctx.action.params.values.parameters.password2).toBe(SECRET_MASK);
    expect(ctx.action.params.values.parameters.provider).toBe('Minio');
  });

  it('keeps client v1 bundle free of client-v2 imports when built', () => {
    const v1BundlePath = path.resolve(__dirname, '../../../dist/client/index.js');
    if (fs.existsSync(v1BundlePath)) {
      const bundle = fs.readFileSync(v1BundlePath, 'utf8');
      expect(bundle).not.toContain('plugin-workflow/client-v2');
      expect(bundle).not.toContain('"@nocobase/client-v2"');
    }
  });
});
