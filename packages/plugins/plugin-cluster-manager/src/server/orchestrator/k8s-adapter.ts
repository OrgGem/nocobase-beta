/**
 * Kubernetes Adapter
 *
 * Manages worker Deployments/Pods via the K8s API using in-cluster ServiceAccount
 * or kubeconfig. Only manages resources labeled with `orchestrator.stack=<stackName>`.
 *
 * Prerequisites:
 *   - ServiceAccount with RBAC: get/list/create/patch/update on Deployments and Deployments/scale
 *   - get/list/delete on Pods and get on Pods/log
 *   - Or KUBECONFIG env var pointing to a valid kubeconfig file
 */

import type { IOrchestratorAdapter, ContainerInfo, ScaleResult, ContainerStats, StackConfig } from './types';

// Lazy-load to avoid hard dependency
let k8s: any;
function getK8sClient() {
  if (!k8s) {
    try {
      k8s = require('@kubernetes/client-node');
    } catch {
      throw new Error(
        '[K8sAdapter] "@kubernetes/client-node" package not found. Install it: yarn add @kubernetes/client-node',
      );
    }
  }
  return k8s;
}

export class K8sAdapter implements IOrchestratorAdapter {
  readonly name = 'kubernetes';
  private appsApi: any;
  private coreApi: any;
  private kc: any;
  private namespace: string;
  private workerLabelSelector: string;
  private workerLabels: Record<string, string>;

  constructor(options?: { kubeconfig?: string; context?: string; namespace?: string; workerLabelSelector?: string }) {
    const k8sLib = getK8sClient();
    this.kc = new k8sLib.KubeConfig();
    this.namespace = options?.namespace || 'nocobase';
    this.workerLabelSelector = options?.workerLabelSelector || 'role=worker';
    this.workerLabels = this.parseLabelSelector(this.workerLabelSelector);

    if (options?.kubeconfig?.trim()) {
      const kubeconfig = options.kubeconfig.trim();
      if (kubeconfig.includes('\n') || kubeconfig.startsWith('apiVersion:')) {
        this.kc.loadFromString(kubeconfig);
      } else {
        this.kc.loadFromFile(kubeconfig);
      }
    } else if (process.env.KUBECONFIG) {
      this.kc.loadFromFile(process.env.KUBECONFIG);
    } else {
      // In-cluster ServiceAccount
      this.kc.loadFromCluster();
    }

    if (options?.context) {
      this.kc.setCurrentContext(options.context);
    }

    this.appsApi = this.kc.makeApiClient(k8sLib.AppsV1Api);
    this.coreApi = this.kc.makeApiClient(k8sLib.CoreV1Api);
  }

  async ping(): Promise<boolean> {
    try {
      await this.coreApi.listNamespacedPod(
        this.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        this.workerLabelSelector || undefined,
        1,
      );
      return true;
    } catch {
      return false;
    }
  }

  async listContainers(stack: StackConfig): Promise<ContainerInfo[]> {
    const ns = stack.namespace || this.namespace;
    const deploymentName = stack.deploymentName || stack.name;
    const labelSelector = this.joinSelectors(`app=${deploymentName}`, this.workerLabelSelector);

    try {
      // Get pods matching the deployment's label selector
      const pods = await this.coreApi.listNamespacedPod(
        ns,
        undefined, // pretty
        undefined, // allowWatchBookmarks
        undefined, // _continue
        undefined, // fieldSelector
        labelSelector, // labelSelector
      );

      return (pods.body.items || []).map((pod: any) => ({
        id: `${ns}/${pod.metadata?.name || 'unknown'}`,
        name: pod.metadata?.name || 'unknown',
        status: this.mapPodPhase(pod.status?.phase, pod.status?.containerStatuses),
        image: pod.spec?.containers?.[0]?.image || '',
        createdAt: new Date(pod.metadata?.creationTimestamp || Date.now()),
        labels: pod.metadata?.labels || {},
      }));
    } catch (err: any) {
      throw new Error(`Failed to list pods for ${deploymentName} in ${ns}: ${err.message}`);
    }
  }

