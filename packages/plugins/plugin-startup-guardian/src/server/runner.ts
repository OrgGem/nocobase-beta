/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import {
  createInitialState,
  getStateDirectory,
  readRetryRequest,
  readState,
  writeState,
  clearRetryRequest,
  writeIncident,
} from './journal';
import type {
  ClusterDrainDecision,
  ClusterRecoveryAuthority,
  GuardianState,
  QuarantineReceipt,
  QuarantineResult,
  QuarantineTarget,
  RetryRequest,
  StartupIncident,
  SharedClusterControl,
} from './contracts';
import {
  StartupGuardianDatabase,
  type ClusterDrainContext,
  type ClusterNodeBoot,
  type EnabledPluginRow,
} from './database-adapter';
import { isApprovedIncident, readPolicy } from './policy';
import { randomId, isStartupIncident, redactText } from './security';
import { acquireLocalLock } from './local-lock';
import {
  CLUSTER_DATABASE_LEASE_MS,
  CLUSTER_DRAIN_TIMEOUT_MS,
  CLUSTER_HEARTBEAT_INTERVAL_MS,
  CLUSTER_LOCK_TTL_MS,
  CLUSTER_POLL_INTERVAL_MS,
  loadClusterLockApi,
  readClusterModeConfig,
  type ClusterLockLease,
  type ClusterManagerNodeRecord,
  type ClusterModeConfig,
} from './cluster-mode';
import { readRuntimeCoreVersion } from './compatibility';

interface SupervisorOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stateDirectory?: string;
  appId?: string;
  deploymentId?: string;
  startupTimeoutMs?: number;
  terminateTimeoutMs?: number;
  retryPollIntervalMs?: number;
  stdio?: 'inherit' | 'ignore';
}

export interface SupervisorHandle {
  done: Promise<number>;
  stop(): Promise<void>;
}

type ChildEvent =
  | { kind: 'incident'; incident: StartupIncident }
  | { kind: 'ready'; appId: string; bootId: string }
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'error'; error: Error }
  | { kind: 'timeout' }
  | { kind: 'retry'; request: RetryRequest }
  | { kind: 'drained' }
  | { kind: 'stopped' };

interface ChildMessage {
  type?: unknown;
  incident?: unknown;
  appId?: unknown;
  bootId?: unknown;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_TERMINATE_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_POLL_INTERVAL_MS = 500;
const MAX_QUARANTINE_ATTEMPTS = 2;

export function startGuardianSupervisor(options: SupervisorOptions): SupervisorHandle {
  const controller = new AbortController();
  const stateDirectory = options.stateDirectory || getStateDirectory();
  const clusterConfig = readClusterModeConfig();
  const identity = {
    appId: options.appId || process.env.STARTUP_GUARDIAN_APP_ID || process.env.APP_NAME || 'main',
    deploymentId: options.deploymentId || process.env.STARTUP_GUARDIAN_DEPLOYMENT_ID || 'single-node',
  };
  let activeChild: ChildProcess | null = null;
  const done = acquireLocalLock(stateDirectory, 'runner-owner.lock', identity)
    .then(async (lock) => {
      try {
        const setChild = (child: ChildProcess | null) => {
          activeChild = child;
        };
        return clusterConfig
          ? await runClusterSupervisor(options, stateDirectory, controller.signal, setChild, clusterConfig)
          : await runSupervisor(options, stateDirectory, controller.signal, setChild);
      } finally {
        await lock.release();
      }
    })
    .catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : 'Startup Guardian could not acquire its local runner lock';
      process.stderr.write(`${redactText(message)}\n`);
      return 2;
    });

  return {
    done,
    async stop() {
      controller.abort();
      if (activeChild) await terminateChild(activeChild, options.terminateTimeoutMs || DEFAULT_TERMINATE_TIMEOUT_MS);
    },
  };
}

