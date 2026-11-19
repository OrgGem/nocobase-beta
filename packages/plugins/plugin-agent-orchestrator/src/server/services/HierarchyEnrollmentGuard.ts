// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from '@nocobase/actions';
import type { Model } from '@nocobase/database';
import type PluginAIServer from '@nocobase/plugin-ai/server';
import { listSystemTools } from '@nocobase/ai';
import { getAIToolsManager } from '../utils/ai-manager';
import { asRecord, read } from '../utils/record-utils';
import { HarnessProfileService } from './HarnessProfileService';
import { sessionAutoApprovalEnabled } from './SessionAutoApproval';

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item : asRecord(item).name))
    .filter((item): item is string => typeof item === 'string' && item.length > 0);
}

/** Managed children must only execute through the restricted hierarchy runtime. */
export async function guardManagedChildActions(ctx: Context, next: Next) {
  const action = ctx.action;
  if (action?.resourceName !== 'aiConversations') return next();
  const sessionActions = [
    'sendMessages',
    'resendMessages',
    'resumeToolCall',
    'updateUserDecision',
    'updateToolArgs',
    'updateOptions',
    'abort',
  ];
  if (!sessionActions.includes(action.actionName)) return next();
  const userId = ctx.auth?.user?.id;
  const values = action.params?.values ?? {};
  if (typeof values !== 'object' || Array.isArray(values)) {
    return ctx.throw(400, ctx.t('Invalid conversation action input.'));
  }
  const id = action.actionName === 'updateOptions' ? action.params?.filterByTk : values.sessionId;
  if (typeof id !== 'string' || !id.trim()) {
    return ctx.throw(400, ctx.t('A single conversation identifier is required.'));
  }
  const messageActions = ['sendMessages', 'resendMessages', 'resumeToolCall', 'updateUserDecision', 'updateToolArgs'];
  const messageId = action.actionName === 'sendMessages' ? values.editingMessageId : values.messageId;
  const messageRequired = ['updateUserDecision', 'updateToolArgs'].includes(action.actionName);
  const messageAbsent = messageId == null || messageId === '';
  const validMessage =
    (typeof messageId === 'string' && Boolean(messageId.trim())) ||
    (typeof messageId === 'number' && Number.isSafeInteger(messageId) && messageId > 0);
  if (
    messageActions.includes(action.actionName) &&
    ((messageRequired && messageAbsent) || (!messageAbsent && !validMessage))
  ) {
    return ctx.throw(400, ctx.t('A single message identifier is required.'));
  }
  if (
    action.actionName === 'updateUserDecision' &&
    (typeof values.toolCallId !== 'string' || !values.toolCallId.trim())
  ) {
    return ctx.throw(400, ctx.t('A single tool call identifier is required.'));
  }
  if (action.actionName === 'updateToolArgs' && (typeof values.tool?.id !== 'string' || !values.tool.id.trim())) {
    return ctx.throw(400, ctx.t('A single tool call identifier is required.'));
  }
  if (!userId) return next();

  const conversations = ctx.db.getRepository('aiConversations');
  const conversation = await conversations.findOne({ filter: { sessionId: id, userId } });
  if (!conversation) return next();
  const isManagedChild = async (record: Model) => {
    if (read(record, 'from') !== 'sub-agent') return false;
    const childSessionId = read(record, 'sessionId');
    const options = asRecord(read(record, 'options'));
    // The marker also covers a crash between creating the child and attaching it to the journal.
    if (typeof options.hierarchyRootSessionId === 'string' && typeof options.hierarchyParentSessionId === 'string') {
      return Boolean(options.hierarchyRootSessionId && options.hierarchyParentSessionId);
    }
    const invocation = await ctx.db.getRepository('agentHierarchyInvocations').findOne({
      filter: { childSessionId, ownerId: userId },
    });
    return Boolean(invocation);
  };
  if (await isManagedChild(conversation)) {
    return ctx.throw(403, ctx.t('Managed child conversations cannot be modified directly.'));
  }
  if (messageActions.includes(action.actionName) && messageId) {
    const message = await ctx.db.getRepository('aiMessages').findOne({ filter: { messageId } });
    const messageSessionId = read(message, 'sessionId');
    if (typeof messageSessionId === 'string' && messageSessionId !== id) {
      const messageConversation = await conversations.findOne({ filter: { sessionId: messageSessionId, userId } });
      if (messageConversation && (await isManagedChild(messageConversation))) {
        return ctx.throw(403, ctx.t('Managed child conversations cannot be modified directly.'));
      }
    }
  }
  return next();
}

/**
 * Enrollment applies only to employees with an explicitly enabled hierarchy binding.
 * Native tools bypass the managed routing policy, so refuse a configuration where
 * the root could directly call a managed worker tool or native employee dispatch.
 */
