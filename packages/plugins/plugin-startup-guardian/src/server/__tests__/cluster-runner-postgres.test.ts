/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { mockServer } from '@nocobase/test';
import { StartupGuardianDatabase } from '../database-adapter';
import { startupGuardianCli } from '../cli';
import { createDefaultPolicy } from '../policy';
import { createFingerprint, randomId } from '../security';
import type { SharedClusterControl, SharedClusterMember } from '../contracts';

const databaseHost = '127.0.0.1';
const databasePort = '55462';
const databaseName = 'guardian_ha_test';
const databaseUser = 'guardian_ha_test';
const databasePassword = 'guardian_ha_test_only';
const appId = 'ha-runner-proof';
const prefix = `grha_${randomId().replaceAll('-', '').slice(0, 10)}_`;
const redisUrl = 'redis://127.0.0.1:56389/5';
const pluginName = `ha-fixture-${randomId().slice(0, 8)}`;
const packageName = `plugin-${pluginName}`;
const pluginVersion = '1.2.3';
const runnerLogPath = join(tmpdir(), `startup-guardian-ha-runner-${process.pid}-${randomId().slice(0, 8)}.log`);
const keys = [
  'DB_DIALECT',
  'DB_HOST',
  'DB_PORT',
  'DB_DATABASE',
  'DB_USER',
  'DB_PASSWORD',
  'DB_SCHEMA',
  'DB_TABLE_PREFIX',
] as const;

