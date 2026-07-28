import { getAgentExecutionContext } from './AgentExecutionContext';
import { asObject, isAdminUser, normalizeEmployeeUsername, valuesFromCtx } from '../utils/ctx-utils';
import { getSkillToolName, normalizeSkillToolScope, readRecordValue } from '../utils/skill-tool-name';

type ToolBinding = { name?: unknown } | string;

function bindingName(binding: ToolBinding): string {
  if (typeof binding === 'string') return binding.trim();
  return typeof binding?.name === 'string' ? binding.name.trim() : '';
}

export class SkillAccessService {
  constructor(private readonly plugin: { db: { getRepository: (name: string) => any } }) {}

  async resolveAgentUsername(ctx: any): Promise<string | undefined> {
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
    ctx: any,
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

  async filterAccessibleSkills(ctx: any, skills: unknown[]): Promise<unknown[]> {
    if (isAdminUser(ctx)) return skills;
    const agentUsername = await this.resolveAgentUsername(ctx);
    if (!agentUsername) return [];

    const checks = await Promise.all(skills.map((skill) => this.canAgentUseSkill(agentUsername, skill)));
    return skills.filter((_skill, index) => checks[index]);
  }

  async findAgentUsernamesUsingTool(toolName: string): Promise<string[]> {
    const employees = await this.plugin.db.getRepository('aiEmployees').find({});
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
}
