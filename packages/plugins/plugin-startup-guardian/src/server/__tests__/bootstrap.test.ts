/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('NocoBase child bootstrap', () => {
  it('forwards a direct start argv after running the CLI environment initializers', () => {
    const directory = mkdtempSync(join(tmpdir(), 'startup-guardian-bootstrap-'));
    try {
      const modulesDirectory = join(directory, 'node_modules');
      const cliDirectory = join(modulesDirectory, '@nocobase', 'cli-v1');
      const appDirectory = join(modulesDirectory, '@nocobase', 'app');
      const receiptPath = join(directory, 'bootstrap-receipt.json');
      const bootstrapPath = join(directory, 'nocobase-child.cjs');
      mkdirSync(cliDirectory, { recursive: true });
      mkdirSync(appDirectory, { recursive: true });
      copyFileSync(resolve('packages/plugins/plugin-startup-guardian/bin/nocobase-child.cjs'), bootstrapPath);
      writeFileSync(
        join(cliDirectory, 'index.js'),
        [
          'exports.initEnv = () => { process.env.GUARDIAN_INIT_ENV_CALLED = "true"; };',
          'exports.generateAppDir = () => { process.env.GUARDIAN_GENERATE_APP_DIR_CALLED = "true"; };',
        ].join('\n'),
      );
      writeFileSync(join(appDirectory, 'package.json'), JSON.stringify({ name: '@nocobase/app', main: 'index.js' }));
      writeFileSync(
        join(appDirectory, 'index.js'),
        [
          "const fs = require('node:fs');",
          'fs.writeFileSync(process.env.GUARDIAN_BOOTSTRAP_RECEIPT, JSON.stringify({ argv: process.argv, initEnv: process.env.GUARDIAN_INIT_ENV_CALLED, generateAppDir: process.env.GUARDIAN_GENERATE_APP_DIR_CALLED }));',
        ].join('\n'),
      );

      const result = spawnSync(process.execPath, [bootstrapPath, '--port', '15432'], {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          GUARDIAN_BOOTSTRAP_RECEIPT: receiptPath,
          NODE_PATH: modulesDirectory,
        },
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
        argv: string[];
        initEnv: string;
        generateAppDir: string;
      };
      expect(receipt.argv.slice(2)).toEqual(['start', '--port', '15432']);
      expect(receipt.initEnv).toBe('true');
      expect(receipt.generateAppDir).toBe('true');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