  async scale(stack: StackConfig, replicas: number): Promise<ScaleResult> {
    const ns = stack.namespace || this.namespace;
    const deploymentName = stack.deploymentName || stack.name;

    try {
      let deployment: any;
      try {
        deployment = await this.appsApi.readNamespacedDeployment(deploymentName, ns);
      } catch (err: any) {
        if (!this.isNotFound(err)) {
          throw err;
        }
        if (replicas === 0) {
          return { previousReplicas: 0, currentReplicas: 0 };
        }

        await this.appsApi.createNamespacedDeployment(ns, this.buildDeployment(stack, replicas));
        return { previousReplicas: 0, currentReplicas: replicas };
      }

      this.assertDeploymentManagedByStack(stack, deployment.body);
      const previousReplicas = deployment.body.spec?.replicas || 0;

      // Update the entire deployment to apply any changes made to the stack config
      await this.appsApi.replaceNamespacedDeployment(deploymentName, ns, this.buildDeployment(stack, replicas));

      return {
        previousReplicas,
        currentReplicas: replicas,
      };
    } catch (err: any) {
      throw new Error(`Failed to scale ${deploymentName}: ${err.message}`);
    }
  }

  async startContainer(containerId: string): Promise<void> {
    // In K8s, you can't "start" a pod directly.
    // The equivalent is deleting the pod so the Deployment recreates it.
    // But this is for stopped pods — in K8s context this doesn't apply directly.
    throw new Error('K8s does not support starting individual pods. Use scale to add replicas.');
  }

  async stopContainer(containerId: string): Promise<void> {
    // Delete the pod — Deployment will NOT recreate if we also scale down
    // For a simple "stop", we delete the pod which K8s won't restart if replicas match
    throw new Error(
      'K8s does not support stopping individual pods. Use scale to reduce replicas, or use removePod to delete a specific pod.',
    );
  }

  async removeContainer(containerId: string): Promise<void> {
    // Delete a specific pod by name
    // K8s will recreate it if the Deployment replicas are not reduced
    const parts = containerId.split('/');
    let ns = this.namespace;
    let podName = containerId;

    if (parts.length === 2) {
      ns = parts[0];
      podName = parts[1];
    }

    try {
      await this.coreApi.deleteNamespacedPod(podName, ns);
    } catch (err: any) {
      throw new Error(`Failed to delete pod ${podName} in ${ns}: ${err.message}`);
    }
  }

  async getStats(containerId: string): Promise<ContainerStats> {
    // K8s metrics require metrics-server; basic pod status doesn't include CPU/memory
    // This is a simplified version using pod status
    const parts = containerId.split('/');
    let ns = this.namespace;
    let podName = containerId;
    if (parts.length === 2) {
      ns = parts[0];
      podName = parts[1];
    }

    try {
      const pod = await this.coreApi.readNamespacedPod(podName, ns);
      const containerStatus = pod.body.status?.containerStatuses?.[0];
      const resourceLimits = pod.body.spec?.containers?.[0]?.resources?.limits;

      return {
        cpu: 0, // Requires metrics-server API, not available in basic K8s API
        memory: 0,
        memoryLimit: this.parseK8sMemory(resourceLimits?.memory) || 0,
        networkRx: 0,
        networkTx: 0,
      };
    } catch (err: any) {
      throw new Error(`Failed to get stats for ${podName}: ${err.message}`);
    }
  }

  async getLogs(containerId: string, tail = 200): Promise<string> {
    const parts = containerId.split('/');
    let ns = this.namespace;
    let podName = containerId;
    if (parts.length === 2) {
      ns = parts[0];
      podName = parts[1];
    }

    try {
      const logs = await this.coreApi.readNamespacedPodLog(
        podName,
        ns,
        undefined, // container
        undefined, // follow
        undefined, // insecureSkipTLSVerifyBackend
        undefined, // limitBytes
        undefined, // pretty
        undefined, // previous
        undefined, // sinceSeconds
        tail, // tailLines
        true, // timestamps
      );
      return logs.body || '';
    } catch (err: any) {
      throw new Error(`Failed to get logs for ${podName}: ${err.message}`);
    }
  }

