/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Database } from '@nocobase/database';
import type { Context } from 'koa';

export function createClusterReadinessMiddleware(
  database: Database,
  identity: { appId: string; deploymentId: string; nodeId: string },
) {
  return async (ctx: Context, next: () => Promise<void>) => {
    try {
      const control = await database.getRepository('startupGuardianClusterState').findOne({
        filter: { appId: identity.appId, deploymentId: identity.deploymentId },
      });
      const member = await database.getRepository('startupGuardianClusterMembers').findOne({
        filter: { appId: identity.appId, deploymentId: identity.deploymentId, nodeId: identity.nodeId },
      });
      if (
        !control ||
        !member ||
        control.get('phase') !== 'ready' ||
        member.get('state') !== 'ready' ||
        Number(member.get('appliedRevision')) < Number(control.get('decisionRevision'))
      ) {
        ctx.status = 503;
        ctx.body = { error: 'startup-guardian-cluster-not-ready' };
        return;
      }
    } catch {
      ctx.status = 503;
      ctx.body = { error: 'startup-guardian-cluster-state-unavailable' };
      return;
    }
    await next();
  };
}
