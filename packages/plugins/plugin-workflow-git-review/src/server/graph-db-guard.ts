/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Model, Transaction } from '@nocobase/database';
import type { Application } from '@nocobase/server';
import { assertSafeWorkflow } from './safe-graph';
import { isRecord, type ID, type PostMode } from './contracts';

type HookOptions = { transaction?: Transaction };

export function graphDatabaseGuards(app: Application) {
  const beforeWorkflowCreate = (model: Model) => {
    const options: unknown = model.get('options');
    if (!isRecord(options) || !isRecord(options.gitReview)) return;
    if (model.get('enabled')) throw new Error('A review revision must be created disabled');
    model.set('options', { ...options, gitReview: { ...options.gitReview, frozen: false } });
  };

  const beforeNodeMutation = async (model: Model, options: HookOptions) => {
    const ids = new Set(
      [model.get('workflowId'), model.previous('workflowId')].filter(
        (id): id is ID => typeof id === 'string' || typeof id === 'number',
      ),
    );
    for (const id of ids) {
      const workflow = await app.db.getModel('workflows').findByPk(id, {
        transaction: options.transaction,
        ...(options.transaction ? { lock: options.transaction.LOCK.UPDATE } : {}),
      });
      const config: unknown = workflow?.get('options');
      if (!isRecord(config) || !isRecord(config.gitReview)) continue;
      if (!options.transaction || workflow?.get('enabled') || config.gitReview.frozen !== false) {
        throw new Error('An enabled or frozen review revision cannot be edited');
      }
    }
  };

  const beforeWorkflowUpdate = async (model: Model, options: HookOptions) => {
    const current: unknown = model.get('options');
    const previous: unknown = model.previous('options');
    const marker = isRecord(current) && isRecord(current.gitReview) ? current.gitReview : null;
    const oldMarker = isRecord(previous) && isRecord(previous.gitReview) ? previous.gitReview : marker;
    if (!marker && !oldMarker) return;
    if (!marker || (oldMarker?.frozen === true && marker.frozen !== true)) {
      throw new Error('A frozen review revision cannot be unfrozen');
    }
    if (!model.changed('enabled') || !model.get('enabled')) return;
    if (!options.transaction || model.changed('config'))
      throw new Error('Review activation requires an isolated transaction');
    await app.db.getModel('workflows').findByPk(model.get('id'), {
      transaction: options.transaction,
      lock: options.transaction.LOCK.UPDATE,
    });
    const flow = await app.db.getRepository('gitReviewFlows').findOne({
      filter: { workflowKey: model.get('key') },
      transaction: options.transaction,
    });
    if (!flow) throw new Error('Review flow is unavailable');
    const postMode: PostMode = flow.postMode === 'auto' || flow.postMode === 'disabled' ? flow.postMode : 'manual';
    await assertSafeWorkflow(app, model.get('id') as ID, postMode, false, options.transaction);
    model.set('options', {
      ...(current as Record<string, unknown>),
      gitReview: { ...marker, draft: false, frozen: true },
    });
  };

  return { beforeWorkflowCreate, beforeWorkflowUpdate, beforeNodeMutation };
}
