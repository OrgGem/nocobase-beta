/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/server';
import type { Application } from '@nocobase/server';
import { randomUUID } from 'node:crypto';
import { getStateDirectory, readIncidents, readState } from './journal';
import { wrapPluginLifecycles } from './lifecycle';
import {
  addApprovedRule,
  approveIncidentInPolicy,
  isValidApprovalInput,
  readPolicy,
  requestRetry,
  setAutoRecoveryInPolicy,
  setAutoRecoveryEnabled,
} from './policy';
import { writeJsonFileAtomic } from './storage';
import type { StartupIncident } from './contracts';
import path from 'node:path';
import { isClusterModeEnabled, readClusterModeConfig } from './cluster-mode';
import { createClusterReadinessMiddleware } from './cluster-readiness';
import { StartupGuardianDatabase } from './database-adapter';

interface GuardianActionContext {
  action: { params: { values?: Record<string, unknown>; expectedRevision?: unknown; packageName?: unknown } };
  state: { currentUser?: { id?: unknown; username?: unknown } };
  body?: unknown;
  throw(status: number, message: string): never;
}

const instrumentedApps = new WeakSet<Application>();
const wrappedStarts = new WeakSet<Application>();

function getBootId(): string {
  return process.env.STARTUP_GUARDIAN_BOOT_ID || randomUUID();
}

function getDeploymentId(): string {
  return process.env.STARTUP_GUARDIAN_DEPLOYMENT_ID || 'single-node';
}

function currentActor(ctx: GuardianActionContext): string {
  const user = ctx.state.currentUser;
  return String(user?.username || user?.id || 'admin').slice(0, 120);
}

function sendProcessMessage(message: Record<string, unknown>): Promise<void> {
  if (typeof process.send !== 'function') return Promise.resolve();
  return new Promise((resolve, reject) => {
    process.send?.(message, (error) => (error ? reject(error) : resolve()));
  });
}

async function appendAudit(
  app: Application,
  input: { actor: string; action: string; result: 'accepted' | 'rejected'; detail?: string },
): Promise<void> {
  const baseDirectory = getStateDirectory(app.name);
  const auditDirectory = `${baseDirectory}/audit`;
  await writeJsonFileAtomic(`${auditDirectory}/${randomUUID()}.json`, {
    schemaVersion: 1,
    appId: app.name,
    deploymentId: getDeploymentId(),
    timestamp: new Date().toISOString(),
    actor: input.actor,
    action: input.action,
    result: input.result,
    detail: input.detail,
  });
}

