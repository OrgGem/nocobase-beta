// SPDX-License-Identifier: Apache-2.0

import { resolve } from 'node:path';
import { Plugin } from '@nocobase/server';
import { RESOURCE_NAME, SECRET_MASK } from '../shared/constants';
import { createHaproxyDataplaneActions } from './actions/haproxy-dataplane';
import { createHaproxyResourceGuardMiddleware } from './middlewares/resource-guard';
import { HAPROXY_SNIPPET_ACTION_MAP } from './permissions';
import { HaproxyConnectionManager } from './services/connection-manager';
import { HaproxyReverseProxyService } from './services/reverse-proxy-service';
import { HaproxyRevisionAuditService } from './services/revision-audit-service';

const REDACTED_BODY_FIELDS = new Set(['password', 'pemcontent', 'content']);

export class PluginHaproxyDataplaneServer extends Plugin {
  readonly connectionManager = new HaproxyConnectionManager(this.app);
  readonly revisionAudit = new HaproxyRevisionAuditService(this.app, this.connectionManager);
  readonly reverseProxy = new HaproxyReverseProxyService(this.connectionManager);

  private readonly onAppStop = () => {
    this.connectionManager.clear();
  };

  async load() {
    await this.db.import({ directory: resolve(__dirname, 'collections') });

    // Scrub connection passwords, TLS private keys (pemContent), and raw config contents from request logs.
    this.app.use(
      async (ctx, next) => {
        try {
          await next();
        } finally {
          if (ctx.action?.resourceName === RESOURCE_NAME) {
            const redactObj = (target: unknown) => {
              if (!target || typeof target !== 'object' || Array.isArray(target)) return;
              const rec = target as Record<string, unknown>;
              for (const [key, value] of Object.entries(rec)) {
                if (key === 'values') {
                  redactObj(value);
                  continue;
                }
                if (
                  value !== undefined &&
                  value !== null &&
                  value !== '' &&
                  REDACTED_BODY_FIELDS.has(key.toLowerCase())
                ) {
                  rec[key] = SECRET_MASK;
                }
              }
            };
            redactObj(ctx.action.params);
            redactObj(ctx.request?.body);
          }
        }
      },
      { tag: 'haproxy-dataplane-log-redaction', after: 'logger', before: 'dataSource' },
    );

    this.app.resourceManager.use(createHaproxyResourceGuardMiddleware(), {
      tag: 'haproxy-dataplane-resource-guard',
      after: 'acl',
    });

    this.app.resourceManager.define({
      name: RESOURCE_NAME,
      actions: createHaproxyDataplaneActions(this),
    });

    for (const snippet of HAPROXY_SNIPPET_ACTION_MAP) {
      this.app.acl.registerSnippet(snippet);
    }

    this.app.acl.allow(RESOURCE_NAME, 'myPermissions', 'loggedIn');
    this.app.on('beforeStop', this.onAppStop);
  }

  async afterDisable() {
    this.onAppStop();
  }

  async remove() {
    this.onAppStop();
    this.app.off('beforeStop', this.onAppStop);
  }
}

export default PluginHaproxyDataplaneServer;
