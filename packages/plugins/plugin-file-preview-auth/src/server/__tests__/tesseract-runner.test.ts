/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TesseractRunner } from '../ocr/tesseract-runner';

vi.mock('child_process', () => ({ spawn: vi.fn() }));
let directory: string;
let input: string;
const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
const page = '1\t1\t0\t0\t0\t0\t0\t0\t100\t100\t-1\t';
const word = '5\t1\t1\t1\t1\t1\t10\t20\t30\t10\t95\tActual text';

beforeEach(async () => {
  vi.mocked(spawn).mockReset();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-test-'));
  input = path.join(directory, 'invoice & literal.png');
  await fs.writeFile(input, 'image fixture');
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

function mockCommand(run: (command: string, args: string[], child: EventEmitter) => Promise<void>) {
  vi.mocked(spawn).mockImplementation((command, args) => {
    const child = Object.assign(new EventEmitter(), { stderr: new PassThrough() });
    run(command, args as string[], child).catch((error: unknown) => child.emit('error', error));
    return child as unknown as ReturnType<typeof spawn>;
  });
}

it('fails when the OCR executable is missing instead of generating words', async () => {
  mockCommand(async (_command, _args, child) => {
    await Promise.resolve();
    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
  });
  await expect(new TesseractRunner().runOcr(input, 1)).rejects.toThrow('ENOENT');
});

it.each(['nonzero', 'missing', 'malformed'])('propagates %s OCR output failure', async (mode) => {
  mockCommand(async (_command, args, child) => {
    await Promise.resolve();
    if (mode === 'malformed') await fs.writeFile(`${args[1]}.tsv`, 'invalid TSV');
    child.emit('close', mode === 'nonzero' ? 1 : 0);
  });
  await expect(new TesseractRunner().runOcr(input, 1)).rejects.toThrow();
});

it.each(['failure', 'empty'])('rejects PDF conversion %s without passing the PDF to Tesseract', async (mode) => {
  input = path.join(directory, 'invoice.pdf');
  await fs.writeFile(input, 'pdf fixture');
  mockCommand(async (_command, _args, child) => {
    await Promise.resolve();
    child.emit('close', mode === 'failure' ? 1 : 0);
  });
  await expect(new TesseractRunner().runOcr(input, 1)).rejects.toThrow();
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(vi.mocked(spawn).mock.calls[0][0]).toBe('pdftoppm');
});

it.each([true, false])(
  'returns only actual TSV words (blank page = %s), with safe process arguments and cleanup',
  async (blank) => {
    let outputDirectory: string;
    mockCommand(async (_command, args, child) => {
      outputDirectory = path.dirname(args[1]);
      await fs.writeFile(`${args[1]}.tsv`, `${header}\n${page}\n${blank ? '' : `${word}\n`}`);
      child.emit('close', 0);
    });
    const result = await new TesseractRunner().runOcr(input, 1);
    expect(result.pages[0].items).toHaveLength(blank ? 0 : 1);
    if (!blank)
      expect(result.pages[0].items[0]).toMatchObject({
        value: 'Actual text',
        confidence: 0.95,
        rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      });
    expect(spawn).toHaveBeenCalledWith('tesseract', [input, expect.any(String), '-l', 'eng+vie', 'tsv'], {
      shell: false,
      windowsHide: true,
    });
    await expect(fs.stat(outputDirectory)).rejects.toThrow();
  },
);
