// ── Shared context/state utility functions ─────────────────────────────

/** Normalize a record to a plain JS object. */
export function toPlain(record: any) {
  return record?.toJSON?.() || record;
}

/** Coerce a value to a plain object (JSON parse if needed). */
export function asObject(value: any) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Coerce value to array. */
export function asArray(value: any): any[] {
  return Array.isArray(value) ? value : [];
}

/** Trim text to max length with ellipsis suffix. */
export function trimText(value: any, max = 50000) {
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else if (value != null) {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > max ? `${text.slice(0, max)}\n...[truncated]` : text;
}

/** Get the current user id from ctx. */
export function currentUserId(ctx: any) {
  return ctx?.state?.currentUser?.id || ctx?.auth?.user?.id;
}

/** Get action params values from ctx. */
export function valuesFromCtx(ctx: any) {
  return ctx?.action?.params?.values || ctx?.request?.body || {};
}

/** Normalize raw employee username input (string | object → string | null). */
export function normalizeEmployeeUsername(raw: any) {
  if (!raw) return null;
  if (typeof raw === 'string') return raw;
  return raw.username || raw.aiEmployeeUsername || raw.name || null;
}

/** Resolve session id from args or ctx. */
export function resolveSessionId(ctx: any, args: any) {
  const v = valuesFromCtx(ctx);
  return args?.sessionId || v.sessionId || ctx?.action?.params?.sessionId || ctx?.state?.sessionId;
}

/** Resolve message id from args or ctx. */
export function resolveMessageId(ctx: any, args: any) {
  const v = valuesFromCtx(ctx);
  return args?.messageId || v.messageId || ctx?.action?.params?.messageId;
}

/** Resolve leader employee username from args, ctx state, or conversation record. */
export async function resolveLeaderUsername(ctx: any, plugin: any, args: any) {
  const v = valuesFromCtx(ctx);
  const direct = normalizeEmployeeUsername(
    args?.leaderUsername ||
      ctx?._currentAIEmployee ||
      ctx?.state?.currentAIEmployee ||
      ctx?.runtime?.context?.currentAIEmployee ||
      v.aiEmployee,
  );
  if (direct) return direct;

  const sessionId = resolveSessionId(ctx, args);
  if (!sessionId) return undefined;
  try {
    const repo = ctx?.db?.getRepository?.('aiConversations') || plugin.db.getRepository('aiConversations');
    const conversation = await repo.findOne({ filter: { sessionId } });
    return normalizeEmployeeUsername(conversation?.aiEmployeeUsername || conversation?.get?.('aiEmployeeUsername'));
  } catch {
    return undefined;
  }
}

/** Snapshot ctx user id for later use (avoids stale ctx). */
export function captureCtxSnapshot(ctx: any): { userId?: number } {
  let userId: number | undefined;
  try {
    userId = ctx?.auth?.user?.id || ctx?.state?.currentUser?.id;
  } catch {
    // ctx already disposed
  }
  return { userId };
}

/** Normalize step type to a known value. */
export function normalizeStepType(value: any) {
  return ['reasoning', 'skill', 'tool', 'sub_agent', 'verification'].includes(value) ? value : 'tool';
}

/** Normalize plan key from step input. */
export function normalizePlanKey(step: any, index: number) {
  return String(step.planKey || step.key || step.id || `step_${index + 1}`);
}

/** Now ISO string. */
export function nowIso() {
  return new Date().toISOString();
}
