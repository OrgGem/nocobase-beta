/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Application } from '@nocobase/server';
import type { AttachmentModel } from '@nocobase/plugin-file-manager';
import LocalStorage from '../../../../@nocobase/plugin-file-manager/src/server/storages/local';
import { Readable } from 'stream';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TesseractRunner } from '../ocr/tesseract-runner';
import { TesseractWorker } from '../ocr/tesseract-worker';

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-storage-test-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

function setup(getFileStream: (file: AttachmentModel) => Promise<{ stream: Readable }>) {
  const values = { id: 1, path: 'nested', filename: 'invoice.pdf', storageId: 1 };
  const attachment = { ...values, get: (key: string) => values[key] };
  const update = vi.fn();
  const ocrRecord = { get: (key: string) => (key === 'status' ? 'pending-ocr' : 10) };
  const attachmentRepo = { findOne: vi.fn(async () => attachment) };
  const ocrRepo = { findOne: vi.fn(async () => ocrRecord), update };
  const streamSpy = vi.fn(getFileStream);
  const app = {
    db: { getRepository: (name: string) => (name === 'attachments' ? attachmentRepo : ocrRepo) },
    pm: { get: () => ({ getFileStream: streamSpy }) },
    logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn() },
    i18n: { t: (key: string) => key },
  } as unknown as Application;
  const worker = new TesseractWorker(app) as unknown as { processJob(id: number): Promise<void> };
  return { worker, update, streamSpy, attachment };
}

it.each(['local', 'remote'])(
  'reads %s attachment bytes through storage and removes the temporary input',
  async (type) => {
    await fs.mkdir(path.join(directory, 'nested'));
    await fs.writeFile(path.join(directory, 'nested', 'invoice.pdf'), 'actual PDF bytes');
    const storage = new LocalStorage({
      title: 'Fixture',
      type: 'local',
      name: 'fixture',
      baseUrl: '/',
      options: { documentRoot: directory },
    });
    const { worker, update, streamSpy, attachment } = setup(
      type === 'local'
        ? (file) => storage.getFileStream(file)
        : async () => ({ stream: Readable.from(['actual PDF bytes']) }),
    );
    let processedPath: string;
    vi.spyOn(TesseractRunner.prototype, 'runOcr').mockImplementation(async (filePath) => {
      processedPath = filePath;
      expect(path.extname(filePath)).toBe('.pdf');
      expect(await fs.readFile(filePath, 'utf-8')).toBe('actual PDF bytes');
      return { pages: [{ page_number: 1, items: [] }] };
    });
    await worker.processJob(1);
    expect(streamSpy).toHaveBeenCalledWith(attachment);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        values: expect.objectContaining({
          status: 'waiting-verify',
          error: null,
          data: { pages: [{ page_number: 1, items: [] }] },
        }),
      }),
    );
    await expect(fs.stat(processedPath)).rejects.toThrow();
  },
);

it.each(['storage', 'engine'])('marks %s failures as failed with no fabricated result', async (failure) => {
  const { worker, update } = setup(async () => {
    if (failure === 'storage') throw new Error('Unsupported storage');
    return { stream: Readable.from(['actual bytes']) };
  });
  const run = vi.spyOn(TesseractRunner.prototype, 'runOcr').mockRejectedValue(new Error('tesseract ENOENT'));
  await worker.processJob(1);
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({
      values: expect.objectContaining({
        status: 'failed',
        data: null,
        error: expect.stringContaining('OCR processing failed'),
      }),
    }),
  );
  expect(update).not.toHaveBeenCalledWith(
    expect.objectContaining({ values: expect.objectContaining({ status: 'waiting-verify' }) }),
  );
  if (failure === 'storage') expect(run).not.toHaveBeenCalled();
});
