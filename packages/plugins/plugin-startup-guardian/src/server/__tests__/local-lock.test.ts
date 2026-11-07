/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

describe('Startup Guardian local runner owner lock', () => {
  it('rejects a second OS process for the same state directory and releases only its own lock', async () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'startup-guardian-lock-'));
    const lockModulePath = resolve(__dirname, '../local-lock.ts');
    const script = [
      `const { acquireLocalLock } = require(${JSON.stringify(lockModulePath)});`,
      "(async () => { const lock = await acquireLocalLock(process.argv[1], 'runner-owner.lock', { appId: 'main', deploymentId: 'test' });",
      "process.stdout.write('LOCKED:' + process.pid + '\\n');",
      "process.stdin.on('data', async () => { await lock.release(); process.exit(0); }); })().catch((error) => { process.stderr.write(error.message + '\\n'); process.exitCode = 2; });",
    ].join('\n');
    const environment = {
      ...process.env,
      NODE_PATH: [process.env.NODE_PATH, resolve(process.cwd(), 'node_modules')].filter(Boolean).join(delimiter),
    };
    let owner: ChildProcessWithoutNullStreams | undefined;
    try {
      owner = spawn(
        process.execPath,
        ['--import', 'tsx', '--import', 'tsconfig-paths/register', '--eval', script, stateDirectory],
        { cwd: process.cwd(), env: environment, stdio: 'pipe', windowsHide: true },
      );
      const ownerOutput = await waitForOutput(owner, 'LOCKED:', 10_000);
      const ownerPid = Number(ownerOutput.split(':')[1]);
      expect(Number.isSafeInteger(ownerPid)).toBe(true);
      expect(ownerPid).not.toBe(process.pid);

      const contender = spawn(
        process.execPath,
        ['--import', 'tsx', '--import', 'tsconfig-paths/register', '--eval', script, stateDirectory],
        { cwd: process.cwd(), env: environment, stdio: 'pipe', windowsHide: true },
      );
      let contenderError = '';
      contender.stderr.on('data', (chunk: Buffer) => {
        contenderError += chunk.toString();
      });
      expect(await waitForExit(contender)).toBe(2);
      expect(contenderError).toContain('runner-owner.lock is already held');

      owner.stdin.write('stop');
      expect(await waitForExit(owner)).toBe(0);
      owner = undefined;
    } finally {
      if (owner && owner.exitCode === null) {
        owner.stdin.write('stop');
        await waitForExit(owner);
      }
      rmSync(stateDirectory, { recursive: true, force: true });
    }
  });
});

async function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  marker: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for child output ${marker}`)), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(marker)) {
        clearTimeout(timeout);
        resolve(output.trim());
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Lock owner exited before acquiring lock (code ${code}): ${output}`));
    });
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
}