  async assertManagedByStack(stack: StackConfig, containerId: string): Promise<void> {
    const { ns, podName } = this.parsePodRef(containerId, stack.namespace || this.namespace);
    const expectedNs = stack.namespace || this.namespace;
    if (ns !== expectedNs) {
      throw new Error(`Pod ${containerId} is in namespace "${ns}", expected "${expectedNs}"`);
    }

    const pod = await this.coreApi.readNamespacedPod(podName, ns);
    const labels = pod.body.metadata?.labels || {};
    const deploymentName = stack.deploymentName || stack.name;
    const stackLabelMatches = labels['orchestrator.stack'] === stack.name;
    const workerSelectorMatches = labels.app === deploymentName && this.labelsMatch(labels, this.workerLabels);

    if (!stackLabelMatches && !workerSelectorMatches) {
      throw new Error(`Pod ${containerId} is not managed by stack "${stack.name}"`);
    }
  }

  // ─── Private ───

  private parsePodRef(containerId: string, defaultNamespace: string): { ns: string; podName: string } {
    const parts = containerId.split('/');
    if (parts.length === 2) {
      return { ns: parts[0], podName: parts[1] };
    }
    return { ns: defaultNamespace, podName: containerId };
  }

  private buildDeployment(stack: StackConfig, replicas: number): any {
    if (!stack.image?.trim()) {
      throw new Error(`Stack "${stack.name}" must define an image before Kubernetes can create a worker deployment`);
    }

    const namespace = stack.namespace || this.namespace;
    const deploymentName = stack.deploymentName || stack.name;
    const selectorLabels = this.buildWorkerLabels(stack);
    const labels = {
      ...selectorLabels,
      'orchestrator.template-hash': stack.templateHash || 'unknown',
    };
    const container: any = {
      name: stack.k8sContainerName || 'worker',
      image: stack.image,
      imagePullPolicy: stack.imagePullPolicy || 'IfNotPresent',
      env: this.buildContainerEnv(stack),
      envFrom: this.cleanArray(stack.k8sEnvFrom),
      resources: this.buildResources(stack),
      volumeMounts: this.cleanArray(stack.k8sVolumeMounts),
      securityContext: stack.k8sSecurityContext,
    };

    // K8s images (or their mounted ConfigMap) must provide the same managed
    // worker entrypoint as Docker. User stack commands are intentionally ignored.
    container.command = ['/bin/sh', '/usr/local/bin/app-runtime-entrypoint.sh'];

    for (const key of ['envFrom', 'resources', 'volumeMounts', 'securityContext']) {
      if (this.isEmptyValue(container[key])) {
        delete container[key];
      }
    }

    const podSpec: any = {
      containers: [container],
      volumes: this.cleanArray(stack.k8sVolumes),
    };
    if (stack.serviceAccountName?.trim()) {
      podSpec.serviceAccountName = stack.serviceAccountName.trim();
    }
    if (!this.isEmptyValue(stack.k8sPodSecurityContext)) {
      podSpec.securityContext = stack.k8sPodSecurityContext;
    }
    if (!podSpec.volumes.length) {
      delete podSpec.volumes;
    }

    return {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: deploymentName,
        namespace,
        labels,
      },
      spec: {
        replicas,
        selector: {
          matchLabels: selectorLabels,
        },
        template: {
          metadata: {
            labels,
          },
          spec: podSpec,
        },
      },
    };
  }

  private buildWorkerLabels(stack: StackConfig): Record<string, string> {
    const deploymentName = stack.deploymentName || stack.name;
    return {
      app: deploymentName,
      'orchestrator.stack': stack.name,
      'orchestrator.managed': 'true',
      ...this.workerLabels,
    };
  }

  private buildContainerEnv(stack: StackConfig): any[] {
    const envVars = stack.envVars || {};
    const nativeEnv = this.cleanArray(stack.k8sEnv);
    const names = new Set<string>([...nativeEnv.map((item) => item?.name).filter(Boolean), ...Object.keys(envVars)]);
    const env: any[] = [];

    if (!names.has('POD_NAME')) {
      env.push({
        name: 'POD_NAME',
        valueFrom: {
          fieldRef: {
            fieldPath: 'metadata.name',
          },
        },
      });
    }

    env.push(...nativeEnv);

    for (const [name, value] of Object.entries(envVars)) {
      if (!name?.trim() || nativeEnv.some((item) => item?.name === name)) {
        continue;
      }
      env.push({ name, value: String(value) });
    }

    if (!names.has('LOGGER_BASE_PATH')) {
      env.push({
        name: 'LOGGER_BASE_PATH',
        value: '/app/nocobase/storage/logs/$(POD_NAME)',
      });
    }

    return env;
  }

  private buildResources(stack: StackConfig): any {
    const limits = Object.entries(stack.resourceLimits || {}).reduce(
      (acc, [key, value]) => {
        if (value) {
          acc[key] = String(value);
        }
        return acc;
      },
      {} as Record<string, string>,
    );

    return Object.keys(limits).length ? { limits } : undefined;
  }

  private cleanArray(value?: Record<string, any>[]): Record<string, any>[] {
    return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
  }

  private isEmptyValue(value: any): boolean {
    if (!value) return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'object') return Object.keys(value).length === 0;
    return false;
  }

  private isNotFound(err: any): boolean {
    return err?.response?.statusCode === 404 || err?.statusCode === 404 || err?.body?.code === 404;
  }

  private assertDeploymentManagedByStack(stack: StackConfig, deployment: any): void {
    const labels = {
      ...(deployment?.metadata?.labels || {}),
      ...(deployment?.spec?.template?.metadata?.labels || {}),
    };
    const stackLabelMatches = labels['orchestrator.stack'] === stack.name;
    const workerSelectorMatches = this.labelsMatch(labels, this.workerLabels);

    if (!stackLabelMatches && !workerSelectorMatches) {
      throw new Error(
        `Deployment ${
          deployment?.metadata?.name || stack.deploymentName || stack.name
        } does not match the configured worker label selector`,
      );
    }
  }

  private joinSelectors(...selectors: Array<string | undefined>): string | undefined {
    const joined = selectors
      .map((s) => s?.trim())
      .filter(Boolean)
      .join(',');
    return joined || undefined;
  }

  private parseLabelSelector(selector?: string): Record<string, string> {
    if (!selector?.trim()) return {};
    return selector
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .reduce(
        (acc, part) => {
          const [key, ...valueParts] = part.split('=');
          const value = valueParts.join('=');
          if (key?.trim() && value?.trim()) {
            acc[key.trim()] = value.trim();
          }
          return acc;
        },
        {} as Record<string, string>,
      );
  }

  private labelsMatch(labels: Record<string, string>, expected: Record<string, string>): boolean {
    const entries = Object.entries(expected);
    if (entries.length === 0) return false;
    return entries.every(([k, v]) => labels[k] === v);
  }

  private mapPodPhase(phase?: string, containerStatuses?: any[]): ContainerInfo['status'] {
    // Check container-level status first
    if (containerStatuses?.length) {
      const cs = containerStatuses[0];
      if (cs.state?.waiting?.reason === 'CrashLoopBackOff') return 'error';
      if (cs.state?.waiting) return 'pending';
      if (cs.state?.terminated) return 'exited';
    }

    switch (phase) {
      case 'Running':
        return 'running';
      case 'Pending':
        return 'pending';
      case 'Succeeded':
        return 'exited';
      case 'Failed':
        return 'error';
      default:
        return 'stopped';
    }
  }

  private parseK8sMemory(mem?: string): number {
    if (!mem) return 0;
    const match = mem.match(/^(\d+)(Ki|Mi|Gi|Ti)?$/);
    if (!match) return parseInt(mem, 10) || 0;
    const val = parseInt(match[1], 10);
    switch (match[2]) {
      case 'Ki':
        return val * 1024;
      case 'Mi':
        return val * 1024 * 1024;
      case 'Gi':
        return val * 1024 * 1024 * 1024;
      case 'Ti':
        return val * 1024 * 1024 * 1024 * 1024;
      default:
        return val;
    }
  }
}
