/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { execFileSync } from 'child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, resolve } from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '@nocobase/database';
import type { Application } from '@nocobase/server';
import { CodeValidator } from '../services/CodeValidator';
import { FileManager } from '../services/FileManager';
import type { SandboxRunner } from '../services/SandboxRunner';
import type { SkillRepositoryService } from '../services/SkillRepositoryService';
import { RegistrySkillInstallationService } from '../skill-hub/services/RegistrySkillInstallationService';
import { SkillExecutionTask } from '../skill-hub/tasks/SkillExecutionTask';

type Row = Record<string, unknown>;

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function model(values: Row) {
  return { ...values, get: (name: string) => values[name] };
}

async function installRegistryPackage(storageRoot: string, packageFiles: Array<{ path: string; content: string }>) {
  const packageRoot = resolve(storageRoot, 'registry-source');
  const installed = { values: null as Row | null };
  const skillDefinitions = {
    findOne: async () => null,
    create: async ({ values }: { values: Row }) => {
      installed.values = values;
      return model(values);
    },
    update: async () => undefined,
  };
  const installations = {
    findOne: async () => null,
    create: async ({ values }: { values: Row }) => model({ id: 'installation-1', ...values }),
    update: async () => undefined,
  };
  const database = {
    getRepository: (name: string) => {
      if (name === 'skillDefinitions') return skillDefinitions;
      if (name === 'skillRegistryInstallations') return installations;
      throw new Error(`Unexpected repository ${name}`);
    },
    sequelize: { transaction: async <T>(callback: (transaction: Record<string, never>) => Promise<T>) => callback({}) },
  } as unknown as Database;
  const repository = {
    readSkillPackageFiles: () => null,
    writeSkillPackage: (_name: string, files: Array<{ path: string; content: Buffer }>) => {
      for (const file of files) {
        const path = resolve(packageRoot, file.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.content);
      }
    },
    copySkillPackageTo: (_name: string, destination: string) => cpSync(packageRoot, destination, { recursive: true }),
    copyDirectoryTo: vi.fn(),
    removeSkillPackage: vi.fn(),
  } as unknown as SkillRepositoryService;
  const service = new RegistrySkillInstallationService(database, () => repository);

  await service.installRegistryVersion({
    registryPackageId: 'registry-package-1',
    registryVersionId: 'registry-version-1',
    packageIdentity: 'example/registry-report',
    version: '1.0.0',
    channel: 'stable',
    artifactDigest: 'digest',
    sourceSignature: null,
    updatePolicy: 'pinned',
    runtime: 'node',
    codeTemplate: 'registry source artifact',
    entrypoint: 'src/index.js',
    files: packageFiles.map((file) => ({ path: file.path, content: Buffer.from(file.content) })),
    instructions: 'Create a report.',
    inputSchema: { type: 'object' },
    dependencies: ['registry-addon'],
  });

  if (!installed.values) throw new Error('Registry installation did not persist a skill definition.');
  return { skill: installed.values, packageRoot };
}

async function executeInstalledRegistrySkill(options: {
  codeTemplate?: string;
  packageFiles?: Array<{ path: string; content: string }>;
  inputArgs?: string;
  registryPackageId?: string | null;
}) {
  const storageRoot = mkdtempSync(resolve(tmpdir(), 'registry-node-package-'));
  temporaryDirectories.push(storageRoot);
  const packageFiles = options.packageFiles ?? [
    {
      path: 'src/index.js',
      content:
        "const example = \"require('./missing-example.js')\"; // require('./missing-comment.js')\nconst helper = require('./helper.cjs'); const addon = require('registry-addon'); console.log(`${helper.value}:${addon.value}`);",
    },
    { path: 'src/helper.cjs', content: "module.exports = { value: 'registry' };" },
  ];
  const { skill: installedSkill, packageRoot } = await installRegistryPackage(storageRoot, packageFiles);
  const skillValues = {
    ...installedSkill,
    codeTemplate: options.codeTemplate ?? installedSkill.codeTemplate,
    ...(options.registryPackageId === undefined ? {} : { registryPackageId: options.registryPackageId }),
  };
  const skill = { ...skillValues, get: (name: string) => skillValues[name] };
  const executionValues: Row = {
    id: 'registry-exec-1',
    status: 'running',
    workerId: 'worker-1',
    inputArgs: options.inputArgs ?? '{}',
    runtimePolicy: null,
    skill,
  };
  const execution = { get: (name: string) => executionValues[name] };
  const fileManager = new FileManager(storageRoot);
  const validator = new CodeValidator();
  const sandboxRunner = {
    execute: vi.fn(async (params: Record<string, unknown>) => {
      const code = String(params.code);
      const language = params.language as 'node' | 'python';
      validator.validate(code, language);
      validator.validateImports(code, language, params.packageWhitelist as string[]);
      const skillDir = String(params.skillDir);
      const workDir = resolve(skillDir, '..');
      const inputFile = resolve(workDir, 'input.json');
      writeFileSync(inputFile, JSON.stringify(params.inputArgs ?? {}), 'utf8');
      const scriptPath = resolve(workDir, 'script.js');
      writeFileSync(scriptPath, code, 'utf8');
      const dependencyRoot = resolve(storageRoot, 'sandbox-workspace', 'node_modules');
      const dependencyPath = resolve(dependencyRoot, 'registry-addon');
      mkdirSync(dependencyPath, { recursive: true });
      writeFileSync(resolve(dependencyPath, 'index.js'), "module.exports = { value: 'allowed' };", 'utf8');
      const stdout = execFileSync(process.execPath, [scriptPath], {
        cwd: workDir,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', NODE_PATH: dependencyRoot, SKILL_INPUT_FILE: inputFile },
      });
      return { success: true, stdout: stdout.trim(), stderr: '', files: [], durationMs: 1 };
    }),
  };
  const updates: Array<{ values: Row; where: Row }> = [];
  const app = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    pubSubManager: {
      subscribe: vi.fn(async () => undefined),
      unsubscribe: vi.fn(async () => undefined),
      publish: vi.fn(async () => undefined),
    },
    db: {
      getRepository: (name: string) =>
        name === 'skillWorkerConfigs'
          ? {
              findOne: async () => ({
                packageWhitelist: JSON.stringify({ node: ['registry-addon'], python: [], apt: [] }),
              }),
            }
          : { findOne: async () => null },
      getModel: vi.fn(() => ({
        update: async (values: Row, query: { where: Row }) => {
          updates.push({ values, where: query.where });
          return [1];
        },
      })),
    },
    pm: { get: vi.fn(() => null), getPlugins: vi.fn(() => new Map()) },
  };
  const skillRepository = {
    getSkillPath: () => packageRoot,
    copySkillPackageTo: (_name: string, destination: string) => cpSync(packageRoot, destination, { recursive: true }),
    copyDirectoryTo: vi.fn(),
  };
  const task = new SkillExecutionTask(
    execution,
    sandboxRunner as unknown as SandboxRunner,
    fileManager,
    skillRepository as unknown as SkillRepositoryService,
    app as unknown as Application,
  );

  await task.run();

  const completion = updates[updates.length - 1]?.values;
  return { completion, sandboxRunner };
}