function getValues(ctx: GuardianActionContext): Record<string, unknown> {
  return ctx.action.params.values || {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export class PluginStartupGuardianServer extends Plugin {
  async afterAdd() {
    this.registerResource();
    this.registerPermissions();
    this.installLifecycleHooks(this.app);
    if (isClusterModeEnabled()) {
      const config = readClusterModeConfig();
      if (!config) throw new Error('Startup Guardian cluster mode is enabled but its configuration is unavailable');
      this.app.use(createClusterReadinessMiddleware(this.db, config), {
        before: 'resourcer',
        tag: 'startupGuardianClusterReadiness',
      });
    }
  }

  async load() {}

  async beforeLoad() {
    await this.db.import({ directory: path.resolve(__dirname, 'collections') });
  }

  private installLifecycleHooks(app: Application): void {
    let stateDirectory: string;
    try {
      stateDirectory = getStateDirectory(app.name);
    } catch (error) {
      app.log.error('Startup Guardian is not active for an unsupported application identity', error);
      return;
    }
    if (!wrappedStarts.has(app)) {
      const originalStart = app.start;
      Object.defineProperty(app, 'start', {
        configurable: true,
        writable: true,
        value: async function (this: Application, ...args: Parameters<typeof originalStart>) {
          const result = await Reflect.apply(originalStart, this, args);
          try {
            await sendProcessMessage({ type: 'startup-guardian-ready', appId: app.name, bootId: getBootId() });
          } catch (error) {
            app.log.error('Startup Guardian could not send a readiness signal to its runner', error);
          }
          return result;
        },
      });
      wrappedStarts.add(app);
    }

    if (!instrumentedApps.has(app)) {
      app.on('beforeLoad', async () => {
        for (const plugin of app.pm.getPlugins().values()) {
          await wrapPluginLifecycles(
            plugin,
            {
              app,
              bootId: getBootId(),
              deploymentId: getDeploymentId(),
              stateDirectory,
            },
            async (incident) => {
              await sendProcessMessage({ type: 'startup-guardian-incident', incident });
            },
          );
        }
      });
      instrumentedApps.add(app);
    }
  }

  private registerResource(): void {
    this.app.resourceManager.define({
      name: 'startupGuardian',
      actions: {
        status: async (ctx: GuardianActionContext, next: () => Promise<void>) => {
          const stateDirectory = getStateDirectory(this.app.name);
          if (isClusterModeEnabled()) {
            const config = readClusterModeConfig();
            if (!config) ctx.throw(503, 'HA status is unavailable because the cluster identity is invalid');
            const database = await StartupGuardianDatabase.connectFromEnvironment();
            try {
              const [control, members] = await Promise.all([
                database.readClusterControl(config.appId, config.deploymentId),
                database.readClusterMembers(config.appId, config.deploymentId),
              ]);
              if (!control) ctx.throw(503, 'HA cluster enrollment is missing for this app and deployment');
              ctx.body = {
                state: (await readState(stateDirectory)) || null,
                policy: control.policy,
                autoRecoverySupported: true,
                policyMutationSupported: true,
                retrySupported: false,
                mode: 'redis-postgres-app-only-ha',
                cluster: {
                  phase: control.phase,
                  decisionRevision: control.decisionRevision,
                  policyRevision: control.policyRevision,
                  expectedMembers: control.expectedMembers,
                  members,
                },
              };
            } finally {
              await database.close();
            }
            await next();
            return;
          }
          ctx.body = {
            state: (await readState(stateDirectory)) || null,
            policy: await readPolicy(stateDirectory),
            autoRecoverySupported: process.env.DB_DIALECT === 'postgres',
            policyMutationSupported: true,
            retrySupported: true,
            mode: process.env.DB_DIALECT === 'postgres' ? 'single-node-postgres' : 'observe-only',
          };
          await next();
        },
        inspect: async (ctx: GuardianActionContext, next: () => Promise<void>) => {
          const stateDirectory = getStateDirectory(this.app.name);
          if (isClusterModeEnabled()) {
            const config = readClusterModeConfig();
            if (!config) ctx.throw(503, 'HA status is unavailable because the cluster identity is invalid');
            const database = await StartupGuardianDatabase.connectFromEnvironment();
            try {
              const [control, members] = await Promise.all([
                database.readClusterControl(config.appId, config.deploymentId),
                database.readClusterMembers(config.appId, config.deploymentId),
              ]);
              if (!control) ctx.throw(503, 'HA cluster enrollment is missing for this app and deployment');
              ctx.body = {
                incidents: control.incident ? [control.incident] : [],
                state: (await readState(stateDirectory)) || null,
                cluster: { control, members },
              };
            } finally {
              await database.close();
            }
            await next();
            return;
          }
          const incidents = await readIncidents(stateDirectory);
          ctx.body = {
            incidents: incidents.slice(-100).reverse(),
            state: (await readState(stateDirectory)) || null,
          };
          await next();
        },
        approve: async (ctx: GuardianActionContext, next: () => Promise<void>) => {
          const actor = currentActor(ctx);
          const values = getValues(ctx);
          const input = {
            packageName: stringValue(values.packageName) || '',
            pluginName: stringValue(values.pluginName) || '',
            pluginVersion: stringValue(values.pluginVersion) || '',
            phase: stringValue(values.phase) || '',
            fingerprint: stringValue(values.fingerprint) || '',
          };
          if (!isValidApprovalInput(input)) ctx.throw(400, 'Invalid exact approval rule');
          const stateDirectory = getStateDirectory(this.app.name);
          if (isClusterModeEnabled()) {
            const config = readClusterModeConfig();
            if (!config) ctx.throw(503, 'HA policy is unavailable because the cluster identity is invalid');
            const expectedPolicyRevision = numberValue(values.expectedPolicyRevision);
            if (expectedPolicyRevision === null)
              ctx.throw(400, 'expectedPolicyRevision is required for HA policy changes');
            const database = await StartupGuardianDatabase.connectFromEnvironment();
            try {
              const control = await database.readClusterControl(config.appId, config.deploymentId);
              const incident = control?.incident;
              if (!control || !incident) ctx.throw(409, 'No current shared HA incident is available to approve');
              if (expectedPolicyRevision !== control.policyRevision) {
                ctx.throw(409, 'HA policy revision changed; refresh shared status before approving');
              }
              if (
                incident.pluginName !== input.pluginName ||
                incident.packageName !== input.packageName ||
                incident.pluginVersion !== input.pluginVersion ||
                incident.phase !== input.phase ||
                incident.fingerprint !== input.fingerprint
              ) {
                ctx.throw(409, 'Approval must match the current shared HA incident exactly');
              }
              let policy = control.policy;
              try {
                policy = approveIncidentInPolicy(control.policy, incident, actor);
              } catch (error) {
                ctx.throw(400, error instanceof Error ? error.message : 'Approval failed');
              }
              if (policy !== control.policy) {
                const updated = await database.updateClusterPolicy({
                  appId: config.appId,
                  deploymentId: config.deploymentId,
                  expectedPolicyRevision,
                  policy,
                });
                policy = updated.policy;
              }
              await appendAudit(this.app, {
                actor,
                action: 'approve-exact-ha-incident',
                result: 'accepted',
                detail: incident.packageName,
              });
              ctx.body = { policy, policyRevision: policy.revision };
            } finally {
              await database.close();
            }
            await next();
            return;
          }
          const incidents = await readIncidents(stateDirectory);
          const incident = incidents.find(
            (entry) =>
              entry.pluginName === input.pluginName &&
              entry.packageName === input.packageName &&
              entry.pluginVersion === input.pluginVersion &&
              entry.phase === input.phase &&
              entry.fingerprint === input.fingerprint,
          );
          if (!incident) ctx.throw(409, 'Approval must match an observed incident');
          try {
            const policy = await addApprovedRule(incident, actor, stateDirectory);
            await appendAudit(this.app, {
              actor,
              action: 'approve-exact-incident',
              result: 'accepted',
              detail: incident.packageName,
            });
            ctx.body = { policy };
          } catch (error) {
            await appendAudit(this.app, {
              actor,
              action: 'approve-exact-incident',
              result: 'rejected',
              detail: 'protected-or-invalid',
            });
            ctx.throw(400, error instanceof Error ? error.message : 'Approval failed');
          }
          await next();
        },
        setAutoRecovery: async (ctx: GuardianActionContext, next: () => Promise<void>) => {
          const values = getValues(ctx);
          if (typeof values.enabled !== 'boolean') ctx.throw(400, 'enabled must be a boolean');
          const actor = currentActor(ctx);
          if (isClusterModeEnabled()) {
            const config = readClusterModeConfig();
            if (!config) ctx.throw(503, 'HA policy is unavailable because the cluster identity is invalid');
            const expectedPolicyRevision = numberValue(values.expectedPolicyRevision);
            if (expectedPolicyRevision === null)
              ctx.throw(400, 'expectedPolicyRevision is required for HA policy changes');
            const database = await StartupGuardianDatabase.connectFromEnvironment();
            try {
              const control = await database.readClusterControl(config.appId, config.deploymentId);
              if (!control) ctx.throw(409, 'HA cluster enrollment is missing');
              if (expectedPolicyRevision !== control.policyRevision) {
                ctx.throw(409, 'HA policy revision changed; refresh shared status before changing automatic recovery');
              }
              const policy = setAutoRecoveryInPolicy(control.policy, values.enabled);
              if (policy === control.policy) {
                ctx.body = { policy, policyRevision: control.policyRevision, unchanged: true };
              } else {
                const updated = await database.updateClusterPolicy({
                  appId: config.appId,
                  deploymentId: config.deploymentId,
                  expectedPolicyRevision,
                  policy,
                });
                await appendAudit(this.app, {
                  actor,
                  action: values.enabled ? 'enable-ha-auto-recovery' : 'disable-ha-auto-recovery',
                  result: 'accepted',
                });
                ctx.body = { policy: updated.policy, policyRevision: updated.policyRevision };
              }
            } finally {
              await database.close();
            }
            await next();
            return;
          }
          const policy = await setAutoRecoveryEnabled(values.enabled, getStateDirectory(this.app.name));
          await appendAudit(this.app, {
            actor,
            action: values.enabled ? 'enable-auto-recovery' : 'disable-auto-recovery',
            result: 'accepted',
          });
          ctx.body = { policy };
          await next();
        },
        retry: async (ctx: GuardianActionContext, next: () => Promise<void>) => {
          const actor = currentActor(ctx);
          if (isClusterModeEnabled()) {
            ctx.throw(
              409,
              'Shared HA retry is not supported. The plugin remains quarantined; use the documented whole-cohort maintenance procedure before manually changing applicationPlugins.',
            );
          }
          const packageName = stringValue(ctx.action.params.packageName) || stringValue(getValues(ctx).packageName);
          const expectedRevision = ctx.action.params.expectedRevision ?? getValues(ctx).expectedRevision;
          if (!packageName || typeof expectedRevision !== 'number')
            ctx.throw(400, 'Retry requires packageName and expectedRevision');
          try {
            const request = await requestRetry(
              { packageName, expectedRevision, requestedBy: actor },
              getStateDirectory(this.app.name),
            );
            await appendAudit(this.app, { actor, action: 'request-retry', result: 'accepted', detail: packageName });
            ctx.body = { accepted: true, requestId: request.requestId, state: 'retry-pending' };
          } catch (error) {
            await appendAudit(this.app, { actor, action: 'request-retry', result: 'rejected', detail: packageName });
            ctx.throw(409, error instanceof Error ? error.message : 'Retry request rejected');
          }
          await next();
        },
      },
    });
  }

  private registerPermissions(): void {
    this.app.acl.registerSnippet({
      name: 'pm.plugin-startup-guardian.read',
      actions: ['startupGuardian:status', 'startupGuardian:inspect'],
    });
    this.app.acl.registerSnippet({
      name: 'pm.plugin-startup-guardian.manage',
      actions: ['startupGuardian:approve', 'startupGuardian:setAutoRecovery', 'startupGuardian:retry'],
    });
  }
}

export default PluginStartupGuardianServer;
