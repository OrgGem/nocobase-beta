import { Context } from '@nocobase/actions';

/**
 * Access control for aiDiagrams, mirroring the two-dimensional model used by
 * plugin-knowledge-base (see plugin-knowledge-base/src/server/utils/access.ts):
 *
 *   user dimension  — BASIC (owner-only) | SHARED (role-based) | PUBLIC (all)
 *   agent dimension — inherit | explicit | none
 *
 * For agent runs the two gates intersect: both the triggering user AND the
 * running AI Employee must pass. An autonomous agent run (no user) is gated by
 * the agent dimension alone.
 */

export type DiagramAccessLevel = 'BASIC' | 'SHARED' | 'PUBLIC';
export type DiagramAgentAccess = 'inherit' | 'explicit' | 'none';

const ADMIN_ROOT_ROLE = 'root';

export function getAuthUserId(ctx: Context): string | undefined {
  const id = (ctx as any).auth?.user?.id ?? (ctx as any).state?.currentUser?.id;
  return id == null ? undefined : String(id);
}

/**
 * Roles active for this request. Prefer the role(s) resolved by NocoBase v2's
 * setCurrentRole middleware (honors the X-Role header and union-role mode),
 * falling back to all assigned roles for internal/system calls.
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
 * A role is admin-equivalent if it is `root` or its ACL strategy has
 * `allowConfigure` — the same signal core uses to gate system configuration.
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
        // role may not be registered in ACL
      }
    }
  }
  return false;
}

export function sameId(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

export function normalizeRoles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((role) => role != null && role !== '').map(String);
}

export function normalizeAgents(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((agent) => agent != null && agent !== '').map(String);
}

export function hasAnyRole(allowedRoles: unknown, currentRoles: string[]): boolean {
  const allowed = normalizeRoles(allowedRoles);
  if (!allowed.length || !currentRoles.length) return false;
  return currentRoles.some((role) => allowed.includes(role));
}

export function getDiagramAccessLevel(data: any): DiagramAccessLevel {
  if (data?.accessLevel === 'SHARED' || data?.accessLevel === 'PUBLIC') {
    return data.accessLevel;
  }
  return 'BASIC';
}

export function getDiagramAgentAccess(data: any): DiagramAgentAccess {
  if (data?.agentAccess === 'explicit' || data?.agentAccess === 'none') {
    return data.agentAccess;
  }
  return 'inherit';
}

// ── Agent identity ───────────────────────────────────────────────────────────

/**
 * The AI Employee username running the current tool call, if any.
 *
 * AgentHarness sets `ctx._currentAIEmployee` / `ctx.state.currentAIEmployee`
 * around every tool invocation; the orchestrator trace context carries
 * `employeeUsername` deeper in a delegation chain.
 */
export function getCurrentAgentUsername(ctx: any): string | undefined {
  const traceCtx = ctx?.['__orchestratorTraceContext'] || ctx?.state?.orchestratorTraceContext;
  const raw =
    ctx?._currentAIEmployee ||
    ctx?.state?.currentAIEmployee ||
    ctx?.runtime?.context?.currentAIEmployee ||
    traceCtx?.employeeUsername ||
    ctx?.runtime?.context?.orchestratorTraceContext?.employeeUsername;

  if (!raw) return undefined;
  if (typeof raw === 'string') return raw;
  return raw.username || raw.name || undefined;
}

export interface DiagramAccessContext {
  userId?: string;
  userRoles: string[];
  isAdmin: boolean;
  hasUser: boolean;
  isAgentRun: boolean;
  agentUsername?: string;
  agentRoles: string[];
}

/**
 * Build the resolved access context for `ctx`. `db` resolves the running
 * agent's roles (via the `aiEmployees.roles` relation). When omitted, agent
 * role grants fall back to the `allowedAgents` username list.
 */
