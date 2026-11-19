// SPDX-License-Identifier: Apache-2.0
import type { Context, Next } from '@nocobase/actions';
import type { Filter, Model } from '@nocobase/database';
import { getAIToolsManager } from '../utils/ai-manager';
import { asRecord, read } from '../utils/record-utils';
import { getSkillToolName } from '../utils/skill-tool-name';
import { parseJsonText } from '../skill-hub/utils/json-fields';
import {
  autoApprovalCheckpoint,
  coordinateAutoApprovalDecision,
  enrollAutoApprovalCheckpoint,
} from './AutoApprovalCheckpoint';

const interactiveTools = new Set(['suggestions', 'aiEmployeeWorkflowTaskOutput']);

export type AutoApprovalCall = { sessionId: string; messageId: string; toolCallId: string };

export function autoApprovalCall(values: Record<string, unknown>): AutoApprovalCall | null {
  const { sessionId, messageId, toolCallId } = values;
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 100) return null;
  if (
    !(
      (typeof messageId === 'string' && messageId.trim()) ||
      (typeof messageId === 'number' && Number.isSafeInteger(messageId) && messageId > 0)
    )
  )
    return null;
  if (typeof toolCallId !== 'string' || !toolCallId.trim()) return null;
  return { sessionId, messageId: String(messageId), toolCallId };
}

/** The caller must already have verified access to the root conversation. */
export async function sessionAutoApprovalEnabled(ctx: Context, sessionId: string): Promise<boolean> {
  const ownerId = ctx.auth?.user?.id;
  if (!ownerId || !sessionId) return false;
  const setting = await ctx.db.getRepository('agentSessionAutoApprovals').findOne({
    filter: { ownerId, sessionId },
  });
  return read(setting, 'enabled') === true;
}

/** Skill Hub interaction schemas request user input and must not be filled by an approval. */
export async function skillRequiresUserInput(ctx: Context, name: string, args: unknown): Promise<boolean> {
  const repository = ctx.db.getRepository('skillDefinitions');
  let skill;
  if (name === 'skill_hub_execute') {
    const input = asRecord(args);
    if (input.action === 'list' || input.action === 'describe') return false;
    if (input.action !== 'execute' || typeof input.skillName !== 'string' || !input.skillName) return true;
    skill = await repository.findOne({ filter: { name: input.skillName, enabled: true } });
    if (!skill) return true;
  } else {
    skill = await repository.findOne({ filter: { toolName: name, enabled: true } });
    if (!skill && name.startsWith('skill_hub_')) {
      const legacy = await repository.find({ filter: { enabled: true } });
      skill = legacy.find((item: Model) => {
        try {
          return getSkillToolName(item) === name;
        } catch {
          return false;
        }
      });
    }
    if (!skill) return false;
  }
  const skillId = read(skill, 'id');
  if (typeof skillId !== 'number' && typeof skillId !== 'string') return true;
  const loop = await ctx.db.getRepository('skillLoopConfigs').findOne({
    filter: { enabled: true, skillId },
    sort: ['-updatedAt'],
  });
  const loopSchema = parseJsonText<unknown>(read(loop, 'schema'), null);
  if ((loopSchema && typeof loopSchema === 'object') || read(loop, 'prompt')) return true;
  return Boolean(parseJsonText<unknown>(read(skill, 'interactionSchema'), null));
}

