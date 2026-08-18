import type { Plugin } from '@nocobase/server';
import { AgentMemoryContextService } from '../services/AgentMemoryContextService';
import { currentUserId, isAdminUser, trimText } from '../utils/ctx-utils';

type PlainRecord = Record<string, unknown>;

type AccessMatrixRow = {
  key: string;
  employeeUsername: string;
  employeeRoles: string[];
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  knowledgeBaseType: string;
  assigned: boolean;
  enabled: boolean;
  access: 'allowed' | 'denied';
  reason: string;
  userGate: string;
};

type Citation = {
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
  sourceId?: string;
  filename?: string;
  url?: string;
  collection?: string;
  recordId?: string;
  excerpt?: string;
  score?: number;
};

function asPlainRecord(value: unknown): PlainRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const model = value as { toJSON?: () => unknown };
  const plain = typeof model.toJSON === 'function' ? model.toJSON() : value;
  return plain && typeof plain === 'object' && !Array.isArray(plain) ? (plain as PlainRecord) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? Array.from(new Set(value.map(text).filter(Boolean))) : [];
}

function record(value: unknown): PlainRecord {
  if (typeof value === 'string' && value.trim()) {
    try {
      return asPlainRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return asPlainRecord(value);
}

function employeeRoles(employee: PlainRecord): string[] {
  return Array.isArray(employee.roles)
    ? employee.roles
        .map((role) => {
          const roleRecord = asPlainRecord(role);
          return text(typeof role === 'string' ? role : roleRecord.name);
        })
        .filter(Boolean)
    : [];
}

function assignedKnowledgeBaseIds(employee: PlainRecord): string[] {
  const settings = record(employee.knowledgeBase);
  const legacyIds = strings(settings.knowledgeBaseKeys);
  return legacyIds.length ? legacyIds : strings(settings.knowledgeBaseIds);
}

function accessLevelDescription(knowledgeBase: PlainRecord): string {
  const level = text(knowledgeBase.accessLevel) || 'PUBLIC';
  if (level === 'BASIC') return 'The triggering user must be the KB owner.';
  if (level === 'SHARED') return 'The triggering user must have an allowed KB role.';
  return 'No additional triggering-user gate (public KB).';
}

/**
 * Builds the static half of a retrieval decision. User access remains dynamic:
 * for BASIC/SHARED KBs it is evaluated again for the user who triggers a run.
 */
export function buildKnowledgeAccessMatrix(employees: unknown[], knowledgeBases: unknown[]): AccessMatrixRow[] {
  const rows: AccessMatrixRow[] = [];
  const normalizedKnowledgeBases = knowledgeBases.map(asPlainRecord).filter((item) => text(item.id));

  for (const rawEmployee of employees) {
    const employee = asPlainRecord(rawEmployee);
    const username = text(employee.username);
    if (!username) continue;
    const roles = employeeRoles(employee);
    const assignedIds = assignedKnowledgeBaseIds(employee);

    for (const knowledgeBase of normalizedKnowledgeBases) {
      const id = text(knowledgeBase.id);
      const assigned = assignedIds.includes(id);
      const enabled = knowledgeBase.enabled !== false;
      const agentAccess = text(knowledgeBase.agentAccess) || 'inherit';
      const allowedAgents = strings(knowledgeBase.allowedAgents);
      const allowedRoles = strings(knowledgeBase.allowedRoles);
      const explicitGrant = allowedAgents.includes(username) || roles.some((role) => allowedRoles.includes(role));

      let access: AccessMatrixRow['access'] = 'allowed';
      let reason = 'Assigned to the AI Employee; agent policy inherits user access.';
      if (!enabled) {
        access = 'denied';
        reason = 'Knowledge base is disabled.';
      } else if (!assigned) {
        access = 'denied';
        reason = 'Knowledge base is not assigned to this AI Employee.';
      } else if (agentAccess === 'none') {
        access = 'denied';
        reason = 'Knowledge base policy denies all AI Employee access.';
      } else if (agentAccess === 'explicit' && !explicitGrant) {
        access = 'denied';
        reason = 'Explicit agent policy has no matching employee username or role.';
      } else if (agentAccess === 'explicit') {
        reason = allowedAgents.includes(username)
          ? 'Explicit agent policy grants this AI Employee username.'
          : 'Explicit agent policy grants one of this AI Employee roles.';
      }

      rows.push({
        key: `${username}:${id}`,
        employeeUsername: username,
        employeeRoles: roles,
        knowledgeBaseId: id,
        knowledgeBaseName: text(knowledgeBase.name) || id,
        knowledgeBaseType: text(knowledgeBase.type) || 'LOCAL',
        assigned,
        enabled,
        access,
        reason,
        userGate: accessLevelDescription(knowledgeBase),
      });
    }
  }

  return rows;
}

function parseJson(value: unknown): PlainRecord {
  if (typeof value !== 'string' || !value.trim()) return asPlainRecord(value);
  try {
    return asPlainRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

function numeric(value: unknown): number | undefined {
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function citationFromResult(value: unknown): Citation {
  const result = asPlainRecord(value);
  const source = asPlainRecord(result.source);
  return {
    knowledgeBaseId: text(result.knowledgeBaseId) || undefined,
    knowledgeBaseName: text(result.knowledgeBaseName) || undefined,
    sourceId: text(source.id) || undefined,
    filename: text(source.filename) || undefined,
    url: text(source.url) || undefined,
    collection: text(source.collection) || undefined,
    recordId: text(source.recordId) || undefined,
    excerpt: text(result.content) ? trimText(text(result.content), 500) : undefined,
    score: numeric(result.score),
  };
}

/** Turns persisted external_rag_search spans into a compact, citation-only diagnostic. */
export function summarizeRetrievalSpan(rawSpan: unknown) {
  const span = asPlainRecord(rawSpan);
  const input = record(span.input);
  const output = parseJson(span.output);
  const results = Array.isArray(output.results) ? output.results.map(citationFromResult) : [];
  const outputError = text(output.error);
  const error = text(span.error) || outputError;
  const denied = text(span.status) === 'error';

  return {
    id: span.id,
    createdAt: span.createdAt || span.startedAt,
    employeeUsername: text(span.employeeUsername),
    leaderUsername: text(span.leaderUsername),
    userId: span.userId,
    query: text(input.query) || text(output.query),
    decision: denied ? 'denied' : 'allowed',
    reason: denied
      ? error || 'The tool returned an error without a reason.'
      : `${results.length} citation(s) returned.`,
    citations: results,
  };
}

function ensureAdmin(ctx: { throw: (status: number, message: string) => void }) {
  if (isAdminUser(ctx)) return true;
  ctx.throw(403, 'Administrator role is required to view Agent and Knowledge Base diagnostics.');
  return false;
}

function paramsValues(ctx: { action?: { params?: { values?: unknown } } }): PlainRecord {
  return record(ctx.action?.params?.values);
}

export function registerAgentKnowledgeInsightsResource(plugin: Plugin) {
  const memoryService = new AgentMemoryContextService(plugin);

  plugin.app.resource({
    name: 'agentKnowledgeInsights',
    actions: {
      async accessMatrix(ctx, next) {
        if (!ensureAdmin(ctx)) return;
        const employees = await ctx.db.getRepository('aiEmployees').find({
          sort: ['username'],
          appends: ['roles'],
        });
        // plugin-knowledge-base is an optional integration: when it is disabled the collection
        // is not registered, and the matrix degrades to employees without knowledge bases.
        const knowledgeBases = ctx.db.hasCollection('aiKnowledgeBases')
          ? await ctx.db.getRepository('aiKnowledgeBases').find({ sort: ['name'] })
          : [];
        ctx.body = { data: buildKnowledgeAccessMatrix(employees, knowledgeBases) };
        await next();
      },

      async retrievalTrace(ctx, next) {
        if (!ensureAdmin(ctx)) return;
        const values = paramsValues(ctx);
        const page = Math.max(Number(values.page || ctx.action.params.page || 1), 1);
        const pageSize = Math.min(Math.max(Number(values.pageSize || ctx.action.params.pageSize || 20), 1), 100);
        const filter: PlainRecord = { toolName: 'external_rag_search' };
        const employeeUsername = text(values.employeeUsername || ctx.action.params.employeeUsername);
        if (employeeUsername) filter.employeeUsername = employeeUsername;

        const [spans, count] = await ctx.db.getRepository('agentExecutionSpans').findAndCount({
          filter,
          sort: ['-createdAt'],
          offset: (page - 1) * pageSize,
          limit: pageSize,
        });
        ctx.body = {
          data: spans.map(summarizeRetrievalSpan),
          meta: { count, page, pageSize, totalPage: Math.ceil(count / pageSize) },
        };
        await next();
      },

      async memoryPreview(ctx, next) {
        if (!ensureAdmin(ctx)) return;
        const values = paramsValues(ctx);
        const employeeUsername = text(values.employeeUsername);
        const leaderUsername = text(values.leaderUsername);
        const harnessTag = text(values.harnessTag);
        const userId = text(values.userId) || String(currentUserId(ctx) || '');
        if (!userId) {
          ctx.throw(400, 'userId is required to preview memory context.');
          return;
        }

        const employee = employeeUsername
          ? await ctx.db.getRepository('aiEmployees').findOne({ filter: { username: employeeUsername } })
          : undefined;
        if (employeeUsername && !employee) {
          ctx.throw(404, `AI Employee "${employeeUsername}" was not found.`);
          return;
        }

        const settings = await memoryService.resolvePolicySettings({
          ctx: {
            action: {
              params: {
                values: {
                  aiEmployeeUsername: leaderUsername,
                  harnessTag,
                },
              },
            },
          },
          employee,
        });
        const preview = await memoryService.buildContext({
          userId,
          aiEmployeeUsername: employeeUsername || undefined,
          settings,
        });
        const maxChars = Number(settings.maxMemoryContextChars || settings.maxContextChars || 6000);
        ctx.body = {
          data: {
            ...preview,
            userId,
            employeeUsername: employeeUsername || undefined,
            harnessTag: settings.harnessTag || harnessTag || 'default',
            maxChars: Number.isFinite(maxChars) ? Math.min(Math.max(maxChars, 500), 20_000) : 6000,
          },
        };
        await next();
      },
    },
  });
}
