// SPDX-License-Identifier: Apache-2.0

import { resolve } from 'node:path';
import type WorkflowPlugin from '@nocobase/plugin-workflow';
import { Plugin } from '@nocobase/server';
import { RCLONE_TRANSFER_INSTRUCTION_TYPE, RESOURCE_NAME, SECRET_MASK } from '../shared/constants';
import { createRcloneManagerActions } from './actions/rclone-manager';
import { createRcloneResourceGuardMiddleware } from './middlewares/request-method-policy';
import { RCLONE_SNIPPET_ACTION_MAP } from './permissions';
import { RcloneConnectionManager } from './services/connection-manager';
import { isSensitiveRemoteField } from './utils/secret-redactor';
import { ensureDefaultExplorerWorkflow } from './workflow/default-workflow';
import { RcloneJobReconciler } from './workflow/RcloneJobReconciler';
import { RcloneTransferInstruction } from './workflow/RcloneTransferInstruction';

const REDACTED_BODY_FIELDS = new Set(['password', 'pass', 'content']);

export class PluginRcloneManagerServer extends Plugin {
  readonly connectionManager = new RcloneConnectionManager(this.app);
  readonly reconciler = new RcloneJobReconciler(this.app, this.connectionManager);

  private readonly onAppStart = async () => {
    await ensureDefaultExplorerWorkflow(this.app).catch((error) => {
      this.app.logger?.warn?.(`[plugin-rclone-manager] Default workflow check skipped: ${String(error)}`);
    });
    this.reconciler.start();
  };

  private readonly onAppStop = () => {
    this.reconciler.stop();
    this.connectionManager.clear();
  };

  async load() {
    await this.db.import({ directory: resolve(__dirname, 'collections') });

    // Redact passwords and raw rclone.conf contents from request logs
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
                if (key === 'values' || key === 'parameters') {
                  redactObj(value);
                  continue;
                }
                if (
                  value !== undefined &&
                  value !== null &&
                  value !== '' &&
                  (REDACTED_BODY_FIELDS.has(key.toLowerCase()) || isSensitiveRemoteField(key))
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
      { tag: 'rclone-manager-log-redaction', after: 'logger', before: 'dataSource' },
    );

    this.app.resourceManager.use(createRcloneResourceGuardMiddleware(), {
      tag: 'rclone-manager-resource-guard',
      after: 'acl',
    });

    this.app.resourceManager.define({
      name: RESOURCE_NAME,
      actions: createRcloneManagerActions(this),
    });

    for (const snippet of RCLONE_SNIPPET_ACTION_MAP) {
      this.app.acl.registerSnippet(snippet);
    }

    // Logged-in users can always query their resolved permission booleans; signed URLs verify HMAC internally
    this.app.acl.allow(RESOURCE_NAME, 'myPermissions', 'loggedIn');
    this.app.acl.allow(RESOURCE_NAME, 'downloadStream', 'public');

    const workflowPlugin = this.app.pm.get('workflow') as WorkflowPlugin | undefined;
    if (workflowPlugin) {
      workflowPlugin.registerInstruction(RCLONE_TRANSFER_INSTRUCTION_TYPE, RcloneTransferInstruction);
    }

    this.app.on('afterStart', this.onAppStart);
    this.app.on('beforeStop', this.onAppStop);
  }

  async install() {
    await ensureDefaultExplorerWorkflow(this.app).catch(() => {});
  }

  async afterEnable() {
    await ensureDefaultExplorerWorkflow(this.app).catch(() => {});
    this.reconciler.start();
  }

  async afterDisable() {
    this.onAppStop();
  }

  async remove() {
    this.onAppStop();
    this.app.off('afterStart', this.onAppStart);
    this.app.off('beforeStop', this.onAppStop);
  }
}

export default PluginRcloneManagerServer;
