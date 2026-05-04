/**
 * Orchestrator Adapter Interface
 *
 * Abstraction layer for container runtimes (Docker, K8s, Swarm).
 * Each adapter implements this interface so the plugin logic is runtime-agnostic.
 */

export interface ContainerInfo {
  id: string;
  name: string;
  status: 'running' | 'stopped' | 'pending' | 'error' | 'creating' | 'exited';
  image: string;
  createdAt: Date;
  cpu?: number;
  memory?: number;
  labels?: Record<string, string>;
}

export interface ScaleResult {
  previousReplicas: number;
  currentReplicas: number;
  containersCreated?: string[];
  containersRemoved?: string[];
}

export interface ContainerStats {
  cpu: number;       // percentage 0-100
  memory: number;    // bytes
  memoryLimit: number;
  networkRx: number; // bytes
  networkTx: number; // bytes
}

export interface StackConfig {
  id?: number;
  name: string;
  adapter: 'docker' | 'kubernetes';
  image: string;
  command?: string;
  envVars?: Record<string, string>;
  volumes?: string[];
  networks?: string[];
  resourceLimits?: {
    memory?: string;  // "1536Mi" | "2Gi"
    cpu?: string;     // "1" | "500m"
  };
  replicas: number;
  desiredReplicas: number;
  enabled: boolean;
  // K8s specific
  namespace?: string;
  deploymentName?: string;
  serviceAccountName?: string;
  imagePullPolicy?: string;
  k8sContainerName?: string;
  k8sEnv?: Record<string, any>[];
  k8sEnvFrom?: Record<string, any>[];
  k8sVolumeMounts?: Record<string, any>[];
  k8sVolumes?: Record<string, any>[];
  // Docker specific
  networkMode?: string;
  restartPolicy?: string;
}

export interface IOrchestratorAdapter {
  /** Human-readable adapter name */
  readonly name: string;

  /** Test connectivity to the runtime */
  ping(): Promise<boolean>;

  /** List containers managed by a stack */
  listContainers(stack: StackConfig): Promise<ContainerInfo[]>;

  /** Verify that a runtime container/pod belongs to the requested stack */
  assertManagedByStack(stack: StackConfig, containerId: string): Promise<void>;

  /** Scale stack to N replicas */
  scale(stack: StackConfig, replicas: number): Promise<ScaleResult>;

  /** Start a stopped container */
  startContainer(containerId: string): Promise<void>;

  /** Gracefully stop a running container */
  stopContainer(containerId: string, timeoutSecs?: number): Promise<void>;

  /** Remove/delete a container (force) */
  removeContainer(containerId: string): Promise<void>;

  /** Get real-time resource stats for a container */
  getStats(containerId: string): Promise<ContainerStats>;

  /** Get tail logs from a container */
  getLogs(containerId: string, tail?: number): Promise<string>;
}