interface RunnerProcess {
  child: ChildProcess;
  output: string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

describe('Startup Guardian two-node PostgreSQL and Redis runner integration', () => {
  const priorEnv = new Map(keys.map((key) => [key, process.env[key]]));
  const runners: RunnerProcess[] = [];
  let app: ReturnType<typeof mockServer>;
  let database: StartupGuardianDatabase;
  let temporaryDirectory = '';
  let nodeModulesPath = '';
  let faultMarker = '';
  let mainBootGateFile = '';
  let proofDirectory = '';

  beforeAll(async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'guardian-ha-runners-'));
    nodeModulesPath = join(temporaryDirectory, 'node_modules');
    faultMarker = join(temporaryDirectory, 'inject-load-failure');
    mainBootGateFile = join(temporaryDirectory, 'hold-main-boot');
    proofDirectory = join(temporaryDirectory, 'proof');
    createFaultPlugin(nodeModulesPath, faultMarker, pluginName, packageName, pluginVersion);
    mkdirSync(proofDirectory, { recursive: true });

    process.env.DB_DIALECT = 'postgres';
    process.env.DB_HOST = databaseHost;
    process.env.DB_PORT = databasePort;
    process.env.DB_DATABASE = databaseName;
    process.env.DB_USER = databaseUser;
    process.env.DB_PASSWORD = databasePassword;
    process.env.DB_SCHEMA = 'public';
    process.env.DB_TABLE_PREFIX = prefix;
    app = mockServer({
      name: appId,
      database: {
        dialect: 'postgres',
        host: databaseHost,
        port: Number(databasePort),
        database: databaseName,
        username: databaseUser,
        password: databasePassword,
        schema: 'public',
        tablePrefix: prefix,
        logging: false,
      },
      plugins: [],
    });
    await app.db.import({
      directory: resolve(process.cwd(), 'packages/plugins/plugin-startup-guardian/src/server/collections'),
    });
    await app.db.sync();
    await app.pm.repository.create({
      values: {
        name: pluginName,
        packageName,
        version: pluginVersion,
        enabled: true,
        installed: true,
        builtIn: false,
        options: { preserve: 'original' },
      },
    });
    database = await StartupGuardianDatabase.connectFromEnvironment();
  });

  afterEach(async () => {
    while (runners.length) await stopRunner(runners.pop() as RunnerProcess);
  });

  afterAll(async () => {
    await database?.close();
    await app?.destroy();
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
    for (const key of keys) {
      const value = priorEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('leaves the already-ready main process serving when a later backup failure has no approved policy', async () => {
    rmSync(faultMarker, { force: true });
    const deploymentId = `unapproved-${randomId().slice(0, 8)}`;
    expect(await startupGuardianCli(clusterInitArgs(deploymentId))).toBe(0);
    expect(await startupGuardianCli(['cluster', 'status', '--app-id', appId, '--deployment-id', deploymentId])).toBe(0);
    expect(await startupGuardianCli(['cluster', 'inspect', '--app-id', appId, '--deployment-id', deploymentId])).toBe(
      0,
    );
    const main = startRunner('main', deploymentId);
    await waitForProof('main', deploymentId, main);
    const beforeMain = await getMember(deploymentId, 'main');
    expect(beforeMain.state).toBe('ready');

    writeFileSync(faultMarker, 'fail', 'utf8');
    const backup = startRunner('backup', deploymentId);
    await waitUntil(async () => {
      const [control, member] = await Promise.all([
        database.readClusterControl(appId, deploymentId),
        getMember(deploymentId, 'backup'),
      ]);
      return control?.incident?.errorMessage === 'HA-FAULT-INJECTED-LOAD-ERROR' && member.state === 'stopped';
    }, [main, backup]);

    const [control, afterMain] = await Promise.all([
      database.readClusterControl(appId, deploymentId),
      getMember(deploymentId, 'main'),
    ]);
    expect(control).toMatchObject({ phase: 'ready', decisionRevision: 0, quarantineAttempts: 0 });
    expect(afterMain).toMatchObject({ state: 'ready', bootId: beforeMain.bootId, appliedRevision: 0 });
    expect(control?.incident).toMatchObject({
      pluginName,
      packageName,
      pluginVersion,
      phase: 'load',
      errorMessage: 'HA-FAULT-INJECTED-LOAD-ERROR',
    });
    const pluginProof = JSON.parse(
      readFileSync(join(proofDirectory, `${deploymentId}-backup-${control?.incident?.bootId}.plugin.json`), 'utf8'),
    ) as Record<string, unknown>;
    expect(pluginProof).toEqual({
      loadedPackage: packageName,
      manifestVersion: pluginVersion,
      optionVersion: pluginVersion,
      optionName: pluginName,
      optionPackageName: packageName,
    });
    const proof = readProof('main', deploymentId, beforeMain.bootId as string);
    expect(proof).toMatchObject({
      pid: expect.any(Number),
      httpStatus: 200,
      sawInitialGate: true,
      pluginLoaded: true,
      mode: 'redis-postgres-app-only-ha',
      decisionRevision: 0,
      policyRevision: 0,
      inspectHttpStatus: 200,
    });
  });

  it('drains the live cohort before one shared quarantine, then requires fresh ready boots on both nodes', async () => {
    rmSync(faultMarker, { force: true });
    const deploymentId = `approved-${randomId().slice(0, 8)}`;
    const policyFile = join(temporaryDirectory, `${deploymentId}.policy.json`);
    writeFileSync(policyFile, JSON.stringify(createApprovedPolicy()), 'utf8');
    expect(await startupGuardianCli(clusterInitArgs(deploymentId, policyFile))).toBe(0);
    const main = startRunner('main', deploymentId);
    const backup = startRunner('backup', deploymentId);
    await Promise.all([waitForProof('main', deploymentId, main), waitForProof('backup', deploymentId, backup)]);
    const oldMain = await getMember(deploymentId, 'main');
    const oldBackup = await getMember(deploymentId, 'backup');
    expect(oldMain.state).toBe('ready');
    expect(oldBackup.state).toBe('ready');

    writeFileSync(mainBootGateFile, 'hold', 'utf8');
    writeFileSync(faultMarker, 'fail', 'utf8');
    await stopRunner(backup);
    const backupIndex = runners.indexOf(backup);
    if (backupIndex >= 0) runners.splice(backupIndex, 1);
    await waitUntil(async () => (await getMember(deploymentId, 'backup')).state === 'stopped', [main]);
    const restartedBackup = startRunner('backup', deploymentId);

    await waitUntil(
      async () => {
        const [control, target, members] = await Promise.all([
          database.readClusterControl(appId, deploymentId),
          database.readPlugin({
            pluginName,
            packageName,
            pluginVersion,
          }),
          database.readClusterMembers(appId, deploymentId),
        ]);
        return (
          control?.phase === 'ready' &&
          control.decisionRevision === 1 &&
          control.quarantineAttempts === 1 &&
          target?.enabled === false &&
          members.length === 2 &&
          members.some(
            (member) =>
              member.nodeId === 'main' &&
              member.state === 'starting' &&
              member.appliedRevision === 0 &&
              member.bootId !== oldMain.bootId,
          )
        );
      },
      [main, restartedBackup],
      20_000,
      deploymentId,
    );

    const heldMain = await getMember(deploymentId, 'main');
    expect(existsSync(proofPath('main', deploymentId, heldMain.bootId as string))).toBe(false);
    // Simulate a newer committed shared decision while this main child is still held before app.load.
    await app.db.sequelize.query(
      `UPDATE "${prefix}startupGuardianClusterState" SET "decisionRevision" = 2, "revision" = "revision" + 1 WHERE "appId" = :appId AND "deploymentId" = :deploymentId AND "phase" = 'ready' AND "decisionRevision" = 1`,
      { replacements: { appId, deploymentId } },
    );
    await waitUntil(
      async () => {
        const [control, member] = await Promise.all([
          database.readClusterControl(appId, deploymentId),
          getMember(deploymentId, 'main'),
        ]);
        return (
          control?.decisionRevision === 2 &&
          member.state === 'starting' &&
          member.appliedRevision === 0 &&
          member.bootId !== heldMain.bootId
        );
      },
      [main, restartedBackup],
      20_000,
      deploymentId,
    );
    rmSync(mainBootGateFile, { force: true });
    await waitUntil(
      async () => {
        const [control, target, members] = await Promise.all([
          database.readClusterControl(appId, deploymentId),
          database.readPlugin({ pluginName, packageName, pluginVersion }),
          database.readClusterMembers(appId, deploymentId),
        ]);
        return (
          control?.phase === 'ready' &&
          control.decisionRevision === 2 &&
          control.quarantineAttempts === 1 &&
          target?.enabled === false &&
          members.length === 2 &&
          members.every(
            (member) =>
              member.state === 'ready' &&
              member.appliedRevision === 2 &&
              Boolean(member.bootId) &&
              existsSync(proofPath(member.nodeId, deploymentId, member.bootId as string)),
          )
        );
      },
      [main, restartedBackup],
      45_000,
      deploymentId,
    );

    const [control, members, target] = await Promise.all([
      database.readClusterControl(appId, deploymentId),
      database.readClusterMembers(appId, deploymentId),
      database.readPlugin({ pluginName, packageName, pluginVersion }),
    ]);
    expect(control).toMatchObject({ phase: 'ready', decisionRevision: 2, quarantineAttempts: 1 });
    expect(target).toMatchObject({ enabled: false, installed: true, options: { preserve: 'original' } });
    expect(members).toHaveLength(2);
    expect(members.every((member) => member.state === 'ready' && member.appliedRevision === 2)).toBe(true);
    expect(members.find((member) => member.nodeId === 'main')?.bootId).not.toBe(oldMain.bootId);
    expect(members.find((member) => member.nodeId === 'main')?.bootId).not.toBe(heldMain.bootId);
    expect(members.find((member) => member.nodeId === 'backup')?.bootId).not.toBe(oldBackup.bootId);
    expect(countAppChildBootstraps(deploymentId, 'main')).toBe(3);
    expect(countAppChildBootstraps(deploymentId, 'backup')).toBe(4);
    expect(existsSync(join(proofDirectory, `${deploymentId}-main-${oldMain.bootId}.drained.log`))).toBe(true);
    for (const member of members) {
      if (!member.bootId) throw new Error(`Member ${member.nodeId} has no final boot id`);
      expect(readProof(member.nodeId, deploymentId, member.bootId)).toMatchObject({
        httpStatus: 200,
        sawInitialGate: true,
        pluginLoaded: false,
        mode: 'redis-postgres-app-only-ha',
        decisionRevision: 2,
        policyRevision: 0,
        inspectHttpStatus: 200,
      });
    }
  });

  function startRunner(nodeId: string, deploymentId: string): RunnerProcess {
    const runnerPath = resolve(__dirname, 'fixtures', 'ha-supervisor-worker.ts');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DB_DIALECT: 'postgres',
      DB_HOST: databaseHost,
      DB_PORT: databasePort,
      DB_DATABASE: databaseName,
      DB_USER: databaseUser,
      DB_PASSWORD: databasePassword,
      DB_SCHEMA: 'public',
      DB_TABLE_PREFIX: prefix,
      NODE_MODULES_PATH: nodeModulesPath,
      NODE_PATH: [
        nodeModulesPath,
        resolve(process.cwd(), 'node_modules'),
        resolve(tmpdir(), 'nocobase-custom-fix-deps/node_modules'),
      ].join(delimiter),
      PLUGIN_PACKAGE_PREFIX: 'plugin-',
      APP_ROLE: 'app',
      WORKER_MODE: 'main',
      LOCK_ADAPTER_REDIS_URL: redisUrl,
      NODE_REGISTRY_REDIS_URL: redisUrl,
      STARTUP_GUARDIAN_CLUSTER_MODE: 'redis-postgres',
      STARTUP_GUARDIAN_CLUSTER_NO_WORKERS: 'true',
      STARTUP_GUARDIAN_CLUSTER_MEMBERS: 'main,backup',
      STARTUP_GUARDIAN_APP_ID: appId,
      STARTUP_GUARDIAN_DEPLOYMENT_ID: deploymentId,
      STARTUP_GUARDIAN_NODE_ID: nodeId,
      STARTUP_GUARDIAN_STATE_DIR: join(temporaryDirectory, 'nodes', deploymentId, nodeId),
      STARTUP_GUARDIAN_CLUSTER_PROOF_DIR: proofDirectory,
      STARTUP_GUARDIAN_PLUGIN_PROOF_DIR: proofDirectory,
      STARTUP_GUARDIAN_TEST_TRACE_FILE: runnerLogPath,
      STARTUP_GUARDIAN_TEST_MAIN_BOOT_GATE_FILE: mainBootGateFile,
      STARTUP_GUARDIAN_FAULT_MARKER: faultMarker,
      STARTUP_GUARDIAN_FAULT_PLUGIN_NAME: pluginName,
      VITEST: '',
    };
    const child = spawn(
      process.execPath,
      [
        '--import',
        pathToFileURL(resolve(__dirname, 'fixtures', 'ha-process-bootstrap.cjs')).href,
        '--import',
        'tsx',
        '--import',
        'tsconfig-paths/register',
        runnerPath,
      ],
      {
        cwd: process.cwd(),
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      },
    );
    const processInfo: RunnerProcess = {
      child,
      output: '',
      exit: once(child, 'exit').then(([code, signal]) => ({ code, signal })),
    };
    child.stdout?.on('data', (chunk: Buffer) => appendRunnerOutput(processInfo, chunk));
    child.stderr?.on('data', (chunk: Buffer) => appendRunnerOutput(processInfo, chunk));
    runners.push(processInfo);
    return processInfo;
  }

  async function waitForProof(nodeId: string, deploymentId: string, runner: RunnerProcess): Promise<void> {
    await waitUntil(
      async () => {
        const member = await getMember(deploymentId, nodeId);
        return (
          member.state === 'ready' &&
          Boolean(member.bootId) &&
          existsSync(proofPath(nodeId, deploymentId, member.bootId as string))
        );
      },
      [runner],
      60_000,
      deploymentId,
    );
  }

  async function getMember(deploymentId: string, nodeId: string): Promise<SharedClusterMember> {
    const member = (await database.readClusterMembers(appId, deploymentId)).find((item) => item.nodeId === nodeId);
    if (!member) throw new Error(`Expected enrolled node ${nodeId} in ${deploymentId}`);
    return member;
  }

  function proofPath(nodeId: string, deploymentId: string, bootId: string): string {
    return join(proofDirectory, `${deploymentId}-${nodeId}-${bootId}.json`);
  }

  function readProof(nodeId: string, deploymentId: string, bootId: string): Record<string, unknown> {
    const file = proofPath(nodeId, deploymentId, bootId);
    if (!existsSync(file)) throw new Error(`Missing app HTTP readiness proof ${file}`);
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  }

  function countAppChildBootstraps(deploymentId: string, nodeId: string): number {
    return readFileSync(runnerLogPath, 'utf8')
      .split('\n')
      .filter(
        (line) =>
          line.includes('[ha-test-bootstrap') &&
          line.includes(`deployment=${deploymentId} node=${nodeId} boot=`) &&
          !line.includes('boot=runner]'),
      ).length;
  }

  async function waitUntil(
    check: () => Promise<boolean>,
    active: RunnerProcess[],
    timeoutMs = 60_000,
    deploymentId?: string,
  ): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await check()) return;
      for (const runner of active) {
        if (runner.child.exitCode !== null) throw new Error(`HA runner exited early: ${runner.output}`);
      }
      await delay(100);
    }
    const latest: SharedClusterControl | null = deploymentId
      ? await database.readClusterControl(appId, deploymentId).catch(() => null)
      : null;
    throw new Error(
      `Timed out waiting for HA runner condition; current state=${JSON.stringify(
        latest,
      )}; logFile=${runnerLogPath}; logs=${active.map((item) => item.output).join('\n')}`,
    );
  }

  async function stopRunner(runner: RunnerProcess): Promise<void> {
    if (runner.child.exitCode !== null) return;
    if (runner.child.connected) runner.child.send({ type: 'stop' });
    const finished = await Promise.race([runner.exit.then(() => true), delay(12_000).then(() => false)]);
    if (!finished) runner.child.kill();
    await runner.exit;
  }
});