async function runSupervisor(
  options: SupervisorOptions,
  stateDirectory: string,
  signal: AbortSignal,
  setActiveChild: (child: ChildProcess | null) => void,
): Promise<number> {
  let state = await getOrCreateState(options, stateDirectory);
  if (
    state.appId !== (options.appId || state.appId) ||
    state.deploymentId !== (options.deploymentId || state.deploymentId)
  ) {
    await transition(
      state,
      { state: 'recovery-required', detail: 'Configured app or deployment identity does not match the journal' },
      stateDirectory,
    );
    await waitForStop(signal);
    return 0;
  }

  if (state.quarantinePending) {
    state = await reconcilePendingQuarantine(state, stateDirectory);
    if (state.state === 'recovery-required') {
      await waitForStop(signal);
      return 0;
    }
  }
  if (state.quarantine && state.quarantine.status !== 'cleared' && state.quarantine.status !== 'retry-failed') {
    state = await reconcileQuarantineReceipt(state, stateDirectory);
    if (state.state === 'recovery-required') {
      await waitForStop(signal);
      return 0;
    }
  }

  while (!signal.aborted) {
    const retryRequest = await readRetryRequest(stateDirectory);
    if (retryRequest) {
      const retryState = await applyRetryRequest(state, retryRequest, stateDirectory);
      if (!retryState) {
        state = await transition(
          state,
          { state: 'recovery-required', detail: 'Retry request failed its revision or quarantine checks' },
          stateDirectory,
        );
        await clearRetryRequest(stateDirectory);
        await waitForStop(signal);
        return 0;
      }
      state = retryState;
      await clearRetryRequest(stateDirectory);
    }

    const bootId = randomId();
    state = await transition(
      state,
      {
        state: 'starting',
        bootId,
        incident: undefined,
        detail: undefined,
      },
      stateDirectory,
    );
    const child = startChild(options, stateDirectory, bootId);
    setActiveChild(child);
    const firstEvent = await waitForChildEvent(child, {
      signal,
      timeoutMs: options.startupTimeoutMs || DEFAULT_STARTUP_TIMEOUT_MS,
      retryPollIntervalMs: options.retryPollIntervalMs || DEFAULT_RETRY_POLL_INTERVAL_MS,
      stateDirectory,
      waitForRetry: false,
    });

    if (firstEvent.kind === 'stopped' || signal.aborted) {
      await terminateChild(child, options.terminateTimeoutMs || DEFAULT_TERMINATE_TIMEOUT_MS);
      setActiveChild(null);
      await transition(state, { state: 'stopped', detail: 'Supervisor stopped by operator' }, stateDirectory);
      return 0;
    }

    if (firstEvent.kind === 'incident') {
      await terminateChild(child, options.terminateTimeoutMs || DEFAULT_TERMINATE_TIMEOUT_MS);
      setActiveChild(null);
      const incident = firstEvent.incident;
      if (!matchesIdentity(incident, state, bootId)) {
        state = await transition(
          state,
          { state: 'recovery-required', detail: 'Incident identity does not match the active child' },
          stateDirectory,
        );
        await waitForStop(signal);
        return 0;
      }
      const recovered = await quarantineIfApproved(state, incident, stateDirectory);
      state = recovered.state;
      if (!recovered.applied) {
        await waitForStop(signal);
        return 0;
      }
      continue;
    }

    if (firstEvent.kind !== 'ready') {
      await terminateChild(child, options.terminateTimeoutMs || DEFAULT_TERMINATE_TIMEOUT_MS);
      setActiveChild(null);
      const detail =
        firstEvent.kind === 'exit'
          ? `Child exited before readiness (code ${firstEvent.code ?? 'null'}, signal ${firstEvent.signal ?? 'none'})`
          : firstEvent.kind === 'timeout'
            ? 'Child did not reach final application readiness before the startup timeout'
            : firstEvent.kind === 'error'
              ? 'Child process failed before readiness'
              : 'Unexpected child state before readiness';
      await transition(state, { state: 'recovery-required', detail }, stateDirectory);
      await waitForStop(signal);
      return 0;
    }

    if (firstEvent.appId !== state.appId || firstEvent.bootId !== bootId) {
      await terminateChild(child, options.terminateTimeoutMs || DEFAULT_TERMINATE_TIMEOUT_MS);
      setActiveChild(null);
      await transition(
        state,
        { state: 'recovery-required', detail: 'Ready event identity does not match the active child' },
        stateDirectory,
      );
      await waitForStop(signal);
      return 0;
    }

    state = await transition(
      state,
      {
        state: 'ready',
        readyAt: new Date().toISOString(),
        detail: undefined,
        quarantine:
          state.quarantine?.status === 'retrying'
            ? { ...state.quarantine, status: 'cleared', retryEnabledTimestamp: undefined }
            : state.quarantine,
      },
      stateDirectory,
    );

    const runtimeEvent = await waitForChildEvent(child, {
      signal,
      retryPollIntervalMs: options.retryPollIntervalMs || DEFAULT_RETRY_POLL_INTERVAL_MS,
      stateDirectory,
      waitForRetry: true,
    });
    if (runtimeEvent.kind === 'retry') {
      await terminateChild(child, options.terminateTimeoutMs || DEFAULT_TERMINATE_TIMEOUT_MS);
      setActiveChild(null);
      const retryState = await applyRetryRequest(state, runtimeEvent.request, stateDirectory);
      if (!retryState) {
        state = await transition(
          state,
          { state: 'recovery-required', detail: 'Retry request failed its revision or quarantine checks' },
          stateDirectory,
        );
        await clearRetryRequest(stateDirectory);
        await waitForStop(signal);
        return 0;
      }
      state = retryState;
      await clearRetryRequest(stateDirectory);
      continue;
    }
    if (runtimeEvent.kind === 'incident') {
      await terminateChild(child, options.terminateTimeoutMs || DEFAULT_TERMINATE_TIMEOUT_MS);
      setActiveChild(null);
      const incident = runtimeEvent.incident;
      if (!matchesIdentity(incident, state, bootId)) {
        await transition(
          state,
          { state: 'recovery-required', detail: 'Incident identity does not match the active child' },
          stateDirectory,
        );
        await waitForStop(signal);
        return 0;
      }
      const recovered = await quarantineIfApproved(state, incident, stateDirectory);
      state = recovered.state;
      if (!recovered.applied) {
        await waitForStop(signal);
        return 0;
      }
      continue;
    }
    if (runtimeEvent.kind === 'stopped' || signal.aborted) {
      await terminateChild(child, options.terminateTimeoutMs || DEFAULT_TERMINATE_TIMEOUT_MS);
      setActiveChild(null);
      await transition(state, { state: 'stopped', detail: 'Supervisor stopped by operator' }, stateDirectory);
      return 0;
    }

    await terminateChild(child, options.terminateTimeoutMs || DEFAULT_TERMINATE_TIMEOUT_MS);
    setActiveChild(null);
    const detail =
      runtimeEvent.kind === 'exit'
        ? `Child exited after readiness (code ${runtimeEvent.code ?? 'null'}, signal ${runtimeEvent.signal ?? 'none'})`
        : 'Child process failed after readiness';
    await transition(state, { state: 'recovery-required', detail }, stateDirectory);
    await waitForStop(signal);
    return 0;
  }

  await transition(state, { state: 'stopped', detail: 'Supervisor stopped by operator' }, stateDirectory);
  return 0;
}