describe('registry Node package execution', () => {
  it.each([
    ['newly installed wrapper', undefined],
    ['legacy installed wrapper', `require(require('path').join(process.env.SKILL_DIR, "src/index.js"));\n`],
  ])('validates and executes the local package through SkillExecutionTask with a %s', async (_label, template) => {
    const { completion, sandboxRunner } = await executeInstalledRegistrySkill({ codeTemplate: template });

    expect(completion?.status).toBe('succeeded');
    expect(completion?.stdout).toBe('registry:allowed');
    expect(sandboxRunner.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'require("./skill/src/index.js");\n',
        packageWhitelist: ['registry-addon'],
      }),
    );
  });

  it('validates reachable helper modules before dispatching the child runner', async () => {
    const { completion, sandboxRunner } = await executeInstalledRegistrySkill({
      packageFiles: [
        { path: 'src/index.js', content: "require('./helper');" },
        { path: 'src/helper.js', content: 'module.exports = process.env.API_SECRET;' },
      ],
    });

    expect(completion?.status).toBe('failed');
    expect(completion?.stderr).toContain('process.env access not allowed');
    expect(sandboxRunner.execute).not.toHaveBeenCalled();
  });

  it('reads execution input JSON from the sandbox input file inside a package helper', async () => {
    const input = { label: 'worker-input', count: 7, ready: true };
    const { completion, sandboxRunner } = await executeInstalledRegistrySkill({
      inputArgs: JSON.stringify(input),
      packageFiles: [
        { path: 'src/index.js', content: "require('./helper.cjs');" },
        {
          path: 'src/helper.cjs',
          content:
            "const fs = require('fs'); const input = JSON.parse(fs.readFileSync(process.env.SKILL_INPUT_FILE, 'utf8')); console.log(`${input.label}:${input.count}:${input.ready}`);",
        },
      ],
    });

    expect(completion?.status).toBe('succeeded');
    expect(completion?.stdout).toBe('worker-input:7:true');
    expect(sandboxRunner.execute).toHaveBeenCalledWith(expect.objectContaining({ inputArgs: input }));
  });

  it('keeps SKILL_INPUT_FILE access limited to a validated registry package helper', async () => {
    const { completion, sandboxRunner } = await executeInstalledRegistrySkill({
      codeTemplate: 'console.log(process.env.SKILL_INPUT_FILE);',
      registryPackageId: null,
    });

    expect(completion?.status).toBe('failed');
    expect(completion?.stderr).toContain('process.env access not allowed');
    expect(sandboxRunner.execute).toHaveBeenCalledOnce();
  });

  it.each([
    ['require alias', "const load = require; load('./helper.js');"],
    ['module.require alias', "const load = module.require; load('./helper.js');"],
  ])('rejects a reachable helper with forbidden code through a %s', async (_label, entrypoint) => {
    const { completion, sandboxRunner } = await executeInstalledRegistrySkill({
      packageFiles: [
        { path: 'src/index.js', content: entrypoint },
        { path: 'src/helper.js', content: 'module.exports = process.env.API_SECRET;' },
      ],
    });

    expect(completion?.status).toBe('failed');
    expect(sandboxRunner.execute).not.toHaveBeenCalled();
  });

  it('rejects dynamic require in a reachable helper before dispatching the child runner', async () => {
    const { completion, sandboxRunner } = await executeInstalledRegistrySkill({
      packageFiles: [
        { path: 'src/index.js', content: "require('./helper.js');" },
        { path: 'src/helper.js', content: "const target = './hidden.js'; require(target);" },
      ],
    });

    expect(completion?.status).toBe('failed');
    expect(completion?.stderr).toContain('require() with a non-literal argument not allowed');
    expect(sandboxRunner.execute).not.toHaveBeenCalled();
  });

  it('rejects a path-traversing installed wrapper before package execution', async () => {
    const { completion, sandboxRunner } = await executeInstalledRegistrySkill({
      codeTemplate: 'require("./skill/../outside.js");\n',
    });

    expect(completion?.status).toBe('failed');
    expect(completion?.stderr).toContain('Registry Node package requires must stay inside the package.');
    expect(sandboxRunner.execute).not.toHaveBeenCalled();
  });
});
