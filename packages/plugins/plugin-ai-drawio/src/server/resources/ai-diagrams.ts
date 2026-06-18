import { Context } from '@nocobase/actions';
import {
  buildAccessibleDiagramFilter,
  canManageDiagram,
  canReadDiagram,
  normalizeAgents,
  normalizeRoles,
  resolveAccessContext,
  type DiagramAccessContext,
} from '../actions/access';

const SUPPORTED_ACCESS_LEVELS = new Set(['BASIC', 'SHARED', 'PUBLIC']);
const SUPPORTED_AGENT_ACCESS = new Set(['inherit', 'explicit', 'none']);

function extractValues(ctx: Context): Record<string, any> {
  const raw = (ctx.action.params.values as any) || {};
  return raw.values ?? raw;
}

/**
 * Validate and normalize the row-level access policy on a diagram.
 * `existing` carries the persisted row so we can validate the effective state
 * after a partial update (e.g. switching to SHARED without re-sending roles).
 */
function normalizeDiagramValues(ctx: Context, values: Record<string, any>, existing?: any) {
  if (values.accessLevel && !SUPPORTED_ACCESS_LEVELS.has(values.accessLevel)) {
    ctx.throw(400, `Unsupported access level "${values.accessLevel}"`);
  }
  if (values.agentAccess && !SUPPORTED_AGENT_ACCESS.has(values.agentAccess)) {
    ctx.throw(400, `Unsupported agent access "${values.agentAccess}"`);
  }
  if (values.allowedRoles !== undefined) {
    values.allowedRoles = normalizeRoles(values.allowedRoles);
  }
  if (values.allowedAgents !== undefined) {
    values.allowedAgents = normalizeAgents(values.allowedAgents);
  }

  const effective = {
    ...(existing?.toJSON ? existing.toJSON() : existing ?? {}),
    ...values,
  };
  if (effective.accessLevel === 'SHARED' && normalizeRoles(effective.allowedRoles).length === 0) {
    ctx.throw(400, 'allowedRoles is required for shared diagrams');
  }
  if (
    effective.agentAccess === 'explicit' &&
    normalizeAgents(effective.allowedAgents).length === 0 &&
    normalizeRoles(effective.allowedRoles).length === 0
  ) {
    ctx.throw(400, 'allowedAgents or allowedRoles is required when agentAccess is "explicit"');
  }
}

/** Strip the access-policy fields a non-admin principal may not set. */
function stripPrivilegedFields(values: Record<string, any>) {
  delete values.accessLevel;
  delete values.allowedRoles;
  delete values.agentAccess;
  delete values.allowedAgents;
  delete values.createdById;
}

export default {
  name: 'aiDiagrams',
  actions: {
    async list(ctx: Context, next: Function) {
      const repo = ctx.db.getRepository('aiDiagrams');
      const { filter = {}, fields, sort, page, pageSize, appends } = ctx.action.params;

      const access = await resolveAccessContext(ctx, ctx.db);
      const effectiveFilter = access.isAdmin ? filter : { $and: [{ ...filter }, buildAccessibleDiagramFilter(access)] };

      const records = await repo.find({
        filter: effectiveFilter,
        fields,
        appends,
        sort: sort ?? ['-updatedAt'],
        limit: pageSize,
        offset: page ? (page - 1) * (pageSize || 20) : 0,
      });

      ctx.body = records;
      await next();
    },

    async get(ctx: Context, next: Function) {
      const { filterByTk, appends } = ctx.action.params;
      const repo = ctx.db.getRepository('aiDiagrams');
      const record = await repo.findOne({ filterByTk, appends });
      if (!record) {
        ctx.throw(404, 'Diagram not found');
        return;
      }
      const access = await resolveAccessContext(ctx, ctx.db);
      if (!canReadDiagram(access, record.toJSON())) {
        ctx.throw(403, 'You do not have permission to access this diagram');
        return;
      }
      ctx.body = record;
      await next();
    },

    async create(ctx: Context, next: Function) {
      const values = extractValues(ctx);
      const repo = ctx.db.getRepository('aiDiagrams');
      const access = await resolveAccessContext(ctx, ctx.db);

      if (!access.isAdmin) {
        // Members may only create personal (BASIC) diagrams; the access policy
        // (SHARED/PUBLIC, role/agent grants) remains an admin concern.
        if (values.accessLevel && values.accessLevel !== 'BASIC') {
          ctx.throw(403, 'Only administrators can create shared or public diagrams');
          return;
        }
        values.accessLevel = 'BASIC';
        stripPrivilegedFields(values);
      }

      if (!values.accessLevel) {
        values.accessLevel = 'BASIC';
      }
      normalizeDiagramValues(ctx, values);

      // BASIC diagrams are owned by their creator. createdById doubles as the
      // owner key for the user-side gate.
      if (access.userId) {
        values.createdById = access.userId;
        values.updatedById = access.userId;
      }

      const record = await repo.create({ values });
      ctx.body = record;
      await next();
    },

    async update(ctx: Context, next: Function) {
      const { filterByTk } = ctx.action.params;
      const values = extractValues(ctx);
      const repo = ctx.db.getRepository('aiDiagrams');

      const access = await resolveAccessContext(ctx, ctx.db);
      const existing = await repo.findOne({ filterByTk });
      if (!existing) {
        ctx.throw(404, 'Diagram not found');
        return;
      }
      if (!canManageDiagram(access, existing.toJSON())) {
        ctx.throw(403, 'You do not have permission to update this diagram');
        return;
      }

      if (!access.isAdmin) {
        stripPrivilegedFields(values);
      }
      normalizeDiagramValues(ctx, values, existing);

      if (access.userId) {
        values.updatedById = access.userId;
      }

      const updated = await repo.update({ filterByTk, values });
      ctx.body = updated;
      await next();
    },

    async destroy(ctx: Context, next: Function) {
      const { filterByTk } = ctx.action.params;
      const repo = ctx.db.getRepository('aiDiagrams');

      const access = await resolveAccessContext(ctx, ctx.db);
      const existing = await repo.findOne({ filterByTk });
      if (!existing) {
        ctx.throw(404, 'Diagram not found');
        return;
      }
      if (!canManageDiagram(access, existing.toJSON())) {
        ctx.throw(403, 'You do not have permission to delete this diagram');
        return;
      }

      await repo.destroy({ filterByTk });
      ctx.body = { success: true };
      await next();
    },
  },
};

export type { DiagramAccessContext };