async function runClusterSupervisor(
  options: SupervisorOptions,
  stateDirectory: string,
  signal: AbortSignal,
  setActiveChild: (child: ChildProcess | null) => void,
  config: ClusterModeConfig,
): Promise<number> {
  const identity = { appId: config.appId, deploymentId: config.deploymentId };
  const database = await StartupGuardianDatabase.connectFromEnvironment();
  const lockApi = loadClusterLockApi();
  const lockClient = lockApi.createClient({
    appName: config.appId,
    lockName: `startup-guardian:${config.deploymentId}`,
    redisUrl: config.redisUrl,
    registryRedisUrl: config.registryRedisUrl,
    ttlMs: CLUSTER_LOCK_TTL_MS,
  });
  let state = await getOrCreateState(options, stateDirectory);
  let child: ChildProcess | null = null;
  let childBoot: ClusterNodeBoot | null = null;
  let childDecisionRevision: number | null = null;
  let childReady = false;
  let childEvent: Promise<ChildEvent> | null = null;
  let appliedRevision = 0;
  let hasStartedChild = false;
  let lastHeartbeatAt = 0;
  let lastCoordinatorAttemptAt = 0;
  let lastCoordinatorDetail = '';

  try {
    const initialControl = await database.readClusterControl(identity.appId, identity.deploymentId);
    if (!initialControl)
      throw new Error('HA cluster enrollment is missing; initialize only while every app node is stopped');
    if (!sameStringSet(initialControl.expectedMembers, config.members)) {
      throw new Error('Configured app-node roster differs from the explicit HA enrollment');
    }
    const initialMember = (await database.readClusterMembers(identity.appId, identity.deploymentId)).find(
      (member) => member.nodeId === config.nodeId,
    );
    if (!initialMember) throw new Error(`App node ${config.nodeId} is not in the explicit HA enrollment`);
    if (!['never-started', 'stopped'].includes(initialMember.state)) {
      throw new Error(
        `App node ${config.nodeId} still has an unacknowledged ${initialMember.state} boot; refusing to infer it stopped`,
      );
    }
    appliedRevision = initialMember.appliedRevision;

    while (!signal.aborted) {
      const control = await database.readClusterControl(identity.appId, identity.deploymentId);
      if (!control) throw new Error('HA cluster control state disappeared');

      if (control.phase === 'draining') {
        await stopAndAcknowledgeClusterDrain({
          database,
          identity,
          nodeId: config.nodeId,
          control,
          child,
          childBoot,
          terminateTimeoutMs: options.terminateTimeoutMs || DEFAULT_TERMINATE_TIMEOUT_MS,
          setActiveChild,
        });
        child = null;
        childBoot = null;
        childDecisionRevision = null;
        childReady = false;
        childEvent = null;
        const receipt = await resumeClusterQuarantineIfOwned({
          database,
          lockClient,
          config,
          identity,
          control,
          nodeModulesPath: process.env.NODE_MODULES_PATH,
          signal,
        });
        if (receipt) {
          state = await transition(
            state,
            {
              state: 'starting',
              incident: receipt.incident,
              quarantine: receipt,
              quarantineAttempts:
                (await database.readClusterControl(identity.appId, identity.deploymentId))?.quarantineAttempts ??
                state.quarantineAttempts + 1,
              detail: 'Shared HA quarantine committed; waiting for a fresh child to become ready',
            },
            stateDirectory,
          );
        }
        await delay(CLUSTER_POLL_INTERVAL_MS);
        continue;
      }

      if (control.phase !== 'ready') {
        if (child) {
          await terminateChild(child, options.terminateTimeoutMs || DEFAULT_TERMINATE_TIMEOUT_MS);
          setActiveChild(null);
          child = null;
          childBoot = null;
          childDecisionRevision = null;
          childReady = false;
          childEvent = null;
        }
        await delay(CLUSTER_POLL_INTERVAL_MS);
        continue;
      }

      if (control.incident && isApprovedIncident(control.policy, control.incident)) {
        if (Date.now() - lastCoordinatorAttemptAt >= 1_000) {
          lastCoordinatorAttemptAt = Date.now();
          try {
            const receipt = await coordinateClusterQuarantine({
              database,
              lockClient,
              config,
              identity,
              incident: control.incident,
              nodeModulesPath: process.env.NODE_MODULES_PATH,
              child,
              childBoot,
              terminateTimeoutMs: options.terminateTimeoutMs || DEFAULT_TERMINATE_TIMEOUT_MS,
              setActiveChild,
              signal,
            });
            if (receipt) {
              child = null;
              childBoot = null;
              childDecisionRevision = null;
              childReady = false;
              childEvent = null;
              const nextControl = await database.readClusterControl(identity.appId, identity.deploymentId);
              state = await transition(
                state,
                {
                  state: 'starting',
                  incident: receipt.incident,
                  quarantine: receipt,
                  quarantineAttempts: nextControl?.quarantineAttempts ?? state.quarantineAttempts + 1,
                  detail: 'Shared HA quarantine committed; waiting for a fresh child to become ready',
                },
                stateDirectory,
              );
              lastCoordinatorDetail = '';
              continue;
            }
          } catch (error) {
            const message =
              error instanceof Error ? redactText(error.message) : 'Cluster decision could not be coordinated';
            if (lastCoordinatorDetail !== message) {
              process.stderr.write(`${message}\n`);
              lastCoordinatorDetail = message;
            }
          }
        }
      }

      if (child) {
        const event = await Promise.race([
          childEvent?.then((value) => ({ value })) ?? Promise.resolve(null),
          delay(CLUSTER_POLL_INTERVAL_MS).then(() => null),
        ]);
        if (event?.value) {
          childEvent = null;
          if (event.value.kind === 'ready') {
            if (!childBoot || event.value.appId !== config.appId || event.value.bootId !== childBoot.bootId) {
              throw new Error('Cluster child readiness identity does not match its registered boot');
            }
            const latest = await database.readClusterControl(identity.appId, identity.deploymentId);
            if (
              !latest ||
              latest.phase !== 'ready' ||
              childDecisionRevision === null ||
              latest.decisionRevision !== childDecisionRevision
            ) {
              await terminateChild(child, options.terminateTimeoutMs || DEFAULT_TERMINATE_TIMEOUT_MS);
              if (latest?.phase === 'draining') {
                await acknowledgeIfCurrentDrain(database, identity, config.nodeId, childBoot, latest);
              } else {
                await markClusterChildStopped(database, identity, childBoot);
              }
              setActiveChild(null);
              child = null;
              childBoot = null;
              childDecisionRevision = null;
              childReady = false;
              continue;
            }
            await database.heartbeatClusterMember(identity, childBoot, 'ready', latest.decisionRevision);
            appliedRevision = latest.decisionRevision;
            childDecisionRevision = latest.decisionRevision;
            childReady = true;
            lastHeartbeatAt = Date.now();
            state = await transition(
              state,
              { state: 'ready', bootId: childBoot.bootId, readyAt: new Date().toISOString(), detail: undefined },
              stateDirectory,
            );
            childEvent = waitForChildEvent(child, {
              signal,
              retryPollIntervalMs: options.retryPollIntervalMs || DEFAULT_RETRY_POLL_INTERVAL_MS,
              stateDirectory,
              waitForRetry: false,
            });
            continue;
          }
          if (event.value.kind === 'incident') {
            await terminateChild(child, options.terminateTimeoutMs || DEFAULT_TERMINATE_TIMEOUT_MS);
            setActiveChild(null);
            child = null;
            childDecisionRevision = null;
            childReady = false;
            if (!childBoot || !matchesIdentity(event.value.incident, state, childBoot.bootId)) {
              throw new Error('Cluster incident identity does not match its active child');
            }
            await writeIncident(event.value.incident, stateDirectory);
            await database.recordClusterIncident(identity, childBoot, event.value.incident);
            state = await transition(
              state,
              {
                state: 'recovery-required',
                bootId: childBoot.bootId,
                incident: event.value.incident,
                detail: isApprovedIncident(control.policy, event.value.incident)
                  ? 'Approved incident is awaiting a shared HA drain decision'
                  : 'No exact approved HA recovery rule matches this incident; healthy peers continue serving',
              },
              stateDirectory,
            );
            childBoot = null;
            childDecisionRevision = null;
            hasStartedChild = true;
            continue;
          }
          if (event.value.kind === 'stopped' || signal.aborted) {
            await terminateChild(child, options.terminateTimeoutMs || DEFAULT_TERMINATE_TIMEOUT_MS);
            await markClusterChildStopped(database, identity, childBoot);
            setActiveChild(null);
            child = null;
            childBoot = null;
            childDecisionRevision = null;
            childReady = false;
            state = await transition(
              state,
              { state: 'stopped', detail: 'HA supervisor stopped by operator' },
              stateDirectory,
            );
            return 0;
          }

          const detail =
            event.value.kind === 'exit'
              ? `HA child exited before or after readiness (code ${event.value.code ?? 'null'}, signal ${
                  event.value.signal ?? 'none'
                })`
              : event.value.kind === 'timeout'
                ? 'HA child did not reach final application readiness before the startup timeout'
                : 'HA child process failed before final readiness';
          await terminateChild(child, options.terminateTimeoutMs || DEFAULT_TERMINATE_TIMEOUT_MS);
          await markClusterChildStopped(database, identity, childBoot);
          setActiveChild(null);
          child = null;
          childBoot = null;
          childDecisionRevision = null;
          childReady = false;
          hasStartedChild = true;
          state = await transition(state, { state: 'recovery-required', detail }, stateDirectory);
          continue;
        }

        const latest = await database.readClusterControl(identity.appId, identity.deploymentId);
        if (latest?.phase === 'draining') continue;
        if (!latest || latest.phase !== 'ready') continue;
        if (childDecisionRevision === null || latest.decisionRevision !== childDecisionRevision) {
          await terminateChild(child, options.terminateTimeoutMs || DEFAULT_TERMINATE_TIMEOUT_MS);
          await markClusterChildStopped(database, identity, childBoot);
          setActiveChild(null);
          child = null;
          childBoot = null;
          childDecisionRevision = null;
          childReady = false;
          childEvent = null;
          continue;
        }
        if (Date.now() - lastHeartbeatAt >= CLUSTER_HEARTBEAT_INTERVAL_MS) {
          await database.heartbeatClusterMember(
            identity,
            childBoot as ClusterNodeBoot,
            childReady ? 'ready' : 'starting',
            appliedRevision,
          );
          lastHeartbeatAt = Date.now();
        }
        continue;
      }

      if (!hasStartedChild || control.decisionRevision > appliedRevision) {
        const boot: ClusterNodeBoot = {
          nodeId: config.nodeId,
          bootId: randomId(),
          coreVersion: await readRuntimeCoreVersion(),
        };
        const member = await database.registerClusterMember(identity, boot);
        appliedRevision = Math.max(appliedRevision, member.appliedRevision);
        childBoot = boot;
        childDecisionRevision = control.decisionRevision;
        childReady = false;
        await database.heartbeatClusterMember(identity, boot, 'starting');
        state = await transition(
          state,
          { state: 'starting', bootId: boot.bootId, incident: undefined, detail: undefined },
          stateDirectory,
        );
        child = startChild(options, stateDirectory, boot.bootId);
        setActiveChild(child);
        hasStartedChild = true;
        lastHeartbeatAt = Date.now();
        childEvent = waitForChildEvent(child, {
          signal,
          timeoutMs: options.startupTimeoutMs || DEFAULT_STARTUP_TIMEOUT_MS,
          retryPollIntervalMs: options.retryPollIntervalMs || DEFAULT_RETRY_POLL_INTERVAL_MS,
          stateDirectory,
          waitForRetry: false,
        });
        continue;
      }

      await delay(CLUSTER_POLL_INTERVAL_MS);
    }

    if (child) {
      await terminateChild(child, options.terminateTimeoutMs || DEFAULT_TERMINATE_TIMEOUT_MS);
      await markClusterChildStopped(database, identity, childBoot);
      setActiveChild(null);
    }
    state = await transition(state, { state: 'stopped', detail: 'HA supervisor stopped by operator' }, stateDirectory);
    return 0;
  } catch (error) {
    if (child) {
      await terminateChild(child, options.terminateTimeoutMs || DEFAULT_TERMINATE_TIMEOUT_MS);
      await markClusterChildStopped(database, identity, childBoot).catch(() => undefined);
      setActiveChild(null);
    }
    const message = error instanceof Error ? redactText(error.message) : 'HA startup guardian failed closed';
    state = await transition(state, { state: 'recovery-required', detail: message }, stateDirectory);
    process.stderr.write(`${message}\n`);
    await waitForStop(signal);
    return 0;
  } finally {
    await Promise.all([database.close(), lockClient.close()]);
  }
}

