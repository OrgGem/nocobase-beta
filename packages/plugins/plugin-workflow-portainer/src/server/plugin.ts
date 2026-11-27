/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { resolve } from 'node:path';
import type { Context } from '@nocobase/actions';
import type { Model } from '@nocobase/database';
import type WorkflowPlugin from '@nocobase/plugin-workflow';
import { Plugin } from '@nocobase/server';
import {
  INSTRUCTION_TYPES,
  PORTAINER_ACL_SNIPPET,
  PORTAINER_INSTANCES_COLLECTION,
  PORTAINER_RESOURCE,
  SECRET_MASK,
} from '../shared/constants';
import { createPortainerResourceActions } from './actions/portainer';
import { PortainerStackControlInstruction } from './instructions/PortainerStackControlInstruction';
import { PortainerStackRedeployInstruction } from './instructions/PortainerStackRedeployInstruction';
import { assertValidPortainerUrl, clampTimeoutMs } from './services/PortainerClient';

const ENCRYPTED_FIELDS = ['apiKey', 'gitAccessToken'] as const;
const METADATA_READ_ACTIONS = [
  'listInstances',
  'listEndpoints',
  'listStacks',
  'getStackDetail',
  'getStackOverview',
  'getContainerLogs',
] as const;

function maskSecretFields(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }
  if (Array.isArray(payload)) {
    return payload.map(maskSecretFields);
  }
  const obj = payload as Record<string, unknown>;
  if (typeof obj.toJSON === 'function') {
    return maskSecretFields((obj as { toJSON: () => unknown }).toJSON());
  }
  const clone: Record<string, unknown> = { ...obj };
  for (const field of ENCRYPTED_FIELDS) {
    if (typeof clone[field] === 'string' && clone[field]) {
      clone[field] = SECRET_MASK;
    }
  }
  if (Array.isArray(clone.data)) {
    clone.data = clone.data.map(maskSecretFields);
  }
  if (clone.data && typeof clone.data === 'object' && !Array.isArray(clone.data)) {
    clone.data = maskSecretFields(clone.data);
  }
  if (Array.isArray(clone.rows)) {
    clone.rows = clone.rows.map(maskSecretFields);
  }
  return clone;
}

export class PluginWorkflowPortainerServer extends Plugin {
  private canReadWorkflowMetadata(ctx: Context, action: (typeof METADATA_READ_ACTIONS)[number]): boolean {
    const userId = ctx.state?.currentUser?.id;
    const roles = ctx.state?.currentRoles;
    if (!userId || !Array.isArray(roles)) {
      return false;
    }
    return roles.some((role) => {
      if (typeof role !== 'string') {
        return false;
      }
      if (role === 'root') {
        return true;
      }
      if (this.app.acl.can({ role, resource: PORTAINER_RESOURCE, action })) {
        return true;
      }
      if (this.app.acl.can({ role, resource: 'workflows', action: 'update' })) {
        return true;
      }
      if (this.app.acl.can({ role, resource: 'flow_nodes', action: 'update' })) {
        return true;
      }
      return false;
    });
  }

  async beforeLoad() {
    await this.db.import({
      directory: resolve(__dirname, 'collections'),
    });

    this.db.on(`${PORTAINER_INSTANCES_COLLECTION}.beforeSave`, async (model: Model) => {
      if (model.changed('baseUrl') && model.get('baseUrl')) {
        assertValidPortainerUrl(String(model.get('baseUrl')));
      }
      if (model.changed('defaultTimeoutMs') && model.get('defaultTimeoutMs') !== null) {
        model.set('defaultTimeoutMs', clampTimeoutMs(Number(model.get('defaultTimeoutMs'))));
      }
      const encryptor = (this.app as unknown as { aesEncryptor?: { encrypt(v: string): Promise<string> | string } })
        .aesEncryptor;

      for (const field of ENCRYPTED_FIELDS) {
        if (!model.changed(field)) {
          continue;
        }
        const rawVal = model.get(field);
        if (rawVal === SECRET_MASK) {
          model.set(field, model.previous(field));
          continue;
        }
        if (typeof rawVal === 'string' && rawVal.trim() && encryptor) {
          const encrypted = await encryptor.encrypt(rawVal.trim());
          model.set(field, encrypted);
        }
      }
    });

    this.db.on(`${PORTAINER_INSTANCES_COLLECTION}.afterSave`, async (model: Model) => {
      if (model.get('isDefault')) {
        const currentId = Number(model.get('id'));
        const repo = this.db.getRepository(PORTAINER_INSTANCES_COLLECTION);
        const others = await repo.find({
          filter: {
            isDefault: true,
            id: { $ne: currentId },
          },
        });
        for (const item of others) {
          await item.update({ isDefault: false });
        }
      }
    });
  }

  async load() {
    const workflow = (this.app.pm.get('workflow') || this.app.pm.get('@nocobase/plugin-workflow')) as
      | WorkflowPlugin
      | undefined;

    if (workflow?.registerInstruction) {
      workflow.registerInstruction(INSTRUCTION_TYPES.redeploy, new PortainerStackRedeployInstruction(workflow));
      workflow.registerInstruction(INSTRUCTION_TYPES.control, new PortainerStackControlInstruction(workflow));
    }

    this.app.resourceManager.define({
      name: PORTAINER_RESOURCE,
      actions: createPortainerResourceActions(this.app),
    });

    this.app.resourceManager.use(async (ctx, next) => {
      await next();
      if (ctx.action?.resourceName === PORTAINER_INSTANCES_COLLECTION && ctx.body) {
        ctx.body = maskSecretFields(ctx.body);
      }
    });

    this.app.acl.registerSnippet({
      name: PORTAINER_ACL_SNIPPET,
      actions: [`${PORTAINER_INSTANCES_COLLECTION}:*`, `${PORTAINER_RESOURCE}:*`],
    });

    for (const action of METADATA_READ_ACTIONS) {
      this.app.acl.allow(PORTAINER_RESOURCE, action, (ctx: Context) => this.canReadWorkflowMetadata(ctx, action));
    }
  }
}

export default PluginWorkflowPortainerServer;