export async function guardHierarchyEnrollment(ctx: Context, next: Next) {
  const action = ctx.action;
  if (
    action?.resourceName !== 'aiConversations' ||
    !['sendMessages', 'resendMessages', 'resumeToolCall'].includes(action.actionName)
  ) {
    return next();
  }
  const userId = ctx.auth?.user?.id;
  const values = action.params?.values ?? {};
  const sessionId = typeof values.sessionId === 'string' ? values.sessionId : '';
  if (!userId || !sessionId) return next();
  const conversation = await ctx.db.getRepository('aiConversations').findOne({ filter: { sessionId, userId } });
  if (!conversation || read(conversation, 'from') === 'sub-agent') return next();
  const storedUsername = read(conversation, 'aiEmployeeUsername');
  const requested = typeof values.aiEmployee === 'string' ? values.aiEmployee : storedUsername;
  if (typeof requested !== 'string' || !requested) return next();
  const roots = await ctx.db.getRepository('orchestratorConfig').find({
    filter: { leaderUsername: requested, enabled: true, routingEnabled: true, routingRole: 'specialist' },
  });
  if (!roots.length) return next();
  if (requested !== storedUsername) return ctx.throw(403, ctx.t('The employee does not match the conversation.'));
  const employee = await ctx.db.getRepository('aiEmployees').findOne({ filter: { username: requested } });
  if (!employee) return ctx.throw(403, ctx.t('The AI employee is unavailable.'));
  const settings = asRecord(read(employee, 'skillSettings'));
  const options = asRecord(read(conversation, 'options'));
  const configuredTools = new Set([...names(settings.tools), ...names(options.tools)]);
  const profiles = new HarnessProfileService(ctx.db);
  const workerTools = new Set<string>();
  const autoApprove = await sessionAutoApprovalEnabled(ctx, sessionId);
  for (const root of roots as Model[]) {
    const specialist = read(root, 'subAgentUsername');
    const workerBindings = await ctx.db.getRepository('orchestratorConfig').find({
      filter: { leaderUsername: specialist, enabled: true, routingEnabled: true, routingRole: 'worker' },
    });
    for (const binding of workerBindings as Model[]) {
      const tag = typeof read(binding, 'harnessTag') === 'string' ? String(read(binding, 'harnessTag')) : 'default';
      const profile = await profiles.getPublishedByTag(tag);
      if (!profile) return ctx.throw(403, ctx.t('The delegation policy profile is unavailable.'));
      for (const name of profile.settings.tools.allow) workerTools.add(name);
      if (autoApprove) for (const name of profile.settings.tools.ask) workerTools.add(name);
    }
  }
  const generalTools = await getAIToolsManager(ctx.app).listTools({ scope: 'GENERAL', ctx, sessionId });
  for (const tool of generalTools as Array<{ definition?: { name?: string } }>) {
    if (tool.definition?.name) configuredTools.add(tool.definition.name);
  }
  const conversationSettings = asRecord(options.skillSettings);
  const toolFilter = names(conversationSettings.tools);
  const hasToolFilter =
    Array.isArray(conversationSettings.tools) && (Boolean(conversationSettings.toolsVersion) || toolFilter.length > 0);
  if (hasToolFilter) {
    const systemTools = new Set(listSystemTools());
    for (const name of configuredTools) {
      if (!systemTools.has(name) && !toolFilter.includes(name)) configuredTools.delete(name);
    }
  }
  const chatSettings = asRecord(read(employee, 'chatSettings'));
  const ai = ctx.app.pm.get('ai') as PluginAIServer | undefined;
  if (!ai?.ai?.skillsManager) return ctx.throw(403, ctx.t('The AI employee skills are unavailable.'));
  const skillsManager = ai.ai.skillsManager;
  if (chatSettings.enableSkills !== false) {
    const general = await skillsManager.listSkills({ scope: 'GENERAL' });
    const selected = names(settings.skills);
    const specified = selected.length ? await skillsManager.getSkills(selected) : [];
    const skillFilter = names(conversationSettings.skills);
    const hasSkillFilter =
      Array.isArray(conversationSettings.skills) &&
      (Boolean(conversationSettings.skillsVersion) || skillFilter.length > 0);
    for (const skill of [...general, ...specified]) {
      if (hasSkillFilter && !skillFilter.includes(skill.name)) continue;
      for (const name of names(skill.tools)) configuredTools.add(name);
    }
  }
  // Native middleware also honours skills loaded earlier in this session, even after
  // the employee's current skill list changes.
  const loaded = await ctx.db.getRepository('aiToolMessages').find({
    filter: { sessionId, toolName: 'getSkill', status: 'success' },
  });
  const loadedNames = new Set<string>();
  for (const call of loaded as Model[]) {
    let content = read(call, 'content');
    if (typeof content === 'string') {
      try {
        content = JSON.parse(content);
      } catch {
        continue;
      }
    }
    const name = asRecord(content).skillName;
    if (typeof name === 'string' && name) loadedNames.add(name);
  }
  if (loadedNames.size) {
    const loadedSkills = await skillsManager.getSkills([...loadedNames]);
    for (const skill of loadedSkills) {
      for (const name of names(skill.tools)) configuredTools.add(name);
    }
  }
  if (configuredTools.has('dispatch-sub-agent-task')) {
    return ctx.throw(403, ctx.t('Disable native AI employee dispatch before using managed hierarchy routing.'));
  }
  if ([...workerTools].some((name) => configuredTools.has(name))) {
    return ctx.throw(
      403,
      ctx.t('Remove managed worker tools from the parent employee before using hierarchy routing.'),
    );
  }
  return next();
}
