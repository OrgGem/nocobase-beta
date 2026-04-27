import os from 'os';

/**
 * Generate a universally unique identifier for this specific Node.js process.
 * Combines app name, worker mode, hostname, port, and PID to ensure uniqueness
 * even when multiple workers run on the exact same host.
 */
export function getLocalNodeId(app: any): string {
  const port = process.env.APP_PORT || 'unknown';
  const mode = process.env.WORKER_MODE || 'main';
  const appName = process.env.APP_NAME || app?.name || 'main';
  return `${appName}_${mode}_${os.hostname()}_${port}_${process.pid}`;
}