async function coordinateClusterQuarantine(input: {
  database: StartupGuardianDatabase;
  lockClient: ReturnType<ReturnType<typeof loadClusterLockApi>['createClient']>;
  config: ClusterModeConfig;
  identity: { appId: string; deploymentId: string };
  incident: StartupIncident;
  nodeModulesPath?: string;
  child: ChildProcess | null;
  childBoot: ClusterNodeBoot | null;
  terminateTimeoutMs: number;
  setActiveChild: (child: ChildProcess | null) => void;
  signal: AbortSignal;
}): Promise<QuarantineReceipt | null> {
  const control = await input.database.readClusterControl(input.identity.appId, input.identity.deploymentId);
  if (
    !control ||
    control.phase !== 'ready' ||
    !control.incident ||
    control.incident.eventId !== input.incident.eventId
  ) {
    return null;
  }
  if (!isApprovedIncident(control.policy, input.incident)) return null;
  if (control.quarantineAttempts >= control.maxQuarantineAttempts)
    throw new Error('HA campaign quarantine budget is exhausted');
  await assertNoRegisteredWorkerOrSandbox(await input.lockClient.listClusterManagerNodes());
  const target = {
    pluginName: input.incident.pluginName,
    packageName: input.incident.packageName,
    pluginVersion: input.incident.pluginVersion,
  };
  const row = await input.database.readPlugin(target);
  if (!row || !row.enabled || !row.installed || row.builtIn === true) {
    throw new Error('Target applicationPlugins row is not eligible for HA quarantine');
  }
  const enabled = await input.database.listEnabledPlugins();
  if (!input.nodeModulesPath)
    throw new Error('NODE_MODULES_PATH is required before HA recovery can drain the app cohort');
  await assertNoMandatoryDependent(target.packageName, enabled);

  const lease = await input.lockClient.tryAcquire(randomId());
  if (!lease) return null;
  let authority: ClusterRecoveryAuthority | null = null;
  try {
    authority = await input.database.acquireClusterAuthority(
      input.identity,
      input.config.nodeId,
      lease.ownerToken,
      CLUSTER_DATABASE_LEASE_MS,
    );
    if (!(await lease.verify())) throw new Error('Cluster Manager recovery lock was lost before drain');
    const drain = await input.database.beginClusterDrain(input.identity, authority, {
      type: 'quarantine',
      target,
      incident: input.incident,
    });
    return await finishClusterQuarantine({
      database: input.database,
      lockClient: input.lockClient,
      lease,
      authority,
      identity: input.identity,
      config: input.config,
      drain,
      incident: input.incident,
      target,
      nodeModulesPath: input.nodeModulesPath,
      child: input.child,
      childBoot: input.childBoot,
      terminateTimeoutMs: input.terminateTimeoutMs,
      setActiveChild: input.setActiveChild,
      signal: input.signal,
    });
  } finally {
    if (authority) await input.database.releaseClusterAuthority(input.identity, authority).catch(() => undefined);
    await lease.release().catch(() => undefined);
  }
}

