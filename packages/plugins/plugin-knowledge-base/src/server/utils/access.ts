import type { Context } from '@nocobase/actions';

export type KnowledgeBaseAccessLevel = 'BASIC' | 'SHARED' | 'PUBLIC';

/**
 * How an AI Employee (agent) may reach a Knowledge Base when it runs a tool
 * on behalf of a user (or autonomously).
 *
 * - inherit:  the agent rides on the triggering user's access. The user-level
 *             gate is the only constraint (default — preserves legacy behavior).
 * - explicit: the agent must be named in `allowedAgents`, or hold a role listed
 *             in `allowedRoles`. Used to expose a KB to specific agents only.
 * - none:     no agent may ever read/use this KB, regardless of who triggered it.
 */
export type KnowledgeBaseAgentAccess = 'inherit' | 'explicit' | 'none';

const ADMIN_ROOT_ROLE = 'root';

export function getAuthUserId(ctx: Context): string | undefined {
  const id = (ctx as any).auth?.user?.id ?? (ctx as any).state?.currentUser?.id;
  return id == null ? undefined : String(id);
}

/**
 * Roles that are *active* for this request.
 *
 * NocoBase v2's `setCurrentRole` middleware resolves the active role set into
 * `ctx.state.currentRoles` (honoring the `X-Role` header and union-role mode).
 * We prefer that over the full set of assigned roles so SHARED access matches
 * the role the user actually switched into — consistent with core ACL.
 *
 * Falls back to all assigned roles only when the middleware did not populate
 * currentRoles (e.g. internal/system calls that bypass the resourcer).
 */
export function getCurrentRoles(ctx: Context): string[] {
  const roles = new Set<string>();

  const currentRoles = (ctx as any).state?.currentRoles;
  if (Array.isArray(currentRoles) && currentRoles.length) {
    for (const role of currentRoles) {
      if (role) roles.add(String(role));
    }
    return Array.from(roles);
  }

  const currentRole = (ctx as any).state?.currentRole;
  if (currentRole) {
    roles.add(String(currentRole));
    return Array.from(roles);
  }

  // Fallback: assigned roles (no active-role context available).
  const userRoles = (ctx as any).state?.currentUser?.roles ?? (ctx as any).auth?.user?.roles;
  if (Array.isArray(userRoles)) {
    for (const role of userRoles) {
      const name = typeof role === 'string' ? role : role?.name;
      if (name) roles.add(String(name));
    }
  }

  return Array.from(roles);
}

/**
 * Whether any of the given roles is an administrator role.
 *
 * Replaces the previous hardcoded `root`/`admin` name check with the real ACL
 * signal: a role is admin-equivalent if it is `root`, or its ACL strategy has
 * `allowConfigure` (the same flag core uses to gate system configuration).
 * This way custom admin roles are recognized, and a non-privileged role that
 * merely happens to be named "admin" is not.
 */
export function isAdmin(ctx: Context, roles: string[]): boolean {
  if (roles.includes(ADMIN_ROOT_ROLE)) {
    return true;
  }
  const acl = (ctx as any).app?.acl;
  if (acl?.getRole) {
    for (const name of roles) {
      try {
        const strategy = acl.getRole(name)?.getStrategy?.();
        if (strategy?.allowConfigure) {
          return true;
        }
      } catch {
        // ignore — role may not be registered in ACL
      }
    }
  }
  return false;
}

/** @deprecated kept for callers that only have a role array. Prefer `isAdmin(ctx, roles)`. */
export function isAdminRole(roles: string[]): boolean {
  return roles.includes(ADMIN_ROOT_ROLE) || roles.includes('admin');
}

