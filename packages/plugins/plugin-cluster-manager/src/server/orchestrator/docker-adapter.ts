/**
 * Docker Adapter — MVP implementation
 *
 * Uses dockerode to communicate with the Docker daemon via unix socket.
 * Containers are tagged with label `orchestrator.stack=<stackName>` for identification.
 *
 * Security: Docker socket = root on host. Only admin users should access
 * orchestrator actions (enforced by ACL in plugin.ts).
 */

import type { IOrchestratorAdapter, ContainerInfo, ScaleResult, ContainerStats, StackConfig } from './types';

// Lazy-load dockerode to avoid hard dependency when adapter is not used
let Dockerode: any;
function getDockerode() {
  if (!Dockerode) {
    try {
      Dockerode = require('dockerode');
    } catch {
      throw new Error(
        '[DockerAdapter] "dockerode" package not found. Install it: yarn add dockerode',
      );
    }
  }
  return Dockerode;
}

const LABEL_STACK = 'orchestrator.stack';
const LABEL_MANAGED = 'orchestrator.managed';

export class DockerAdapter implements IOrchestratorAdapter {
  readonly name = 'docker';
  private docker: any;
  private workerLabels: Record<string, string>;

  constructor(options?: { socketPath?: string; host?: string; port?: number; workerLabelSelector?: string }) {
    const Docker = getDockerode();
    if (options?.host) {
      this.docker = new Docker({ host: options.host, port: options.port || 2376 });
    } else {
      this.docker = new Docker({
        socketPath: options?.socketPath || '/var/run/docker.sock',
      });
    }
    this.workerLabels = this.parseLabelSelector(options?.workerLabelSelector);
  }

  async ping(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  async listContainers(stack: StackConfig): Promise<ContainerInfo[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: {
        label: [
          `${LABEL_STACK}=${stack.name}`,
          `${LABEL_MANAGED}=true`,
          ...this.buildLabelFilters(this.workerLabels),
        ],
      },
    });

    return containers.map((c: any) => ({
      id: c.Id.substring(0, 12),
      name: (c.Names[0] || '').replace(/^\//, ''),
      status: this.mapState(c.State),
      image: c.Image,
      createdAt: new Date(c.Created * 1000),
      labels: c.Labels || {},
    }));
  }

  async assertManagedByStack(stack: StackConfig, containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    const info = await container.inspect();
    const labels = info?.Config?.Labels || {};

    if (labels[LABEL_MANAGED] !== 'true' || labels[LABEL_STACK] !== stack.name) {
      throw new Error(`Container ${containerId} is not managed by stack "${stack.name}"`);
    }

    if (!this.labelsMatch(labels, this.workerLabels)) {
      throw new Error(`Container ${containerId} does not match the configured worker label selector`);
    }
  }

