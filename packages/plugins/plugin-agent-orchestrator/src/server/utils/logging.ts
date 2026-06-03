// ── Shared logging for delegation events ───────────────────────────────

import { DelegationLogData } from '../types';
import { trimText, toPlain } from './ctx-utils';

/**
 * Log (or update) a delegation event in the orchestratorLogs collection.
 * Used by both delegate-task.ts and AgentHarness.ts.
 */
export async function logDelegation(ctx: any, plugin: any, data: DelegationLogData) {
  try {
    const logsRepo = plugin.db.getRepository('orchestratorLogs');
    if (!logsRepo) {
      plugin.app.log?.warn?.('[AgentOrchestrator] orchestratorLogs repository not found — skipping log');
      return null;
    }

    let userId: number | string | undefined = data.userId;
    if (userId == null) {
      try {
        userId = ctx?.auth?.user?.id || ctx?.state?.currentUser?.id;
      } catch {
        // ctx lifecycle ended
      }
    }

    const values = {
      leaderUsername: data.leaderUsername,
      subAgentUsername: data.subAgentUsername,
      toolName: data.toolName,
      task: trimText(data.task, 10000),
      context: trimText(data.context || '', 10000),
      result: trimText(data.result || '', 50000),
      status: data.status,
      depth: data.depth,
      durationMs: data.durationMs,
      error: trimText(data.error || '', 10000),
      trace: data.trace || [],
      messages: data.messages || [],
      userId,
      updatedAt: new Date(),
    };

    if (data.id) {
      await logsRepo.update({
        filterByTk: data.id,
        values,
      });
      return { id: data.id };
    }

    const record = await logsRepo.create({
      values: {
        ...values,
        createdAt: new Date(),
      },
    });
    return toPlain(record);
  } catch (e) {
    plugin.app.log?.warn?.('[AgentOrchestrator] Failed to log delegation event', e);
    return null;
  }
}
