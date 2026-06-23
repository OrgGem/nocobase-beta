import os from 'os';
import { isWorkerOnlyMode, normalizeWorkerMode } from '../../shared/worker-processes';

export type NodeRole = 'app' | 'worker' | 'sandbox';

/**
 * Determine whether a WORKER_MODE value denotes a queue-processing worker
 * (i.e. a node that does NOT serve HTTP), following NocoBase v2.1.x semantics:
 *   ''            → app node (serves HTTP + every queue)
 *   '!'           → app node (serves HTTP only)
 *   '*'           → worker (serves all queues, no HTTP)
 *   'a:b,c:d'     → worker (serves the listed queue topics, no HTTP)
 *   '-'           → transient subprocess (not a long-lived worker)
 * Legacy literals 'worker' / 'task' are still tolerated for older deployments.
 * A combined value containing '!' (e.g. '!,workflow:process') still serves
 * HTTP, so it is treated as an app node.
 */
export function isWorkerMode(workerMode?: string): boolean {
  return isWorkerOnlyMode(workerMode ?? process.env.WORKER_MODE);
}

/**
 * Resolve a node role from its descriptor. APP_ROLE (explicit) wins, then an
 * explicit sandbox flag, then WORKER_MODE parsing. Works for both the local
 * process (pass process.env values) and remote node records read from Redis.
 */
export function getNodeRoleFrom(opts: { workerMode?: string; appRole?: string; isSandbox?: boolean }): NodeRole {
  if (opts.appRole === 'app' || opts.appRole === 'worker' || opts.appRole === 'sandbox') {
    return opts.appRole;
  }
  if (opts.isSandbox) return 'sandbox';
  return isWorkerMode(opts.workerMode) ? 'worker' : 'app';
}

/** Resolve the role of the current Node.js process from its environment. */
export function getLocalRole(): NodeRole {
  return getNodeRoleFrom({
    workerMode: process.env.WORKER_MODE,
    appRole: process.env.APP_ROLE,
    isSandbox: process.env.SKILL_HUB_SANDBOX === 'true',
  });
}

/**
 * Generate a universally unique identifier for this specific Node.js process.
 * Combines app name, worker mode, hostname, port, and PID to ensure uniqueness
 * even when multiple workers run on the exact same host.
 */
export function getLocalNodeId(app: any): string {
  const port = process.env.APP_PORT || 'unknown';
  const mode = normalizeWorkerMode(process.env.WORKER_MODE) || 'main';
  const appName = process.env.APP_NAME || app?.name || 'main';
  return `${appName}_${mode}_${os.hostname()}_${port}_${process.pid}`;
}