async function resumeClusterQuarantineIfOwned(input: {
  database: StartupGuardianDatabase;
  lockClient: ReturnType<ReturnType<typeof loadClusterLockApi>['createClient']>;
  config: ClusterModeConfig;
  identity: { appId: string; deploymentId: string };
  control: SharedClusterControl;
  nodeModulesPath?: string;
  signal: AbortSignal;
}): Promise<QuarantineReceipt | null> {
  const pending = input.control.pendingDecision;
  if (!pending || pending.type !== 'quarantine' || !pending.incident) return null;
  const lease = await input.lockClient.tryAcquire(randomId());
  if (!lease) return null;
  let authority: ClusterRecoveryAuthority | null = null;
  try {
    authority = await input.database.acquireClusterAuthority(
      input.identity,
      input.config.nodeId,
      lease.ownerToken,
      CLUSTER_DATABASE_LEASE_MS,
    );
    await assertNoRegisteredWorkerOrSandbox(await input.lockClient.listClusterManagerNodes());
    const target = pending.target;
    const row = await input.database.readPlugin(target);
    if (!row || !row.enabled || !row.installed || row.builtIn === true) {
      throw new Error('Pending HA quarantine target no longer matches the enabled applicationPlugins row');
    }
    const enabled = await input.database.listEnabledPlugins();
    if (!input.nodeModulesPath) throw new Error('NODE_MODULES_PATH is required to resume HA recovery safely');
    await assertNoMandatoryDependent(target.packageName, enabled);
    return await finishClusterQuarantine({
      database: input.database,
      lockClient: input.lockClient,
      lease,
      authority,
      identity: input.identity,
      config: input.config,
      drain: { drainRevision: pending.revision, participants: pending.participants },
      incident: pending.incident,
      target,
      nodeModulesPath: input.nodeModulesPath,
      child: null,
      childBoot: null,
      terminateTimeoutMs: DEFAULT_TERMINATE_TIMEOUT_MS,
      setActiveChild: () => undefined,
      signal: input.signal,
    });
  } finally {
    if (authority) await input.database.releaseClusterAuthority(input.identity, authority).catch(() => undefined);
    await lease.release().catch(() => undefined);
  }
}

async function finishClusterQuarantine(input: {
  database: StartupGuardianDatabase;
  lockClient: ReturnType<ReturnType<typeof loadClusterLockApi>['createClient']>;
  lease: ClusterLockLease;
  authority: ClusterRecoveryAuthority;
  identity: { appId: string; deploymentId: string };
  config: ClusterModeConfig;
  drain: ClusterDrainContext;
  incident: StartupIncident;
  target: QuarantineTarget;
  nodeModulesPath?: string;
  child: ChildProcess | null;
  childBoot: ClusterNodeBoot | null;
  terminateTimeoutMs: number;
  setActiveChild: (child: ChildProcess | null) => void;
  signal: AbortSignal;
}): Promise<QuarantineReceipt> {
  const ownParticipant = input.drain.participants.find(
    (participant) => participant.nodeId === input.config.nodeId && participant.bootId === input.childBoot?.bootId,
  );
  if (ownParticipant && input.childBoot) {
    if (input.child) await terminateChild(input.child, input.terminateTimeoutMs);
    input.setActiveChild(null);
    await input.database.acknowledgeClusterStopped(
      input.identity,
      ownParticipant.nodeId,
      ownParticipant.bootId,
      input.drain.drainRevision,
    );
  }

  const startedAt = Date.now();
  let nextLeaseRenewal = Date.now() + Math.floor(CLUSTER_LOCK_TTL_MS / 3);
  let nextDatabaseRenewal = Date.now() + Math.floor(CLUSTER_DATABASE_LEASE_MS / 3);
  while (!input.signal.aborted && Date.now() - startedAt < CLUSTER_DRAIN_TIMEOUT_MS) {
    const control = await input.database.readClusterControl(input.identity.appId, input.identity.deploymentId);
    if (!control || control.phase !== 'draining' || control.drainRevision !== input.drain.drainRevision) {
      if (control?.phase === 'ready' && control.quarantine?.incident.eventId === input.incident.eventId)
        return control.quarantine;
      throw new Error('Shared HA drain changed before its quarantine could commit');
    }
    const members = await input.database.readClusterMembers(input.identity.appId, input.identity.deploymentId);
    const allStopped = input.drain.participants.every((participant) => {
      const member = members.find((item) => item.nodeId === participant.nodeId);
      return (
        member?.bootId === participant.bootId &&
        member.state === 'stopped' &&
        member.acknowledgedRevision === input.drain.drainRevision
      );
    });
    if (allStopped) break;
    if (Date.now() >= nextLeaseRenewal) {
      if (!(await input.lease.renew())) throw new Error('Cluster Manager lock lease was lost during the app drain');
      nextLeaseRenewal = Date.now() + Math.floor(CLUSTER_LOCK_TTL_MS / 3);
    }
    if (Date.now() >= nextDatabaseRenewal) {
      if (!(await input.database.renewClusterAuthority(input.identity, input.authority, CLUSTER_DATABASE_LEASE_MS))) {
        throw new Error('PostgreSQL recovery authority lease was lost during the app drain');
      }
      nextDatabaseRenewal = Date.now() + Math.floor(CLUSTER_DATABASE_LEASE_MS / 3);
    }
    await delay(CLUSTER_POLL_INTERVAL_MS);
  }

  if (input.signal.aborted) throw new Error('HA recovery was stopped while app peers were draining');
  const members = await input.database.readClusterMembers(input.identity.appId, input.identity.deploymentId);
  const allStopped = input.drain.participants.every((participant) => {
    const member = members.find((item) => item.nodeId === participant.nodeId);
    return (
      member?.bootId === participant.bootId &&
      member.state === 'stopped' &&
      member.acknowledgedRevision === input.drain.drainRevision
    );
  });
  if (!allStopped) {
    await input.database.holdClusterRecovery(
      input.identity,
      input.authority,
      input.drain.drainRevision,
      'A registered app node did not confirm its exact boot stopped before the HA drain timeout',
    );
    throw new Error('HA drain timed out; global recovery is held with every unacknowledged node fenced from readiness');
  }
  if (!(await input.lease.verify()))
    throw new Error('Cluster Manager lock was lost before the PostgreSQL quarantine transaction');
  if (!(await input.database.renewClusterAuthority(input.identity, input.authority, CLUSTER_DATABASE_LEASE_MS))) {
    throw new Error('PostgreSQL recovery authority expired before quarantine');
  }
  return input.database.quarantineClusterPlugin({
    authority: input.authority,
    drainRevision: input.drain.drainRevision,
    target: input.target,
    incident: input.incident,
    assertNoMandatoryDependent: assertNoMandatoryDependent,
  });
}

