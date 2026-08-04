import type { Context } from '@nocobase/actions';
import { ZodError } from 'zod';
import { currentUserId, isAdminUser } from '../utils/ctx-utils';
import { LoopRunAccessError } from '../services/LoopRunRepository';

export type RequestActor = {
  userId: number;
  isAdmin: boolean;
};

export function requestActor(ctx: Context): RequestActor {
  const userId = Number(currentUserId(ctx));
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new LoopRunAccessError(401, 'Authentication is required.');
  }
  return { userId, isAdmin: isAdminUser(ctx) };
}

export function requireAdminActor(ctx: Context) {
  const actor = requestActor(ctx);
  if (!actor.isAdmin) throw new LoopRunAccessError(403, 'Administrator access is required.');
  return actor;
}

export function throwResourceError(ctx: Context, error: unknown): never {
  if (error instanceof LoopRunAccessError) {
    ctx.throw(error.status, error.message);
  }
  if (error instanceof ZodError) {
    ctx.throw(400, error.issues.map((issue) => issue.message).join(' '));
  }
  ctx.throw(409, error instanceof Error ? error.message : 'The requested operation could not be completed.');
}
