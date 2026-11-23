// SPDX-License-Identifier: Apache-2.0

import type { WorkflowModel } from '@nocobase/plugin-workflow';
import type { Application } from '@nocobase/server';
import { COLLECTIONS, DEFAULT_EXPLORER_WORKFLOW_KEY, RCLONE_TRANSFER_INSTRUCTION_TYPE } from '../../shared/constants';

/**
 * Idempotently provisions the default NocoBase Collection Workflow that
 * executes Explorer-initiated Copy / Move / Sync requests via `rcloneTransferTasks`.
 *
 * If an admin has already customized or created revisions under
 * `DEFAULT_EXPLORER_WORKFLOW_KEY` (e.g. adding Approval or Notification nodes),
 * this function leaves the existing workflow untouched.
 */
export async function ensureDefaultExplorerWorkflow(app: Application): Promise<WorkflowModel | null> {
  if (!app.pm.get('workflow') || !app.db.getCollection('workflows') || !app.db.getCollection('flow_nodes')) {
    return null;
  }

  const wfRepo = app.db.getRepository('workflows');
  const existingCurrent = (await wfRepo.findOne({
    filter: { key: DEFAULT_EXPLORER_WORKFLOW_KEY, current: true },
  })) as WorkflowModel | null;

  if (existingCurrent) {
    return existingCurrent;
  }

  const anyExisting = (await wfRepo.findOne({
    filter: { key: DEFAULT_EXPLORER_WORKFLOW_KEY },
  })) as WorkflowModel | null;

  if (anyExisting) {
    return anyExisting;
  }

  return app.db.sequelize.transaction(async (transaction) => {
    const doubleCheck = (await wfRepo.findOne({
      filter: { key: DEFAULT_EXPLORER_WORKFLOW_KEY },
      transaction,
    })) as WorkflowModel | null;
    if (doubleCheck) {
      return doubleCheck;
    }

    const created = (await wfRepo.create({
      values: {
        key: DEFAULT_EXPLORER_WORKFLOW_KEY,
        title: 'Rclone Explorer Transfer Flow',
        description:
          'Managed workflow triggered when Copy / Move / Sync is initiated from Rclone Explorer. You may add Approval or Notification nodes around the Rclone Transfer step.',
        type: 'collection',
        sync: false,
        current: true,
        enabled: false,
        config: {
          collection: COLLECTIONS.tasks,
          mode: 1,
          appends: [],
          condition: {
            $and: [{ triggerSource: { $eq: 'explorer' } }],
          },
        },
      },
      transaction,
    })) as WorkflowModel;

    await created.createNode(
      {
        type: RCLONE_TRANSFER_INSTRUCTION_TYPE,
        title: 'Execute Rclone Transfer',
        upstreamId: null,
        config: {
          taskId: '{{$context.data.id}}',
          failOnError: true,
        },
      },
      { transaction },
    );

    await created.update({ enabled: true, current: true }, { transaction });
    return created;
  });
}