async function stopAndAcknowledgeClusterDrain(input: {
  database: StartupGuardianDatabase;
  identity: { appId: string; deploymentId: string };
  nodeId: string;
  control: SharedClusterControl;
  child: ChildProcess | null;
  childBoot: ClusterNodeBoot | null;
  terminateTimeoutMs: number;
  setActiveChild: (child: ChildProcess | null) => void;
}): Promise<void> {
  const decision = input.control.pendingDecision;
  if (!decision) throw new Error('Cluster is marked draining without a durable pending decision');
  const participant = decision.participants.find(
    (item) => item.nodeId === input.nodeId && item.bootId === input.childBoot?.bootId,
  );
  if (!participant || !input.childBoot) return;
  if (input.child) await terminateChild(input.child, input.terminateTimeoutMs);
  input.setActiveChild(null);
  await input.database.acknowledgeClusterStopped(
    input.identity,
    participant.nodeId,
    participant.bootId,
    decision.revision,
  );
}

async function acknowledgeIfCurrentDrain(
  database: StartupGuardianDatabase,
  identity: { appId: string; deploymentId: string },
  nodeId: string,
  boot: ClusterNodeBoot,
  control: SharedClusterControl | null,
): Promise<void> {
  const decision = control?.pendingDecision;
  if (
    control?.phase !== 'draining' ||
    !decision?.participants.some((item) => item.nodeId === nodeId && item.bootId === boot.bootId)
  )
    return;
  await database.acknowledgeClusterStopped(identity, nodeId, boot.bootId, decision.revision);
}

async function markClusterChildStopped(
  database: StartupGuardianDatabase,
  identity: { appId: string; deploymentId: string },
  boot: ClusterNodeBoot | null,
): Promise<void> {
  if (!boot) return;
  await database.heartbeatClusterMember(identity, boot, 'stopped');
}

function assertNoRegisteredWorkerOrSandbox(nodes: ClusterManagerNodeRecord[]): void {
  for (const node of nodes) {
    if (node.isSandbox || node.appRole === 'worker' || node.appRole === 'sandbox') {
      throw new Error(`HA auto-recovery is unsupported while Cluster Manager reports non-app node ${node.id}`);
    }
    if (node.appRole && node.appRole !== 'app') throw new Error(`Unknown Cluster Manager node role for ${node.id}`);
    const mode = node.workerMode.trim().toLowerCase();
    if (!['', 'main', 'app', '!'].includes(mode)) {
      throw new Error(`HA auto-recovery is unsupported while node ${node.id} runs worker mode ${mode}`);
    }
  }
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForStop(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

async function getOrCreateState(options: SupervisorOptions, stateDirectory: string): Promise<GuardianState> {
  const appId = options.appId || process.env.STARTUP_GUARDIAN_APP_ID || process.env.APP_NAME || 'main';
  const deploymentId = options.deploymentId || process.env.STARTUP_GUARDIAN_DEPLOYMENT_ID || 'single-node';
  return (await readState(stateDirectory)) || createInitialState({ appId, deploymentId });
}

function startChild(options: SupervisorOptions, stateDirectory: string, bootId: string): ChildProcess {
  return spawn(options.command, options.args, {
    cwd: options.cwd || process.cwd(),
    env: {
      ...process.env,
      ...options.env,
      STARTUP_GUARDIAN_STATE_DIR: stateDirectory,
      STARTUP_GUARDIAN_APP_ID: options.appId || process.env.STARTUP_GUARDIAN_APP_ID || process.env.APP_NAME || 'main',
      STARTUP_GUARDIAN_DEPLOYMENT_ID:
        options.deploymentId || process.env.STARTUP_GUARDIAN_DEPLOYMENT_ID || 'single-node',
      STARTUP_GUARDIAN_BOOT_ID: bootId,
      ...(process.env.STARTUP_GUARDIAN_CLUSTER_MODE === 'redis-postgres'
        ? { STARTUP_GUARDIAN_STATE_SCOPE: 'node' }
        : {}),
    },
    stdio: [options.stdio || 'inherit', options.stdio || 'inherit', options.stdio || 'inherit', 'ipc'],
    shell: false,
    windowsHide: true,
  });
}

function waitForChildEvent(
  child: ChildProcess,
  options: {
    signal: AbortSignal;
    timeoutMs?: number;
    retryPollIntervalMs: number;
    stateDirectory: string;
    waitForRetry: boolean;
  },
): Promise<ChildEvent> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let retryPoll: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (retryPoll) clearInterval(retryPoll);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
      options.signal.removeEventListener('abort', onAbort);
    };
    const settle = (event: ChildEvent) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(event);
    };
    const onMessage = (message: ChildMessage) => {
      if (message.type === 'startup-guardian-incident' && isStartupIncident(message.incident)) {
        settle({ kind: 'incident', incident: message.incident });
      } else if (
        message.type === 'startup-guardian-ready' &&
        typeof message.appId === 'string' &&
        typeof message.bootId === 'string'
      ) {
        settle({ kind: 'ready', appId: message.appId, bootId: message.bootId });
      }
    };
    const onExit = (code: number | null, exitSignal: NodeJS.Signals | null) =>
      settle({ kind: 'exit', code, signal: exitSignal });
    const onError = (error: Error) => settle({ kind: 'error', error });
    const onAbort = () => settle({ kind: 'stopped' });

    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
    options.signal.addEventListener('abort', onAbort, { once: true });
    if (options.signal.aborted) return onAbort();
    if (options.timeoutMs) timeout = setTimeout(() => settle({ kind: 'timeout' }), options.timeoutMs);

    if (options.waitForRetry) {
      retryPoll = setInterval(() => {
        readRetryRequest(options.stateDirectory)
          .then((request) => {
            if (request) settle({ kind: 'retry', request });
          })
          .catch((error: unknown) => {
            settle({
              kind: 'error',
              error: error instanceof Error ? error : new Error('Retry state could not be read'),
            });
          });
      }, options.retryPollIntervalMs);
    }
  });
}

