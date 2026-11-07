/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Plugin } from '@nocobase/server';
import type { Application } from '@nocobase/server';
import { LIFECYCLE_PHASES, type LifecyclePhase, type StartupIncident } from './contracts';
import { getStateDirectory, writeIncident } from './journal';
import { createFingerprint, errorSummary, randomId } from './security';

const wrappedPlugins = new WeakSet<Plugin>();

export interface LifecycleFailureContext {
  app: Application;
  bootId: string;
  deploymentId: string;
  stateDirectory?: string;
}

export async function wrapPluginLifecycles(
  plugin: Plugin,
  context: LifecycleFailureContext,
  onIncident?: (incident: StartupIncident) => Promise<void> | void,
): Promise<void> {
  const options = plugin.options as { packageName?: unknown; version?: unknown; isPreset?: unknown } | undefined;
  if (
    wrappedPlugins.has(plugin) ||
    plugin === context.app.pm.get('plugin-startup-guardian') ||
    options?.isPreset === true ||
    typeof options?.packageName !== 'string' ||
    options.packageName.length === 0
  ) {
    return;
  }

  const packageName = options.packageName;
  const pluginVersion = typeof options.version === 'string' ? options.version : 'unknown';
  const pluginName = plugin.name || packageName;
  for (const phase of LIFECYCLE_PHASES) {
    const original = plugin[phase];
    if (typeof original !== 'function') continue;
    const wrapped = async function (this: Plugin, ...args: unknown[]) {
      try {
        return await Reflect.apply(original, this, args as never[]);
      } catch (error) {
        const summary = errorSummary(error);
        const fingerprint = createFingerprint({
          pluginName,
          packageName,
          pluginVersion,
          phase,
          errorName: summary.name,
          errorMessage: summary.message,
        });
        const incident: StartupIncident = {
          schemaVersion: 1,
          eventId: randomId(),
          eventType: 'lifecycle-failure',
          appId: context.app.name,
          deploymentId: context.deploymentId,
          bootId: context.bootId,
          timestamp: new Date().toISOString(),
          pluginName,
          packageName,
          pluginVersion,
          phase,
          errorName: summary.name,
          errorMessage: summary.message,
          fingerprint,
        };

        let persisted = false;
        try {
          await writeIncident(incident, context.stateDirectory || getStateDirectory(context.app.name));
          persisted = true;
        } catch (journalError) {
          context.app.log.error('Startup Guardian could not persist a lifecycle incident', journalError);
        }
        if (persisted) {
          try {
            await onIncident?.(incident);
          } catch (channelError) {
            context.app.log.error('Startup Guardian could not send a lifecycle incident to its runner', channelError);
          }
        }
        throw error;
      }
    };
    Object.defineProperty(plugin, phase, { configurable: true, writable: true, value: wrapped });
  }
  wrappedPlugins.add(plugin);
}