export async function resolveAccessContext(ctx: Context, db?: any): Promise<DiagramAccessContext> {
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
      // agent may have no roles relation synced
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

function userCanRead(access: DiagramAccessContext, data: any): boolean {
  if (access.isAdmin) return true;
  const level = getDiagramAccessLevel(data);
  if (level === 'PUBLIC') return true;
  if (level === 'BASIC') return sameId(data?.createdById, access.userId);
  return hasAnyRole(data?.allowedRoles, access.userRoles);
}

function userCanManage(access: DiagramAccessContext, data: any): boolean {
  if (access.isAdmin) return true;
  const level = getDiagramAccessLevel(data);
  if (level === 'BASIC') return sameId(data?.createdById, access.userId);
  if (level === 'SHARED') return hasAnyRole(data?.allowedRoles, access.userRoles);
  return false;
}

// ── Agent-side gate ─────────────────────────────────────────────────────────────

function agentCanAccess(access: DiagramAccessContext, data: any): boolean {
  if (!access.isAgentRun) return true;
  const mode = getDiagramAgentAccess(data);
  if (mode === 'none') return false;
  if (mode === 'inherit') return true;
  const allowedAgents = normalizeAgents(data?.allowedAgents);
  if (access.agentUsername && allowedAgents.includes(access.agentUsername)) return true;
  return hasAnyRole(data?.allowedRoles, access.agentRoles);
}

// ── Combined gates (intersection: user AND agent) ───────────────────────────────

export function canReadDiagram(access: DiagramAccessContext, data: any): boolean {
  if (!access.isAgentRun) return userCanRead(access, data);
  if (!agentCanAccess(access, data)) return false;
  if (access.hasUser) return userCanRead(access, data);
  return true;
}

/**
 * Whether the principal may write the diagram's *content* (the XML on the
 * canvas). A draw.io block is an interactive editor: anyone who can open it
 * (read access) may edit its content, and that edit is persisted via saveXml.
 * The AI Employee's display/edit/append tools run client-side in the user's
 * session and persist through this same path, so aligning content-write with
 * read access is what lets the agent edit the *open* canvas in place.
 *
 * The per-diagram `mode === 'readonly'` flag is the separate content lock,
 * enforced in saveXml. Changing the access *policy* (accessLevel, roles, agent
 * grants) or deleting a diagram is a management operation gated by
 * canManageDiagram in the resource CRUD — not here.
 */
export function canWriteDiagramContent(access: DiagramAccessContext, data: any): boolean {
  return canReadDiagram(access, data);
}

export function canManageDiagram(access: DiagramAccessContext, data: any): boolean {
  if (!access.isAgentRun) return userCanManage(access, data);
  if (!agentCanAccess(access, data)) return false;
  if (access.hasUser) return userCanManage(access, data);
  return true;
}

// ── List/search filter ──────────────────────────────────────────────────────────

function buildUserClause(access: DiagramAccessContext): Record<string, any> | null {
  if (access.isAdmin) return null;
  const or: Record<string, any>[] = [{ accessLevel: 'PUBLIC' }];
  if (access.userId) {
    or.push({ accessLevel: 'BASIC', createdById: access.userId });
  }
  if (access.userRoles.length) {
    or.push({ accessLevel: 'SHARED', 'allowedRoles.$anyOf': access.userRoles });
  }
  return { $or: or };
}

function buildAgentClause(access: DiagramAccessContext): Record<string, any> {
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
 * Repository filter returning only the diagrams the current principal may read.
 * Encodes the same intersection logic as `canReadDiagram` so list stays
 * consistent with per-row checks. BASIC rows with no owner are treated as
 * legacy/admin-created and remain visible only to admins (no clause matches).
 */
export function buildAccessibleDiagramFilter(access: DiagramAccessContext, ids?: string[]): Record<string, any> {
  const and: Record<string, any>[] = [];
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

  if (!and.length) return {};
  return and.length === 1 ? and[0] : { $and: and };
}

// ── Per-row assertion helpers (used by custom actions) ──────────────────────────

export function assertDiagramRead(ctx: Context, access: DiagramAccessContext, data: any) {
  if (!canReadDiagram(access, data)) {
    ctx.throw(403, 'You do not have permission to access this diagram');
  }
}

/**
 * Gate for writing diagram *content* (saveXml). Aligned with read access so
 * that any principal who can open the block — including the AI Employee's
 * client-side display/edit/append tools running in the user's session — can
 * persist edits to the canvas that is already open, without opening a new one.
 */
export function assertDiagramWriteContent(ctx: Context, access: DiagramAccessContext, data: any) {
  if (!access.hasUser && !access.isAgentRun) {
    ctx.throw(401, 'Login required');
  }
  if (!canWriteDiagramContent(access, data)) {
    ctx.throw(403, 'You do not have permission to access this diagram');
  }
}

export function assertDiagramManage(ctx: Context, access: DiagramAccessContext, data: any) {
  if (!access.hasUser && !access.isAgentRun) {
    ctx.throw(401, 'Login required');
  }
  if (!canManageDiagram(access, data)) {
    ctx.throw(403, 'You do not have permission to access this diagram');
  }
}
