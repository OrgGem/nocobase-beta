export type RollingRestartMode = 'soft' | 'hard';
export type RollingRestartRole = 'app' | 'worker' | 'sandbox';

export interface RollingRestartNode {
  id: string;
  generationId?: string;
  name?: string;
  hostname?: string;
  role: RollingRestartRole;
  status?: string;
  lastHeartbeatAt?: number;
  url?: string | null;
  probeUrl?: string | null;
  appPort?: string;
}

export type RollingRestartErrorCode = 'generation-unavailable' | 'no-ready-peer' | 'node-recovery-timeout';

export class RollingRestartError extends Error {
  constructor(
    public readonly code: RollingRestartErrorCode,
    public readonly node?: RollingRestartNode,
  ) {
    super(code);
    this.name = 'RollingRestartError';
  }
}

export interface RollingRestartDependencies {
  listNodes: () => Promise<RollingRestartNode[]>;
  probeNode: (node: RollingRestartNode) => Promise<boolean>;
  restartNode: (node: RollingRestartNode, mode: RollingRestartMode, restartId: string) => Promise<void>;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
}

export interface RollingRestartOptions {
  restartId: string;
  mode: RollingRestartMode;
  nodes: RollingRestartNode[];
  coordinatorId: string;
  stabilizationMs: number;
  recoveryTimeoutMs: number;
  pollIntervalMs: number;
  heartbeatMaxAgeMs: number;
}

export interface RestartedNodeResult {
  id: string;
  name?: string;
  hostname?: string;
  role: RollingRestartRole;
  mode: RollingRestartMode;
  generationId: string;
  restartedAt: string;
  readyAt: string;
}

export interface RollingRestartResult {
  published: RestartedNodeResult[];
  coordinator?: RollingRestartNode;
}

function isFreshOnline(node: RollingRestartNode, now: number, heartbeatMaxAgeMs: number): boolean {
  if (node.status === 'offline' || !node.lastHeartbeatAt) return false;
  return now - node.lastHeartbeatAt <= heartbeatMaxAgeMs;
}

function matchesNode(candidate: RollingRestartNode, target: RollingRestartNode): boolean {
  if (candidate.hostname && target.hostname) {
    return candidate.hostname === target.hostname && candidate.role === target.role;
  }
  return candidate.id === target.id;
}

function orderNodes(nodes: RollingRestartNode[], coordinatorId: string): RollingRestartNode[] {
  return [...nodes].sort((left, right) => {
    if (left.id === coordinatorId) return 1;
    if (right.id === coordinatorId) return -1;
    return String(left.name || left.hostname || left.id).localeCompare(
      String(right.name || right.hostname || right.id),
    );
  });
}

async function hasReadyAppPeer(
  target: RollingRestartNode,
  options: RollingRestartOptions,
  dependencies: RollingRestartDependencies,
): Promise<boolean> {
  const now = dependencies.now();
  const peers = (await dependencies.listNodes()).filter(
    (node) => node.role === 'app' && !matchesNode(node, target) && isFreshOnline(node, now, options.heartbeatMaxAgeMs),
  );

  for (const peer of peers) {
    if (await dependencies.probeNode(peer)) return true;
  }
  return false;
}

async function waitForReplacement(
  target: RollingRestartNode,
  previousGenerationId: string,
  restartedAt: number,
  options: RollingRestartOptions,
  dependencies: RollingRestartDependencies,
): Promise<RollingRestartNode> {
  const deadline = restartedAt + options.recoveryTimeoutMs;

  while (dependencies.now() <= deadline) {
    const now = dependencies.now();
    const replacement = (await dependencies.listNodes()).find(
      (node) =>
        matchesNode(node, target) &&
        node.generationId !== undefined &&
        node.generationId !== previousGenerationId &&
        isFreshOnline(node, now, options.heartbeatMaxAgeMs),
    );

    if (replacement && (await dependencies.probeNode(replacement))) {
      if (options.stabilizationMs > 0) {
        await dependencies.sleep(options.stabilizationMs);
      }

      const stableNow = dependencies.now();
      const stableReplacement = (await dependencies.listNodes()).find(
        (node) =>
          matchesNode(node, replacement) &&
          node.generationId === replacement.generationId &&
          isFreshOnline(node, stableNow, options.heartbeatMaxAgeMs),
      );
      if (stableReplacement && (await dependencies.probeNode(stableReplacement))) {
        return stableReplacement;
      }
    }

    await dependencies.sleep(options.pollIntervalMs);
  }

  throw new RollingRestartError('node-recovery-timeout', target);
}

export async function runRollingRestartSequence(
  options: RollingRestartOptions,
  dependencies: RollingRestartDependencies,
): Promise<RollingRestartResult> {
  const orderedNodes = orderNodes(options.nodes, options.coordinatorId);
  const coordinator = orderedNodes.find((node) => node.id === options.coordinatorId);
  const remoteNodes = orderedNodes.filter((node) => node.id !== options.coordinatorId);
  const published: RestartedNodeResult[] = [];

  for (const target of remoteNodes) {
    if (!target.generationId) {
      throw new RollingRestartError('generation-unavailable', target);
    }
    if (target.role === 'app' && !(await hasReadyAppPeer(target, options, dependencies))) {
      throw new RollingRestartError('no-ready-peer', target);
    }

    const restartedAt = dependencies.now();
    await dependencies.restartNode(target, options.mode, options.restartId);
    const replacement = await waitForReplacement(target, target.generationId, restartedAt, options, dependencies);

    published.push({
      id: replacement.id,
      name: replacement.name,
      hostname: replacement.hostname,
      role: replacement.role,
      mode: options.mode,
      generationId: replacement.generationId as string,
      restartedAt: new Date(restartedAt).toISOString(),
      readyAt: new Date(dependencies.now()).toISOString(),
    });
  }

  if (coordinator?.role === 'app' && !(await hasReadyAppPeer(coordinator, options, dependencies))) {
    throw new RollingRestartError('no-ready-peer', coordinator);
  }

  return { published, coordinator };
}