async function quarantineIfApproved(
  current: GuardianState,
  incident: StartupIncident,
  stateDirectory: string,
): Promise<{ applied: boolean; state: GuardianState }> {
  const policy = await readPolicy(stateDirectory);
  if (!isApprovedIncident(policy, incident)) {
    const state = await transition(
      current,
      { state: 'recovery-required', incident, detail: 'No exact approved auto-recovery policy matches this incident' },
      stateDirectory,
    );
    return { applied: false, state };
  }
  if (current.quarantineAttempts >= current.maxQuarantineAttempts) {
    const state = await transition(
      current,
      { state: 'recovery-required', incident, detail: 'Campaign quarantine attempt budget is exhausted' },
      stateDirectory,
    );
    return { applied: false, state };
  }

  const target: QuarantineTarget = {
    pluginName: incident.pluginName,
    packageName: incident.packageName,
    pluginVersion: incident.pluginVersion,
  };
  let database: StartupGuardianDatabase;
  try {
    database = await StartupGuardianDatabase.connectFromEnvironment();
  } catch (error) {
    const state = await transition(
      current,
      {
        state: 'recovery-required',
        incident,
        detail: error instanceof Error ? redactText(error.message) : 'Database recovery adapter unavailable',
      },
      stateDirectory,
    );
    return { applied: false, state };
  }

  try {
    const row = await database.readPlugin(target);
    if (!row || !row.enabled || !row.installed || row.builtIn === true) {
      const state = await transition(
        current,
        {
          state: 'recovery-required',
          incident,
          detail: 'applicationPlugins row is missing, disabled, uninstalled, protected or has changed version',
        },
        stateDirectory,
      );
      return { applied: false, state };
    }
    const enabled = await database.listEnabledPlugins();
    await assertNoMandatoryDependent(target.packageName, enabled);
    const prior = {
      enabled: row.enabled,
      installed: row.installed,
      builtIn: false,
      version: row.version,
      options: row.options,
      updatedAt: row.updatedAtExact,
    };
    const attempt = current.quarantineAttempts + 1;
    const pendingState: GuardianState = {
      ...current,
      state: 'starting',
      incident,
      quarantineAttempts: attempt,
      quarantinePending: { incident, target, attempt, prior, rowId: row.id },
      updatedAt: new Date().toISOString(),
    };
    await writeState({ ...pendingState, revision: current.revision + 1 }, stateDirectory);
    let receipt: QuarantineReceipt | undefined;
    await database.quarantinePlugin(target, async (result) => {
      receipt = createReceipt(incident, result);
      await writeState(
        {
          ...pendingState,
          revision: current.revision + 2,
          quarantinePending: undefined,
          quarantine: receipt,
          updatedAt: new Date().toISOString(),
          detail: 'Approved plugin quarantined; starting a fresh child process',
        },
        stateDirectory,
      );
    });
    if (!receipt) throw new Error('Database transaction completed without a durable quarantine receipt');
    return { applied: true, state: (await readState(stateDirectory)) || pendingState };
  } catch (error) {
    const state = await transition(
      current,
      {
        state: 'recovery-required',
        incident,
        detail: error instanceof Error ? redactText(error.message) : 'Database quarantine failed',
      },
      stateDirectory,
    );
    return { applied: false, state };
  } finally {
    await database.close();
  }
}

function createReceipt(incident: StartupIncident, result: QuarantineResult): QuarantineReceipt {
  return {
    quarantineId: randomId(),
    status: 'quarantined',
    incident,
    target: result.target,
    rowId: result.rowId,
    postUpdateTimestamp: result.postUpdateTimestamp,
    prior: {
      ...result.before,
      updatedAt: result.priorUpdatedAt,
    },
    quarantinedAt: new Date().toISOString(),
  };
}

async function applyRetryRequest(
  current: GuardianState,
  request: RetryRequest,
  stateDirectory: string,
): Promise<GuardianState | null> {
  if (
    current.revision !== request.expectedRevision ||
    !current.quarantine ||
    current.quarantine.status !== 'quarantined' ||
    current.quarantine.target.packageName !== request.packageName
  ) {
    return null;
  }
  const database = await StartupGuardianDatabase.connectFromEnvironment();
  try {
    let retryTimestamp: string | null = null;
    const retryingReceipt: QuarantineReceipt = { ...current.quarantine, status: 'retrying' };
    retryTimestamp = await database.restorePlugin(current.quarantine, async (updatedAt) => {
      retryingReceipt.retryEnabledTimestamp = updatedAt;
      await writeState(
        {
          ...current,
          state: 'starting',
          quarantine: retryingReceipt,
          revision: current.revision + 1,
          updatedAt: new Date().toISOString(),
          detail: `Retry requested by ${request.requestedBy}`,
        },
        stateDirectory,
      );
    });
    if (!retryTimestamp) return null;
    return (await readState(stateDirectory)) || current;
  } finally {
    await database.close();
  }
}