export function sameId(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

export function normalizeRoles(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((role) => role != null && role !== '').map(String);
}

export function normalizeAgents(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((agent) => agent != null && agent !== '').map(String);
}

export function hasAnyRole(allowedRoles: unknown, currentRoles: string[]): boolean {
  const allowed = normalizeRoles(allowedRoles);
  if (!allowed.length || !currentRoles.length) {
    return false;
  }
  return currentRoles.some((role) => allowed.includes(role));
}

export function getKnowledgeBaseAccessLevel(kbData: any): KnowledgeBaseAccessLevel {
  if (kbData?.accessLevel === 'BASIC' || kbData?.accessLevel === 'SHARED') {
    return kbData.accessLevel;
  }
  return 'PUBLIC';
}

export function getKnowledgeBaseAgentAccess(kbData: any): KnowledgeBaseAgentAccess {
  if (kbData?.agentAccess === 'explicit' || kbData?.agentAccess === 'none') {
    return kbData.agentAccess;
  }
  return 'inherit';
}

// ── Agent identity ────────────────────────────────────────────────────────────

/**
 * The AI Employee username running the current tool call, if any.
 *
 * AgentHarness sets `ctx._currentAIEmployee` / `ctx.state.currentAIEmployee`
 * around every tool invocation, and the orchestrator trace context carries
 * `employeeUsername` deeper in a delegation chain.
 */
export function getCurrentAgentUsername(ctx: any): string | undefined {
  const traceCtx = ctx?.['__orchestratorTraceContext'] || ctx?.state?.orchestratorTraceContext;
  const raw =
    ctx?._currentAIEmployee ||
    ctx?.state?.currentAIEmployee ||
    traceCtx?.employeeUsername ||
    ctx?.runtime?.context?.orchestratorTraceContext?.employeeUsername;

  if (!raw) return undefined;
  if (typeof raw === 'string') return raw;
  return raw.username || raw.name || undefined;
}

/**
 * Resolved access context for the current request. Computing this once (and
 * resolving the agent's roles from the DB at most once) keeps the per-row
 * permission checks synchronous and avoids N+1 queries while listing.
 */
export interface KbAccessContext {
  userId?: string;
  userRoles: string[];
  isAdmin: boolean;
  hasUser: boolean;
  isAgentRun: boolean;
  agentUsername?: string;
  agentRoles: string[];
}

/**
 * Build the resolved access context for `ctx`.
 *
 * `db` is required to resolve an agent's roles (the `aiEmployees.roles`
 * belongsToMany relation). When omitted, agent roles default to empty — explicit
 * role-based agent grants then fall back to the `allowedAgents` username list.
 */
export async function resolveAccessContext(ctx: Context, db?: any): Promise<KbAccessContext> {
  const userId = getAuthUserId(ctx);
  const userRoles = getCurrentRoles(ctx);
  const admin = isAdmin(ctx, userRoles);
  const agentUsername = getCurrentAgentUsername(ctx);

  let agentRoles: string[] = [];
  if (agentUsername && db) {
    try {
      const repo = db.getRepository('aiEmployees');
      const employee = await repo?.findOne?.({
        filterByTk: agentUsername,
        appends: ['roles'],
      });
      const roles = employee?.get?.('roles') ?? employee?.roles;
      if (Array.isArray(roles)) {
        agentRoles = roles
          .map((r: any) => (typeof r === 'string' ? r : r?.name))
          .filter((n: any) => Boolean(n))
          .map(String);
      }
    } catch {
      // ignore — agent may have no roles relation synced
    }
  }

  return {
    userId,
    userRoles,
    isAdmin: admin,
    hasUser: Boolean(userId),
    isAgentRun: Boolean(agentUsername),
    agentUsername,
    agentRoles,
  };
}

// ── User-side gates ────────────────────────────────────────────────────────────

function userCanRead(access: KbAccessContext, kbData: any): boolean {
  if (access.isAdmin) {
    return true;
  }
  const level = getKnowledgeBaseAccessLevel(kbData);
  if (level === 'PUBLIC') {
    return true;
  }
  if (level === 'BASIC') {
    return sameId(kbData?.ownerId, access.userId);
  }
  return hasAnyRole(kbData?.allowedRoles, access.userRoles);
}

function userCanManage(access: KbAccessContext, kbData: any): boolean {
  if (access.isAdmin) {
    return true;
  }
  const level = getKnowledgeBaseAccessLevel(kbData);
  if (level === 'BASIC') {
    return sameId(kbData?.ownerId, access.userId);
  }
  if (level === 'SHARED') {
    return hasAnyRole(kbData?.allowedRoles, access.userRoles);
  }
  return false;
}

// ── Agent-side gate ─────────────────────────────────────────────────────────────

/**
 * Whether the running agent is itself permitted to reach this KB, independent
 * of the triggering user. Returns true when no agent is running.
 */
function agentCanAccess(access: KbAccessContext, kbData: any): boolean {
  if (!access.isAgentRun) {
    return true;
  }
  const mode = getKnowledgeBaseAgentAccess(kbData);
  if (mode === 'none') {
    return false;
  }
  if (mode === 'inherit') {
    return true;
  }
  // explicit: agent must be named, or hold a listed role.
  const allowedAgents = normalizeAgents(kbData?.allowedAgents);
  if (access.agentUsername && allowedAgents.includes(access.agentUsername)) {
    return true;
  }
  return hasAnyRole(kbData?.allowedRoles, access.agentRoles);
}

// ── Combined gates (intersection: user AND agent) ───────────────────────────────

/**
 * Read/use permission.
 *
 * - Direct user/admin request: user-side gate only.
 * - Agent run with a user: intersection — both the user AND the agent must pass.
 * - Autonomous agent run (no user): agent-side gate only.
 */
export function canReadKnowledgeBase(access: KbAccessContext, kbData: any): boolean {
  if (!access.isAgentRun) {
    return userCanRead(access, kbData);
  }
  if (!agentCanAccess(access, kbData)) {
    return false;
  }
  if (access.hasUser) {
    return userCanRead(access, kbData);
  }
  return true;
}

/**
 * Manage (write/delete/upload) permission, with the same intersection rules.
 */
export function canManageKnowledgeBase(access: KbAccessContext, kbData: any): boolean {
  if (!access.isAgentRun) {
    return userCanManage(access, kbData);
  }
  if (!agentCanAccess(access, kbData)) {
    return false;
  }
  if (access.hasUser) {
    return userCanManage(access, kbData);
  }
  return true;
}

// ── List/search filter ──────────────────────────────────────────────────────────

function buildUserClause(access: KbAccessContext): Record<string, any> | null {
  if (access.isAdmin) {
    return null; // no user-side constraint
  }
  const or: Record<string, any>[] = [{ accessLevel: 'PUBLIC' }];
  if (access.userId) {
    or.push({ accessLevel: 'BASIC', ownerId: access.userId });
  }
  if (access.userRoles.length) {
    or.push({ accessLevel: 'SHARED', 'allowedRoles.$anyOf': access.userRoles });
  }
  return { $or: or };
}

function buildAgentClause(access: KbAccessContext): Record<string, any> {
  // inherit rows always pass the agent gate; explicit rows pass only when the
  // agent is named or holds a listed role; none rows never match.
  const or: Record<string, any>[] = [{ agentAccess: 'inherit' }];

  const explicitOr: Record<string, any>[] = [];
  if (access.agentUsername) {
    explicitOr.push({ allowedAgents: { $anyOf: [access.agentUsername] } });
  }
  if (access.agentRoles.length) {
    explicitOr.push({ 'allowedRoles.$anyOf': access.agentRoles });
  }
  if (explicitOr.length) {
    or.push({ $and: [{ agentAccess: 'explicit' }, { $or: explicitOr }] });
  }

  return { $or: or };
}

/**
 * Build a repository filter that returns only the KBs the current principal may
 * read. Encodes the same intersection logic as `canReadKnowledgeBase` so list
 * and search stay consistent with per-row checks.
 */
export function buildAccessibleKnowledgeBaseFilter(access: KbAccessContext, ids?: string[]): Record<string, any> {
  const and: Record<string, any>[] = [{ enabled: true }];
  if (ids?.length) {
    and.push({ id: { $in: ids } });
  }

  const userClause = access.isAgentRun && !access.hasUser ? null : buildUserClause(access);
  if (userClause) {
    and.push(userClause);
  }

  if (access.isAgentRun) {
    and.push(buildAgentClause(access));
  }

  return and.length === 1 ? and[0] : { $and: and };
}
