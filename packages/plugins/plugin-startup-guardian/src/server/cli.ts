/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readIncidents, readState, getStateDirectory } from './journal';
import {
  addApprovedRule,
  approveIncidentInPolicy,
  createDefaultPolicy,
  isGuardianPolicy,
  readPolicy,
  requestRetry,
  setAutoRecoveryInPolicy,
  setAutoRecoveryEnabled,
} from './policy';
import { isClusterModeEnabled } from './cluster-mode';
import { redactText } from './security';

interface ParsedOptions {
  options: Record<string, string>;
  positional: string[];
}

export async function startupGuardianCli(args: string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...commandArgs] = args;
  try {
    if (command === 'start') return await start(commandArgs);
    if (command === 'cluster') return await clusterCommand(commandArgs);
    if (isClusterModeEnabled() && ['approve', 'auto', 'retry'].includes(command || '')) {
      throw new Error(
        'Local policy and retry commands are disabled in HA mode. Use `startup-guardian cluster approve|auto` for shared policy; HA retry is not supported.',
      );
    }
    if (command === 'status') {
      if (isClusterModeEnabled()) return await clusterReadCommand('status', []);
      const appId = process.env.STARTUP_GUARDIAN_APP_ID || process.env.APP_NAME || 'main';
      const stateDirectory = getStateDirectory(appId);
      const [state, policy] = await Promise.all([readState(stateDirectory), readPolicy(stateDirectory)]);
      writeOutput({ state, policy, mode: 'single-node' });
      return 0;
    }
    if (command === 'inspect') {
      if (isClusterModeEnabled()) return await clusterReadCommand('inspect', []);
      const appId = process.env.STARTUP_GUARDIAN_APP_ID || process.env.APP_NAME || 'main';
      const stateDirectory = getStateDirectory(appId);
      const [state, incidents] = await Promise.all([readState(stateDirectory), readIncidents(stateDirectory)]);
      writeOutput({ state, incidents: incidents.slice(-100).reverse(), mode: 'single-node' });
      return 0;
    }
    if (command === 'approve') {
      const appId = process.env.STARTUP_GUARDIAN_APP_ID || process.env.APP_NAME || 'main';
      const stateDirectory = getStateDirectory(appId);
      const eventId = commandArgs[0];
      if (!eventId || commandArgs.length !== 1) throw new Error('Usage: startup-guardian approve <event-id>');
      const incident = (await readIncidents(stateDirectory)).find((entry) => entry.eventId === eventId);
      if (!incident) throw new Error('No observed incident matches that event id');
      writeOutput({ policy: await addApprovedRule(incident, 'local-operator', stateDirectory) });
      return 0;
    }
    if (command === 'auto') {
      if (commandArgs.length !== 1 || !['on', 'off'].includes(commandArgs[0])) {
        throw new Error('Usage: startup-guardian auto <on|off>');
      }
      const appId = process.env.STARTUP_GUARDIAN_APP_ID || process.env.APP_NAME || 'main';
      const stateDirectory = getStateDirectory(appId);
      writeOutput({ policy: await setAutoRecoveryEnabled(commandArgs[0] === 'on', stateDirectory) });
      return 0;
    }
    if (command === 'retry') {
      const appId = process.env.STARTUP_GUARDIAN_APP_ID || process.env.APP_NAME || 'main';
      const stateDirectory = getStateDirectory(appId);
      const { options, positional } = parseOptions(commandArgs, ['expected-revision']);
      const packageName = positional[0];
      const revision = Number(options['expected-revision']);
      if (positional.length !== 1 || !Number.isSafeInteger(revision) || revision < 0) {
        throw new Error('Usage: startup-guardian retry <package-name> --expected-revision <revision>');
      }
      writeOutput({
        request: await requestRetry(
          { packageName, expectedRevision: revision, requestedBy: 'local-operator' },
          stateDirectory,
        ),
      });
      return 0;
    }
    throw new Error(
      'Usage: startup-guardian <start|status|inspect|approve|auto|retry|cluster init|status|inspect|approve|auto|retry>',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${redactText(message)}\n`);
    return 2;
  }
}

async function clusterCommand(args: string[]): Promise<number> {
  const [subcommand, ...commandArgs] = args;
  if (subcommand === 'init') return clusterInitialize(commandArgs);
  if (subcommand === 'status' || subcommand === 'inspect') return clusterReadCommand(subcommand, commandArgs);
  if (subcommand === 'approve') return clusterApprove(commandArgs);
  if (subcommand === 'auto') return clusterSetAutoRecovery(commandArgs);
  if (subcommand === 'retry') {
    throw new Error(
      'Shared HA retry is not supported. The plugin remains quarantined; plan a whole-cohort maintenance procedure before manually changing applicationPlugins.',
    );
  }
  throw new Error(
    'Usage: startup-guardian cluster <init|status|inspect|approve|auto|retry>; HA retry is intentionally unsupported.',
  );
}

async function clusterInitialize(args: string[]): Promise<number> {
  const { options, positional } = parseOptions(
    args,
    ['app-id', 'deployment-id', 'members', 'policy-file', 'max-attempts'],
    ['all-app-nodes-stopped', 'app-only', 'enable-auto-recovery'],
  );
  if (positional.length !== 0) throw new Error('Unexpected positional argument to cluster init');
  if (options['all-app-nodes-stopped'] !== 'true') {
    throw new Error('cluster init requires --all-app-nodes-stopped after every app process is stopped');
  }
  if (options['app-only'] !== 'true') {
    throw new Error('cluster init requires --app-only after confirming no shared-database worker or sandbox process');
  }
  const appId = requiredOption(options, 'app-id');
  const deploymentId = requiredOption(options, 'deployment-id');
  const members = requiredOption(options, 'members')
    .split(',')
    .map((member) => member.trim())
    .filter(Boolean);
  if (members.length === 0 || new Set(members).size !== members.length) {
    throw new Error('--members must contain a non-empty, comma-separated list of unique app-node identities');
  }
  let policy = createDefaultPolicy();
  if (options['policy-file']) {
    const raw = await readFile(resolve(options['policy-file']), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isGuardianPolicy(parsed))
      throw new Error('--policy-file must contain a complete valid Guardian policy JSON object');
    policy = parsed;
  }
  const enableAutoRecovery = options['enable-auto-recovery'] === 'true';
  if (policy.autoRecoveryEnabled !== enableAutoRecovery) {
    throw new Error('Automatic recovery policy requires matching --enable-auto-recovery opt-in');
  }
  if (enableAutoRecovery && policy.approvedRules.length === 0) {
    throw new Error('Automatic recovery requires at least one exact approved policy rule');
  }
  const maxAttempts = options['max-attempts'] === undefined ? 2 : Number(options['max-attempts']);
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error('--max-attempts must be an integer from 1 through 10');
  }

  await initializeDatabaseEnvironment();
  const { StartupGuardianDatabase } = await import('./database-adapter');
  const database = await StartupGuardianDatabase.connectFromEnvironment();
  try {
    await database.initializeCluster({ appId, deploymentId, members, policy, maxQuarantineAttempts: maxAttempts });
  } finally {
    await database.close();
  }
  writeOutput({
    initialized: true,
    appId,
    deploymentId,
    expectedMembers: [...members].sort(),
    allAppNodesStopped: true,
    appOnlyAcknowledged: true,
    policyRevision: policy.revision,
    autoRecoveryEnabled: policy.autoRecoveryEnabled,
    maxQuarantineAttempts: maxAttempts,
  });
  return 0;
}

async function clusterReadCommand(command: 'status' | 'inspect', args: string[]): Promise<number> {
  const { options, positional } = parseOptions(args, ['app-id', 'deployment-id']);
  if (positional.length !== 0) throw new Error(`Unexpected positional argument to cluster ${command}`);
  const identity = resolveClusterIdentity(options);
  const { StartupGuardianDatabase } = await connectClusterDatabase();
  const database = await StartupGuardianDatabase.connectFromEnvironment();
  try {
    const control = await database.readClusterControl(identity.appId, identity.deploymentId);
    if (!control) throw new Error('HA cluster enrollment is missing for the selected app and deployment');
    const members = await database.readClusterMembers(identity.appId, identity.deploymentId);
    writeOutput({ mode: 'redis-postgres-app-only-ha', control, members });
    return 0;
  } finally {
    await database.close();
  }
}

async function clusterApprove(args: string[]): Promise<number> {
  const { options, positional } = parseOptions(args, ['app-id', 'deployment-id', 'expected-policy-revision']);
  if (positional.length !== 1) {
    throw new Error('Usage: startup-guardian cluster approve <event-id> --expected-policy-revision <revision>');
  }
  const expectedPolicyRevision = parseExpectedPolicyRevision(options);
  const identity = resolveClusterIdentity(options);
  await initializeDatabaseEnvironment();
  const { StartupGuardianDatabase } = await import('./database-adapter');
  const database = await StartupGuardianDatabase.connectFromEnvironment();
  try {
    const control = await database.readClusterControl(identity.appId, identity.deploymentId);
    if (!control?.incident || control.incident.eventId !== positional[0]) {
      throw new Error('No current shared HA incident matches that event id; run cluster inspect first');
    }
    const policy = approveIncidentInPolicy(control.policy, control.incident, 'local-operator');
    if (policy === control.policy) {
      writeOutput({ policy, policyRevision: control.policyRevision, unchanged: true });
      return 0;
    }
    const updated = await database.updateClusterPolicy({
      ...identity,
      expectedPolicyRevision,
      policy,
    });
    writeOutput({ policy: updated.policy, policyRevision: updated.policyRevision });
    return 0;
  } finally {
    await database.close();
  }
}

async function clusterSetAutoRecovery(args: string[]): Promise<number> {
  const { options, positional } = parseOptions(args, ['app-id', 'deployment-id', 'expected-policy-revision']);
  if (positional.length !== 1 || !['on', 'off'].includes(positional[0])) {
    throw new Error('Usage: startup-guardian cluster auto <on|off> --expected-policy-revision <revision>');
  }
  const expectedPolicyRevision = parseExpectedPolicyRevision(options);
  const identity = resolveClusterIdentity(options);
  await initializeDatabaseEnvironment();
  const { StartupGuardianDatabase } = await import('./database-adapter');
  const database = await StartupGuardianDatabase.connectFromEnvironment();
  try {
    const control = await database.readClusterControl(identity.appId, identity.deploymentId);
    if (!control) throw new Error('HA cluster enrollment is missing for the selected app and deployment');
    const policy = setAutoRecoveryInPolicy(control.policy, positional[0] === 'on');
    if (policy === control.policy) {
      writeOutput({ policy, policyRevision: control.policyRevision, unchanged: true });
      return 0;
    }
    const updated = await database.updateClusterPolicy({
      ...identity,
      expectedPolicyRevision,
      policy,
    });
    writeOutput({ policy: updated.policy, policyRevision: updated.policyRevision });
    return 0;
  } finally {
    await database.close();
  }
}

async function connectClusterDatabase(): Promise<typeof import('./database-adapter')> {
  await initializeDatabaseEnvironment();
  return import('./database-adapter');
}

async function initializeDatabaseEnvironment(): Promise<void> {
  const { initEnv } = await import('@nocobase/cli-v1');
  initEnv();
}

function resolveClusterIdentity(options: Record<string, string>): { appId: string; deploymentId: string } {
  const appId = options['app-id'] || process.env.STARTUP_GUARDIAN_APP_ID || process.env.APP_NAME || 'main';
  const deploymentId = options['deployment-id'] || process.env.STARTUP_GUARDIAN_DEPLOYMENT_ID || '';
  if (!deploymentId) throw new Error('--deployment-id or STARTUP_GUARDIAN_DEPLOYMENT_ID is required for HA commands');
  return { appId, deploymentId };
}

function parseExpectedPolicyRevision(options: Record<string, string>): number {
  const revision = Number(options['expected-policy-revision']);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('--expected-policy-revision must be a non-negative integer from the latest cluster status');
  }
  return revision;
}

function requiredOption(options: Record<string, string>, name: string): string {
  const value = options[name]?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

async function start(args: string[]): Promise<number> {
  const separator = args.indexOf('--');
  if (separator < 0)
    throw new Error('Usage: startup-guardian start [--app-id <id>] [--deployment-id <id>] -- <command> [args...]');
  const { options, positional } = parseOptions(args.slice(0, separator), ['app-id', 'deployment-id']);
  if (positional.length !== 0) throw new Error('Unexpected argument before --');
  const [command, ...childArgs] = args.slice(separator + 1);
  if (!command) throw new Error('A child command is required after --');

  const { generateAppDir, initEnv } = await import('@nocobase/cli-v1');
  initEnv();
  generateAppDir();
  const appId = options['app-id'] || process.env.STARTUP_GUARDIAN_APP_ID || process.env.APP_NAME || 'main';
  const deploymentId = options['deployment-id'] || process.env.STARTUP_GUARDIAN_DEPLOYMENT_ID || 'single-node';
  if (process.env.STARTUP_GUARDIAN_APP_ID && process.env.STARTUP_GUARDIAN_APP_ID !== appId) {
    throw new Error('Configured Startup Guardian app identity does not match --app-id');
  }
  process.env.STARTUP_GUARDIAN_APP_ID = appId;
  process.env.STARTUP_GUARDIAN_DEPLOYMENT_ID = deploymentId;
  const stateDirectory = getStateDirectory(appId);
  const { startGuardianSupervisor } = await import('./runner');
  const supervisor = startGuardianSupervisor({
    command,
    args: childArgs,
    cwd: process.cwd(),
    env: {
      STARTUP_GUARDIAN_APP_ID: appId,
      STARTUP_GUARDIAN_DEPLOYMENT_ID: deploymentId,
    },
    stateDirectory,
    appId,
    deploymentId,
  });
  let stopPromise: Promise<void> | undefined;
  const stop = () => {
    stopPromise ??= supervisor.stop();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const exitCode = await supervisor.done;
    await stopPromise;
    return exitCode;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

function parseOptions(args: string[], allowed: string[], flags: string[] = []): ParsedOptions {
  const options: Record<string, string> = {};
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const name = value.slice(2);
    if ((!allowed.includes(name) && !flags.includes(name)) || options[name] !== undefined) {
      throw new Error(`Unsupported or repeated option: ${value}`);
    }
    if (flags.includes(name)) {
      options[name] = 'true';
      continue;
    }
    const optionValue = args[index + 1];
    if (!optionValue || optionValue.startsWith('--')) throw new Error(`Option ${value} requires a value`);
    options[name] = optionValue;
    index += 1;
  }
  return { options, positional };
}

function writeOutput(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