/** Verify the persisted root interrupt rather than trusting the event sent to the browser. */
export async function isAutoApprovalEligible(ctx: Context, call: AutoApprovalCall): Promise<boolean> {
  const ownerId = ctx.auth?.user?.id;
  if (!ownerId || !(await sessionAutoApprovalEnabled(ctx, call.sessionId))) return false;
  const conversation = await ctx.db.getRepository('aiConversations').findOne({
    filter: { sessionId: call.sessionId, userId: ownerId },
  });
  if (!conversation || read(conversation, 'from') === 'sub-agent') return false;
  const username = read(conversation, 'aiEmployeeUsername');
  if (typeof username !== 'string' || !username) return false;
  const requestedRoles = ctx.state.currentRoles;
  if (!Array.isArray(requestedRoles)) return false;
  const memberships = await ctx.db.getRepository('rolesUsers').find({ filter: { userId: ownerId } });
  const memberRoles = new Set(memberships.map((row: Model) => read(row, 'roleName')));
  const roles = requestedRoles.filter(
    (role: unknown): role is string => typeof role === 'string' && memberRoles.has(role),
  );
  if (!roles.length) return false;
  if (
    typeof ctx.state.currentRole === 'string' &&
    ctx.state.currentRole !== '__union__' &&
    !roles.includes(ctx.state.currentRole)
  )
    return false;
  const filter: Filter = { username };
  if (!roles.includes('root')) filter['roles.name'] = roles;
  const employee = await ctx.db.getRepository('aiEmployees').findOne({ filter });
  if (!employee || read(employee, 'enabled') === false) return false;
  const message = await ctx.db.getRepository('aiMessages').findOne({
    filter: { sessionId: call.sessionId, messageId: call.messageId, role: username },
  });
  const calls = read(message, 'toolCalls');
  const selected = Array.isArray(calls) ? calls.map(asRecord).find((item) => item.id === call.toolCallId) : undefined;
  const name = selected?.name;
  if (typeof name !== 'string' || !name || interactiveTools.has(name)) return false;
  if (await skillRequiresUserInput(ctx, name, selected.args)) return false;
  const tool = await ctx.db.getRepository('aiToolMessages').findOne({
    filter: { ...call, toolName: name, invokeStatus: 'interrupted' },
  });
  if (!tool || read(tool, 'auto') !== false || read(tool, 'status') === 'error') return false;
  const interrupt = asRecord(read(tool, 'interruptAction'));
  const interruptCall = asRecord(interrupt.toolCall);
  const interruptedConversation = asRecord(interrupt.currentConversation);
  const metadata = asRecord(read(message, 'metadata'));
  if (
    !Array.isArray(interrupt.allowedDecisions) ||
    !interrupt.allowedDecisions.includes('approve') ||
    interruptCall.id !== call.toolCallId ||
    interruptCall.name !== name ||
    interruptedConversation.sessionId !== call.sessionId ||
    interruptedConversation.from !== 'main-agent' ||
    interruptedConversation.username !== username ||
    typeof metadata.interruptId !== 'string' ||
    !metadata.interruptId
  )
    return false;
  const entry = await getAIToolsManager(ctx.app).getTools(name, { ctx, sessionId: call.sessionId });
  if (!entry || typeof entry.invoke !== 'function') return false;
  if (name === 'executeFrontendTool') {
    const toolId = asRecord(selected.args).toolId;
    const options = asRecord(read(conversation, 'options'));
    const tools = options.frontendTools;
    if (typeof toolId !== 'string' || !Array.isArray(tools)) return false;
    return tools
      .map(asRecord)
      .some((tool) => tool.id === toolId && tool.id === `${tool.blockUid}:${tool.name}` && tool.permission === 'ASK');
  }
  return true;
}

/** Marked automatic decisions are rechecked as the native action receives them. */
export async function guardAutoApprovalDecision(ctx: Context, next: Next) {
  if (ctx.action?.resourceName !== 'aiConversations' || ctx.action.actionName !== 'updateUserDecision') return next();
  const values = asRecord(ctx.action.params?.values);
  const automatic = values.agentAutoApproval === true;
  const decision = asRecord(values.userDecision);
  const call = autoApprovalCall(values);
  if (automatic && (!call || decision.type !== 'approve' || !(await isAutoApprovalEligible(ctx, call)))) {
    ctx.body = { updated: 0, toolCalls: [] };
    return;
  }
  if (!call) return next();
  const checkpoint = await autoApprovalCheckpoint(ctx, call);
  if (automatic && checkpoint === undefined) {
    ctx.body = { updated: 0, toolCalls: [] };
    return;
  }
  if (automatic && checkpoint) await enrollAutoApprovalCheckpoint(ctx, checkpoint);
  await next();
  if (checkpoint) await coordinateAutoApprovalDecision(ctx, checkpoint, call);
}
