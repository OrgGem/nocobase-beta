import { getAgentExecutionContext } from './AgentExecutionContext';
import { asObject, isAdminUser, normalizeEmployeeUsername, valuesFromCtx } from '../utils/ctx-utils';
import { getSkillToolName, normalizeSkillToolScope, readRecordValue } from '../utils/skill-tool-name';

type ToolBinding = { name?: unknown } | string;

function bindingName(binding: ToolBinding): string {
  if (typeof binding === 'string') return binding.trim();
  return typeof binding?.name === 'string' ? binding.name.trim() : '';
}

export class SkillAccessService {
  constructor(
    private readonly plugin: {
      db: {
        getRepository: (name: string) =>
          | {
              find: (opts?: Record<string, unknown>) => Promise<unknown[]>;
              findOne: (opts: Record<string, unknown>) => Promise<unknown>;
              update: (opts: Record<string, unknown>) => Promise<unknown>;
            }
          | undefined;
      };
      app?: { logger?: { info?: (...args: unknown[]) => void } };
    },
  ) {}

  async resolveAgentUsername(ctx: Record<string, unknown>): Promise<string | undefined> {
    const executionIdentity = getAgentExecutionContext();
    if (executionIdentity?.employeeUsername) return executionIdentity.employeeUsername;

    const values = valuesFromCtx(ctx);
    const direct = normalizeEmployeeUsername(
      ctx?._currentAIEmployee ||
        ctx?.state?.currentAIEmployee ||
        ctx?.runtime?.context?.currentAIEmployee ||
        values.aiEmployee ||
        values.aiEmployeeUsername,
    );
    if (direct) return direct;

    const sessionId =
      executionIdentity?.sessionId || values.sessionId || ctx?.action?.params?.sessionId || ctx?.state?.sessionId;
    if (!sessionId) return undefined;

    try {
      const conversation = await this.plugin.db.getRepository('aiConversations').findOne({
        filter: { sessionId },
      });
      return (
        normalizeEmployeeUsername(readRecordValue(conversation, 'aiEmployeeUsername')) ||
        normalizeEmployeeUsername(readRecordValue(conversation, 'aiEmployee')) ||
        undefined
      );
    } catch {
      return undefined;
    }
  }

  async canAgentUseSkill(agentUsername: string, skill: unknown): Promise<boolean> {
    if (normalizeSkillToolScope(readRecordValue(skill, 'toolScope')) === 'GENERAL') return true;

    const employee = await this.plugin.db.getRepository('aiEmployees').findOne({
      filter: { username: agentUsername },
    });
    if (!employee) return false;

    const skillSettings = asObject(readRecordValue(employee, 'skillSettings'));
    const tools = Array.isArray(skillSettings.tools) ? (skillSettings.tools as ToolBinding[]) : [];
    const targetToolName = getSkillToolName(skill);
    return tools.some((binding) => bindingName(binding) === targetToolName);
  }

  async assertCanExecute(
    ctx: Record<string, unknown>,
    skill: unknown,
    options: { privileged?: boolean } = {},
  ): Promise<string | undefined> {
    if (options.privileged) return this.resolveAgentUsername(ctx);
    if (isAdminUser(ctx)) return this.resolveAgentUsername(ctx);

    const agentUsername = await this.resolveAgentUsername(ctx);
    if (!agentUsername) {
      throw new Error('Skill execution requires an AI employee context.');
    }
    if (!(await this.canAgentUseSkill(agentUsername, skill))) {
      throw new Error(`AI employee "${agentUsername}" is not bound to skill tool "${getSkillToolName(skill)}".`);
    }
    return agentUsername;
  }

  async filterAccessibleSkills(ctx: Record<string, unknown>, skills: unknown[]): Promise<unknown[]> {
    if (isAdminUser(ctx)) return skills;
    const agentUsername = await this.resolveAgentUsername(ctx);
    if (!agentUsername) return [];

    const checks = await Promise.all(skills.map((skill) => this.canAgentUseSkill(agentUsername, skill)));
    return skills.filter((_skill, index) => checks[index]);
  }

  async findAgentUsernamesUsingTool(toolName: string): Promise<string[]> {
    // Cap at 500 employees to prevent unbounded scans. Most deployments have <100.
    const employees = await this.plugin.db.getRepository('aiEmployees').find({ limit: 500 });
    const usernames: string[] = [];
    for (const employee of employees || []) {
      const settings = asObject(readRecordValue(employee, 'skillSettings'));
      const tools = Array.isArray(settings.tools) ? (settings.tools as ToolBinding[]) : [];
      if (!tools.some((binding) => bindingName(binding) === toolName)) continue;
      const username = normalizeEmployeeUsername(readRecordValue(employee, 'username'));
      if (username) usernames.push(username);
    }
    return usernames;
  }

  /**
   * Cascade-disable a skill across all AI employee bindings.
   *
   * When a skill is disabled or deleted, this method removes its tool from every employee's
   * `skillSettings.tools` array. This prevents stale bindings from allowing execution of
   * skills that are no longer available.
   *
   * Returns the list of affected employee usernames for audit logging.
   */
  async cascadeDisableSkill(skillToolName: string): Promise<string[]> {
    const affectedUsernames: string[] = [];
    // Cap at 500 employees to prevent unbounded scans. Most deployments have <100.
    const employees = await this.plugin.db.getRepository('aiEmployees').find({ limit: 500 });

    // Collect all updates first, then apply in parallel to reduce round-trips.
    const updates: Array<{ username: string; skillSettings: Record<string, unknown> }> = [];

    for (const employee of employees || []) {
      const skillSettings = asObject(readRecordValue(employee, 'skillSettings'));
      const tools = Array.isArray(skillSettings.tools) ? (skillSettings.tools as ToolBinding[]) : [];
      const filteredTools = tools.filter((binding) => bindingName(binding) !== skillToolName);

      if (filteredTools.length === tools.length) continue;

      const username = normalizeEmployeeUsername(readRecordValue(employee, 'username'));
      if (!username) continue;

      updates.push({
        username,
        skillSettings: {
          ...skillSettings,
          tools: filteredTools,
        },
      });
    }

    // Apply updates in parallel (max 10 concurrent to avoid DB overload).
    const BATCH_SIZE = 10;
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map((update) =>
          this.plugin.db
            .getRepository('aiEmployees')
            .update({
              filter: { username: update.username },
              values: { skillSettings: update.skillSettings },
            })
            .then(() => {
              affectedUsernames.push(update.username);
              this.plugin.app?.logger?.info?.(
                `[SkillAccess] Cascade-removed skill tool "${skillToolName}" from employee "${update.username}".`,
              );
            }),
        ),
      );
    }

    return affectedUsernames;
  }
}
