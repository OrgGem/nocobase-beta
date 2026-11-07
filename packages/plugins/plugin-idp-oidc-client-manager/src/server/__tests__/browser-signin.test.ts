/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rmdir, unlink } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { Agent } from 'undici';
import { expect, it, vi } from 'vitest';
import { createMockServer, type MockServer } from '@nocobase/test';
import type { AuthModel } from '@nocobase/plugin-auth';
import PluginIdpOauthServer from '../../../../@nocobase/plugin-idp-oauth/src/server/plugin';
import PluginOIDCServer from '../../../../plugin-oidc-auth/src/server/plugin';
import { authType } from '../../../../plugin-oidc-auth/src/constants';
import PluginIdpOidcClientManagerServer from '../plugin';
import { normalizeClientInput } from '../client-service';

// Opt-in because this test needs a browser, OpenSSL, and the normal NocoBase test database.
it.runIf(process.env.OIDC_BROWSER_E2E === '1')(
  'completes public-client sign-in in a browser through the real NocoBase handlers',
  async () => {
    let app: MockServer | undefined;
    let server: Server | undefined;
    let browser: Browser | undefined;
    const directory = await mkdtemp(join(tmpdir(), 'nocobase-oidc-browser-'));
    const keyPath = join(directory, 'key.pem');
    const certPath = join(directory, 'cert.pem');
    const tlsAgent = new Agent({ connect: { rejectUnauthorized: false } });
    try {
      execFileSync(
        process.env.OIDC_TEST_OPENSSL || 'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=IP:127.0.0.1,DNS:localhost',
          '-keyout',
          keyPath,
          '-out',
          certPath,
        ],
        { stdio: 'ignore' },
      );
      app = await createMockServer({
        registerActions: true,
        acl: true,
        resourcer: { prefix: '/api' },
        logger: { system: { level: 'error' }, request: { level: 'error' } },
        plugins: [
          'acl',
          'error-handler',
          'field-sort',
          'users',
          'ui-schema-storage',
          'data-source-main',
          'auth',
          'data-source-manager',
          'collection-tree',
          'system-settings',
          [PluginIdpOauthServer, { name: 'idp-oauth', packageName: '@nocobase/plugin-idp-oauth' }],
          [
            PluginIdpOidcClientManagerServer,
            { name: 'plugin-idp-oidc-client-manager', packageName: 'plugin-idp-oidc-client-manager' },
          ],
          [PluginOIDCServer, { name: 'plugin-oidc-auth', packageName: 'plugin-oidc-auth' }],
        ],
      });
      // Minimal test pages drive the real sign-in, interaction, consent, and callback endpoints.
      app.use(
        async (ctx, next) => {
          let html: string | undefined;
          if (ctx.path === '/oidc-browser-start') {
            html = `<button id="start">Sign in</button><script>
          document.getElementById('start').onclick = async function start() {
            const login = await fetch('/api/auth:signIn', {method:'POST', headers:{'Content-Type':'application/json','X-Authenticator':'basic'}, body:JSON.stringify({account:'browser-test',password:'test-only-password'})});
            const signed = (await login.json()).data;
            localStorage.setItem('op-token', signed.token);
            const response = await fetch('/api/oidc:getAuthUrl', {method:'POST', headers:{'Content-Type':'application/json','X-Authenticator':'browser-oidc'}, body:JSON.stringify({redirect:'/oidc-browser-done'})});
            location.assign((await response.json()).data);
          };
        </script>`;
          } else if (ctx.path.startsWith('/idp-oauth/interaction/')) {
            html = `<button id="approve" hidden>Approve</button><script>
          const endpoint='/api/idpOAuth/interaction/'+encodeURIComponent(location.pathname.split('/').pop());
          const headers={'Content-Type':'application/json','X-Authenticator':'basic',Authorization:'Bearer '+localStorage.getItem('op-token')};
          async function interaction(method) {
            const response=await fetch(endpoint,{method,headers,...(method==='POST'?{body:'{}'}:{})});
            const result=await response.json();
            if(result.redirectTo) location.assign(result.redirectTo);
            else if(result.prompt==='consent') document.getElementById('approve').hidden=false;
          }
          document.getElementById('approve').onclick=()=>interaction('POST');
          interaction('GET');
        </script>`;
          } else if (ctx.path === '/oidc-browser-done') {
            html = `<output id="result" role="status">Checking session</output><script>
          const token=new URL(location.href).searchParams.get('token');
          history.replaceState(null,'',location.pathname);
          async function checkSession() {
            const response=await fetch('/api/auth:check',{headers:{Authorization:'Bearer '+token,'X-Authenticator':'browser-oidc'}});
            const user=(await response.json()).data;
            if(response.ok && user.id) {
              document.getElementById('result').textContent='Signed in';
              document.getElementById('result').dataset.userId=String(user.id);
            }
          }
          checkSession();
        </script>`;
          }
          if (!html) return next();
          ctx.withoutDataWrapping = true;
          ctx.type = 'html';
          ctx.body = html;
        },
        { tag: 'oidc-browser-test-pages', before: 'dataSource' },
      );
      server = createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, app.callback());
      await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert(address && typeof address !== 'string');
      const origin = `https://127.0.0.1:${address.port}`;
      const issuer = `${origin}/api`;
      const realFetch = globalThis.fetch;
      vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.origin !== origin) throw new Error('Unexpected browser-test fetch origin');
        const options: RequestInit & { dispatcher: Agent } = { ...init, dispatcher: tlsAgent };
        return realFetch(input, options);
      });
      const user = await app.db.getRepository('users').create({
        values: {
          username: 'browser-test',
          email: 'unverified@example.test',
          password: 'test-only-password',
          roles: ['member'],
        },
      });
      await app.db.getRepository('oidcClients').create({
        values: normalizeClientInput({
          name: 'Browser test',
          clientId: 'browser-client',
          clientType: 'public',
          redirectUris: [`${origin}/api/oidc:redirect`],
          scopes: ['openid', 'profile', 'email'],
        }),
      });
      const authenticator = (await app.db.getRepository('authenticators').create({
        values: {
          name: 'browser-oidc',
          authType,
          enabled: true,
          options: {
            public: { autoSignup: false },
            oidc: {
              providerProfile: 'nocobase',
              issuer,
              clientId: 'browser-client',
              tokenEndpointAuthMethod: 'none',
              redirectUri: `${origin}/api/oidc:redirect`,
            },
          },
        },
      })) as AuthModel;
      await authenticator.addUser(user.id, { through: { uuid: `${issuer}|${user.id}` } });
      browser = await chromium.launch({
        headless: true,
        channel: process.env.OIDC_TEST_BROWSER_CHANNEL || undefined,
        executablePath: process.env.OIDC_TEST_BROWSER_EXECUTABLE || undefined,
      });
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      await page.goto(`${origin}/oidc-browser-start`);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      try {
        await page.getByRole('button', { name: 'Approve', exact: true }).click({ timeout: 20000 });
        await page.waitForSelector('#result[data-user-id]', { timeout: 20000 });
      } catch {
        const location = new URL(page.url());
        throw new Error(
          `Browser sign-in stopped at ${location.pathname}: ${location.searchParams.get('error') || 'no result'}`,
        );
      }
      expect(await page.locator('#result').getAttribute('data-user-id')).toBe(String(user.id));
    } finally {
      await browser?.close();
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server?.close(() => resolve()));
      }
      await app?.destroy();
      vi.unstubAllGlobals();
      await tlsAgent.close();
      await Promise.allSettled([unlink(keyPath), unlink(certPath)]);
      await rmdir(directory);
    }
  },
);