  async scale(stack: StackConfig, replicas: number): Promise<ScaleResult> {
    const current = await this.listContainers(stack);
    const running = current.filter((c) => c.status === 'running');
    const diff = replicas - running.length;

    const result: ScaleResult = {
      previousReplicas: running.length,
      currentReplicas: replicas,
      containersCreated: [],
      containersRemoved: [],
    };

    if (diff > 0) {
      // Scale UP
      let targetNetworks = stack.networks && stack.networks.length > 0 ? stack.networks : [];
      let targetNetworkMode = stack.networkMode;
      let targetEnvVars = this.buildEnvArray(stack.envVars);
      let targetVolumes = stack.volumes || [];

      // Auto-detect current container's configuration to inherit networks and env vars
      try {
        const os = require('os');
        const myContainerId = os.hostname();
        const myContainer = this.docker.getContainer(myContainerId);
        const myInfo = await myContainer.inspect();
        
        // Inherit Networks if none specified
        if (!targetNetworkMode && targetNetworks.length === 0) {
          if (myInfo?.NetworkSettings?.Networks) {
            targetNetworks = Object.keys(myInfo.NetworkSettings.Networks);
          }
        }
        
        // Inherit Environment Variables and merge with stack.envVars
        if (myInfo?.Config?.Env) {
           const envDict: Record<string, string> = {};
           myInfo.Config.Env.forEach((e: string) => {
             const idx = e.indexOf('=');
             if (idx !== -1) {
               envDict[e.substring(0, idx)] = e.substring(idx + 1);
             }
           });
           // Overwrite with explicitly defined env vars
           Object.assign(envDict, stack.envVars || {});
           targetEnvVars = Object.entries(envDict).map(([k, v]) => `${k}=${v}`);
        }

        // Inherit Volumes (Binds)
        if (myInfo?.HostConfig?.Binds) {
          const inheritedBinds = myInfo.HostConfig.Binds as string[];
          targetVolumes = Array.from(new Set([...inheritedBinds, ...targetVolumes]));
        }
      } catch (e) {
        // Ignore error if not running in a container or cannot inspect
      }

      for (let i = 0; i < diff; i++) {
        const suffix = `${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
        const containerName = `${stack.name}-${suffix}`;

        const createOpts: any = {
          Image: stack.image,
          name: containerName,
          Env: targetEnvVars,
          Labels: {
            [LABEL_STACK]: stack.name,
            [LABEL_MANAGED]: 'true',
            ...this.workerLabels,
          },
          HostConfig: {
            Binds: targetVolumes,
            RestartPolicy: { Name: stack.restartPolicy || 'unless-stopped' },
          },
        };

        if (stack.command) {
          createOpts.Cmd = ['/bin/sh', '-c', stack.command];
        }

        if (stack.resourceLimits?.memory) {
          createOpts.HostConfig.Memory = this.parseMemory(stack.resourceLimits.memory);
        }

        if (targetNetworkMode) {
          createOpts.HostConfig.NetworkMode = targetNetworkMode;
        } else if (targetNetworks.length > 0) {
          createOpts.HostConfig.NetworkMode = targetNetworks[0];
        }

        // Security hardening
        createOpts.HostConfig.SecurityOpt = ['no-new-privileges:true'];

        const container = await this.docker.createContainer(createOpts);
        
        // Connect to additional networks before starting
        if (!targetNetworkMode && targetNetworks.length > 1) {
          for (let i = 1; i < targetNetworks.length; i++) {
            try {
              const net = this.docker.getNetwork(targetNetworks[i]);
              await net.connect({ Container: container.id });
            } catch (err: any) {
              console.warn(`[DockerAdapter] Failed to connect container ${container.id} to network ${targetNetworks[i]}: ${err.message}`);
            }
          }
        }

        await container.start();
        result.containersCreated!.push(container.id.substring(0, 12));
      }
    } else if (diff < 0) {
      // Scale DOWN — remove newest first (LIFO)
      const sorted = running.sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      );
      const toRemove = sorted.slice(0, Math.abs(diff));

      for (const c of toRemove) {
        try {
          const container = this.docker.getContainer(c.id);
          await container.stop({ t: 10 }).catch(() => {});
          await container.remove({ force: true });
          result.containersRemoved!.push(c.id);
        } catch (err: any) {
          // Container may already be gone
          result.containersRemoved!.push(`${c.id} (error: ${err.message})`);
        }
      }
    }

    return result;
  }

  async startContainer(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.start();
  }

  async stopContainer(containerId: string, timeoutSecs = 10): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.stop({ t: timeoutSecs });
  }

  async removeContainer(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.stop({ t: 5 }).catch(() => {});
    await container.remove({ force: true });
  }

  async getStats(containerId: string): Promise<ContainerStats> {
    const container = this.docker.getContainer(containerId);
    const stats = await container.stats({ stream: false });

    // Calculate CPU usage percentage
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const numCpus = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;
    const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;

    // Memory
    const memUsage = stats.memory_stats.usage || 0;
    const memLimit = stats.memory_stats.limit || 0;

    // Network
    let netRx = 0;
    let netTx = 0;
    if (stats.networks) {
      for (const iface of Object.values(stats.networks) as any[]) {
        netRx += iface.rx_bytes || 0;
        netTx += iface.tx_bytes || 0;
      }
    }

    return {
      cpu: Math.round(cpuPercent * 100) / 100,
      memory: memUsage,
      memoryLimit: memLimit,
      networkRx: netRx,
      networkTx: netTx,
    };
  }

  async getLogs(containerId: string, tail = 200): Promise<string> {
    const container = this.docker.getContainer(containerId);
    const logBuffer = await container.logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps: true,
    });

    // Docker logs come with 8-byte header per frame; strip them
    return this.demuxDockerLogs(logBuffer);
  }

  // ─── Private helpers ───

  private mapState(state: string): ContainerInfo['status'] {
    switch (state) {
      case 'running':
        return 'running';
      case 'created':
        return 'creating';
      case 'exited':
      case 'dead':
        return 'exited';
      case 'paused':
      case 'restarting':
        return 'stopped';
      default:
        return 'error';
    }
  }

  private buildEnvArray(envVars?: Record<string, string>): string[] {
    if (!envVars) return [];
    return Object.entries(envVars).map(([k, v]) => `${k}=${v}`);
  }

  private buildLabelFilters(labels: Record<string, string>): string[] {
    return Object.entries(labels).map(([k, v]) => `${k}=${v}`);
  }

  private parseLabelSelector(selector?: string): Record<string, string> {
    if (!selector?.trim()) return {};
    return selector
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .reduce((acc, part) => {
        const [key, ...valueParts] = part.split('=');
        const value = valueParts.join('=');
        if (key?.trim() && value?.trim()) {
          acc[key.trim()] = value.trim();
        }
        return acc;
      }, {} as Record<string, string>);
  }

  private labelsMatch(labels: Record<string, string>, expected: Record<string, string>): boolean {
    return Object.entries(expected).every(([k, v]) => labels[k] === v);
  }

  private parseMemory(mem?: string): number | undefined {
    if (!mem) return undefined;
    const match = mem.match(/^(\d+)(Mi|Gi|Ki)?$/i);
    if (!match) return undefined;
    const val = parseInt(match[1], 10);
    const unit = (match[2] || 'Mi').toLowerCase();
    switch (unit) {
      case 'ki':
        return val * 1024;
      case 'mi':
        return val * 1024 * 1024;
      case 'gi':
        return val * 1024 * 1024 * 1024;
      default:
        return val * 1024 * 1024;
    }
  }

  private demuxDockerLogs(buffer: Buffer | string): string {
    if (typeof buffer === 'string') return buffer;

    const lines: string[] = [];
    let offset = 0;
    while (offset < buffer.length) {
      if (offset + 8 > buffer.length) break;
      const size = buffer.readUInt32BE(offset + 4);
      offset += 8;
      if (offset + size > buffer.length) break;
      lines.push(buffer.toString('utf8', offset, offset + size).trimEnd());
      offset += size;
    }
    return lines.join('\n');
  }
}