async function reconcilePendingQuarantine(current: GuardianState, stateDirectory: string): Promise<GuardianState> {
  const pending = current.quarantinePending;
  if (!pending) return current;
  const database = await StartupGuardianDatabase.connectFromEnvironment();
  try {
    const row = await database.readPlugin(pending.target);
    if (
      !row ||
      row.id !== pending.rowId ||
      row.version !== pending.prior.version ||
      !sameJson(row.options, pending.prior.options)
    ) {
      return transition(
        current,
        { state: 'recovery-required', detail: 'Pending quarantine row no longer matches its saved identity' },
        stateDirectory,
      );
    }
    if (row.enabled && row.updatedAtExact === pending.prior.updatedAt) {
      let receipt: QuarantineReceipt | undefined;
      await database.quarantinePlugin(pending.target, async (result) => {
        receipt = createReceipt(pending.incident, result);
        await writeState(
          {
            ...current,
            state: 'starting',
            incident: pending.incident,
            quarantine: receipt,
            quarantinePending: undefined,
            revision: current.revision + 1,
            updatedAt: new Date().toISOString(),
            detail: 'Recovered pending quarantine and recorded the durable receipt',
          },
          stateDirectory,
        );
      });
      return (await readState(stateDirectory)) || current;
    }
    if (!row.enabled && row.updatedAtExact !== pending.prior.updatedAt) {
      const receipt = createReceipt(pending.incident, {
        changed: true,
        target: pending.target,
        rowId: row.id,
        postUpdateTimestamp: row.updatedAtExact,
        priorUpdatedAt: pending.prior.updatedAt,
        before: {
          enabled: pending.prior.enabled,
          version: pending.prior.version,
          installed: pending.prior.installed,
          builtIn: pending.prior.builtIn,
          options: pending.prior.options,
          updatedAt: pending.prior.updatedAt,
        },
      });
      const next = await transition(
        current,
        { state: 'starting', incident: pending.incident, quarantine: receipt, quarantinePending: undefined },
        stateDirectory,
      );
      return next;
    }
    return transition(
      current,
      { state: 'recovery-required', detail: 'Pending quarantine could not be reconciled safely' },
      stateDirectory,
    );
  } finally {
    await database.close();
  }
}

async function reconcileQuarantineReceipt(current: GuardianState, stateDirectory: string): Promise<GuardianState> {
  const receipt = current.quarantine;
  if (!receipt) return current;
  const database = await StartupGuardianDatabase.connectFromEnvironment();
  try {
    const row = await database.readPlugin(receipt.target);
    if (!row || row.id !== receipt.rowId || !sameJson(row.options, receipt.prior.options)) {
      return transition(
        current,
        { state: 'recovery-required', detail: 'Quarantine receipt no longer matches its database row' },
        stateDirectory,
      );
    }
    const updatedAt = row.updatedAtExact;
    if (!row.enabled && updatedAt === receipt.postUpdateTimestamp) return current;
    if (row.enabled && updatedAt === receipt.prior.updatedAt) {
      let nextReceipt: QuarantineReceipt | undefined;
      await database.quarantinePlugin(receipt.target, async (result) => {
        nextReceipt = { ...createReceipt(receipt.incident, result), quarantineId: receipt.quarantineId };
        await writeState(
          {
            ...current,
            state: 'starting',
            quarantine: nextReceipt,
            revision: current.revision + 1,
            updatedAt: new Date().toISOString(),
            detail: 'Reconciled a committed or rolled-back quarantine transaction',
          },
          stateDirectory,
        );
      });
      return (await readState(stateDirectory)) || current;
    }
    return transition(
      current,
      { state: 'recovery-required', detail: 'Database row changed after quarantine; refusing to overwrite it' },
      stateDirectory,
    );
  } finally {
    await database.close();
  }
}

async function assertNoMandatoryDependent(packageName: string, enabled: EnabledPluginRow[]): Promise<void> {
  const nodeModulesPath = process.env.NODE_MODULES_PATH;
  if (!nodeModulesPath) throw new Error('NODE_MODULES_PATH is required to verify plugin dependency metadata');
  for (const candidate of enabled) {
    if (candidate.packageName === packageName) continue;
    const packageJson = await readPluginPackageJson(nodeModulesPath, candidate.packageName);
    const dependencies = readRequiredDependencies(packageJson);
    if (dependencies.has(packageName)) {
      throw new Error(`Enabled plugin ${candidate.packageName} has a mandatory dependency on ${packageName}`);
    }
  }
}

async function readPluginPackageJson(nodeModulesPath: string, packageName: string): Promise<Record<string, unknown>> {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(packageName)) {
    throw new Error('Enabled plugin package name is invalid; refusing dependency analysis');
  }
  const base = resolve(nodeModulesPath);
  const packagePath = resolve(base, ...packageName.split('/'), 'package.json');
  const relativePath = relative(base, packagePath);
  if (relativePath.startsWith(`..${sep}`) || relativePath === '..')
    throw new Error('Plugin dependency path escaped NODE_MODULES_PATH');
  const value: unknown = JSON.parse(await readFile(packagePath, 'utf8'));
  if (!value || typeof value !== 'object') throw new Error(`Plugin package metadata is invalid: ${packageName}`);
  return value as Record<string, unknown>;
}

function readRequiredDependencies(packageJson: Record<string, unknown>): Set<string> {
  const required = new Set<string>();
  for (const field of ['dependencies', 'peerDependencies']) {
    const dependencies = packageJson[field];
    if (!dependencies || typeof dependencies !== 'object') continue;
    for (const name of Object.keys(dependencies)) {
      if (field === 'peerDependencies') {
        const metadata = packageJson.peerDependenciesMeta;
        const meta = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>)[name] : undefined;
        if (meta && typeof meta === 'object' && (meta as Record<string, unknown>).optional === true) continue;
      }
      required.add(name);
    }
  }
  return required;
}

function matchesIdentity(incident: StartupIncident, state: GuardianState, bootId: string): boolean {
  return incident.appId === state.appId && incident.deploymentId === state.deploymentId && incident.bootId === bootId;
}

async function transition(
  current: GuardianState,
  patch: Partial<GuardianState>,
  stateDirectory: string,
): Promise<GuardianState> {
  const next = { ...current, ...patch, revision: current.revision + 1, updatedAt: new Date().toISOString() };
  await writeState(next, stateDirectory);
  return next;
}

async function terminateChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const grace = new Promise<void>((resolve) => setTimeout(resolve, graceMs));
  await Promise.race([exited, grace]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (child.exitCode === null && child.signalCode === null)
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