function createFaultPlugin(
  nodeModulesPath: string,
  failureMarker: string,
  pluginName: string,
  packageName: string,
  pluginVersion: string,
): void {
  const packageDirectory = join(nodeModulesPath, packageName);
  mkdirSync(join(packageDirectory, 'dist', 'client'), { recursive: true });
  mkdirSync(join(packageDirectory, 'dist', 'client-v2'), { recursive: true });
  writeFileSync(
    join(packageDirectory, 'package.json'),
    JSON.stringify({ name: packageName, version: pluginVersion, main: 'index.js' }),
  );
  writeFileSync(
    join(packageDirectory, 'index.js'),
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const { Plugin } = require('@nocobase/server');",
      'module.exports = class FaultyPlugin extends Plugin {',
      `  async load() { const packageJson = require('./package.json'); const proofDirectory = process.env.STARTUP_GUARDIAN_PLUGIN_PROOF_DIR; if (proofDirectory) fs.writeFileSync(path.join(proofDirectory, process.env.STARTUP_GUARDIAN_DEPLOYMENT_ID + '-' + process.env.STARTUP_GUARDIAN_NODE_ID + '-' + process.env.STARTUP_GUARDIAN_BOOT_ID + '.plugin.json'), JSON.stringify({ loadedPackage: packageJson.name, manifestVersion: packageJson.version, optionVersion: this.options.version, optionName: this.options.name, optionPackageName: this.options.packageName })); if (process.env.STARTUP_GUARDIAN_NODE_ID === 'backup' && fs.existsSync(${JSON.stringify(
        failureMarker,
      )})) throw new Error('HA-FAULT-INJECTED-LOAD-ERROR'); }`,
      '};',
    ].join('\n'),
  );
  writeFileSync(join(packageDirectory, 'dist', 'client', 'index.js'), 'export default class FaultyPluginClient {}\n');
  writeFileSync(
    join(packageDirectory, 'dist', 'client-v2', 'index.js'),
    'export default class FaultyPluginClientV2 {}\n',
  );
}

function createApprovedPolicy() {
  const message = 'HA-FAULT-INJECTED-LOAD-ERROR';
  const policy = createDefaultPolicy();
  policy.autoRecoveryEnabled = true;
  policy.approvedRules.push({
    pluginName,
    packageName,
    pluginVersion,
    phase: 'load',
    fingerprint: createFingerprint({
      pluginName,
      packageName,
      pluginVersion,
      phase: 'load',
      errorName: 'Error',
      errorMessage: message,
    }),
    approvedBy: 'ha-integration-test',
    approvedAt: new Date().toISOString(),
  });
  return policy;
}

function clusterInitArgs(deploymentId: string, policyFile?: string): string[] {
  return [
    'cluster',
    'init',
    '--app-id',
    appId,
    '--deployment-id',
    deploymentId,
    '--members',
    'main,backup',
    '--all-app-nodes-stopped',
    '--app-only',
    ...(policyFile ? ['--policy-file', policyFile, '--enable-auto-recovery'] : []),
  ];
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function appendRunnerOutput(processInfo: RunnerProcess, chunk: Buffer): void {
  const text = chunk.toString();
  processInfo.output = `${processInfo.output}${text}`.slice(-15_000);
  appendFileSync(runnerLogPath, text, 'utf8');
}
