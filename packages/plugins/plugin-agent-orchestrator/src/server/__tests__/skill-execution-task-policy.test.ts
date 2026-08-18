import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type Application from '@nocobase/server';
import { FileManager } from '../services/FileManager';
import type { SandboxRunner } from '../services/SandboxRunner';
import type { SkillRepositoryService } from '../services/SkillRepositoryService';
import { SkillExecutionTask } from '../skill-hub/tasks/SkillExecutionTask';
import { parseJsonText } from '../skill-hub/utils/json-fields';

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
});

function createTask(options: {
  runtimePolicy?: Record<string, unknown> | null;
  stdout?: string;
  skillTimeoutSeconds?: number;
}) {
  const storagePath = mkdtempSync(resolve(tmpdir(), 'skill-task-policy-'));
  tempDirs.push(storagePath);
  const fileManager = new FileManager(storagePath);
  const updates: Array<{ values: Record<string, unknown>; where: Record<string, unknown> }> = [];
  const doneMessages: Array<Record<string, unknown>> = [];
  const sandboxRunner = {
    execute: vi.fn(async (params: Record<string, unknown>) => ({
      success: true,
      stdout: options.stdout ?? 'hello',
      stderr: '',
      files: [],
      durationMs: 12,
    })),
  };
  const skillRepoService = {
    getSkillPath: (name: string) => resolve(storagePath, 'skills', name),
    copySkillPackageTo: vi.fn(),
    copyDirectoryTo: vi.fn(),
  };
  const skill = {
    storageType: 'inline',
    codeTemplate: 'console.log("hi")',
    language: 'node',
    timeoutSeconds: options.skillTimeoutSeconds ?? 60,
    maxOutputSizeMb: 50,
    name: 'test-skill',
    fileId: null,
  };
  const executionValues: Record<string, unknown> = {
    id: 42,
    status: 'running',
    workerId: 'worker-1',
    inputArgs: '{}',
    runtimePolicy: options.runtimePolicy ?? null,
    skill,
  };
  const execution = { get: (key: string) => executionValues[key] };
  const app = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    pubSubManager: {
      subscribe: vi.fn(async () => undefined),
      unsubscribe: vi.fn(async () => undefined),
      publish: vi.fn(async (channel: string, message: Record<string, unknown>) => {
        if (channel === 'skill-hub.done.42') doneMessages.push(message);
      }),
    },
    db: {
      getRepository: vi.fn(() => ({ findOne: async () => null })),
      getModel: vi.fn(() => ({
        update: async (values: Record<string, unknown>, opts: { where: Record<string, unknown> }) => {
          updates.push({ values, where: opts.where });
          return [1];
        },
      })),
    },
    pm: { get: vi.fn(() => null), getPlugins: vi.fn(() => new Map()) },
  };
  const task = new SkillExecutionTask(
    execution,
    sandboxRunner as unknown as SandboxRunner,
    fileManager,
    skillRepoService as unknown as SkillRepositoryService,
    app as unknown as Application,
  );
  return { task, sandboxRunner, fileManager, updates, doneMessages };
}

describe('SkillExecutionTask harness runtime policy', () => {
  it('caps the sandbox timeout with the harness policy without widening it', async () => {
    const capped = createTask({ runtimePolicy: { timeoutSeconds: 15 }, skillTimeoutSeconds: 60 });
    await capped.task.run();
    expect(capped.sandboxRunner.execute.mock.calls[0][0].timeoutSeconds).toBe(15);

    const permissive = createTask({ runtimePolicy: { timeoutSeconds: 120 }, skillTimeoutSeconds: 60 });
    await permissive.task.run();
    expect(permissive.sandboxRunner.execute.mock.calls[0][0].timeoutSeconds).toBe(60);
  });

  it('spills oversized stdout to the output directory and stores a bounded preview', async () => {
    const stdout = `START-MARKER ${'z'.repeat(8000)} END-MARKER`;
    const { task, fileManager, updates, doneMessages } = createTask({
      runtimePolicy: { spillMaxInlineBytes: 600 },
      stdout,
    });

    await task.run();

    const finalUpdate = updates[updates.length - 1]?.values;
    expect(finalUpdate?.status).toBe('succeeded');
    const storedStdout = String(finalUpdate?.stdout);
    expect(storedStdout).toContain('START-MARKER');
    expect(storedStdout).toContain('END-MARKER');
    expect(storedStdout).toContain('/api/skillHub:download?execId=42&f=');
    expect(Buffer.byteLength(storedStdout, 'utf8')).toBeLessThanOrEqual(600);

    // The full text is retrievable through the output directory.
    const spillPath = resolve(fileManager.getOutputDir('42'), 'stdout-full.txt');
    expect(readFileSync(spillPath, 'utf8')).toBe(stdout);

    const outputFiles = parseJsonText(finalUpdate?.outputFiles, [] as Array<{ name: string }>);
    expect(outputFiles.some((file) => file.name === 'stdout-full.txt')).toBe(true);
    expect(doneMessages[0]?.stdout).toBe(storedStdout.slice(0, 3000));
  });

  it('keeps stdout inline when no spill budget applies', async () => {
    const { task, updates } = createTask({ stdout: 'plain output' });

    await task.run();

    expect(updates[updates.length - 1]?.values.stdout).toBe('plain output');
  });
});
