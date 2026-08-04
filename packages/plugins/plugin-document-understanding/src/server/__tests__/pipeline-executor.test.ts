import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import axios from 'axios';
import { AsyncJobManager } from '../services/AsyncJobManager';
import { ExternalApiClient } from '../services/ExternalApiClient';
import { PipelineExecutor, resolveUploadFilePath } from '../services/PipelineExecutor';

describe('PipelineExecutor upload path resolution', () => {
  const uploadsRoot = resolve(process.cwd(), 'storage', 'uploads');
  const samplePath = resolve(uploadsRoot, 'du-test', 'sample.txt');

  beforeEach(() => {
    mkdirSync(resolve(uploadsRoot, 'du-test'), { recursive: true });
    writeFileSync(samplePath, 'sample');
  });

  afterEach(() => {
    rmSync(resolve(uploadsRoot, 'du-test'), { recursive: true, force: true });
  });

  it('resolves upload-relative paths inside the upload root', () => {
    expect(resolveUploadFilePath('uploads/du-test/sample.txt')).toBe(samplePath);
    expect(resolveUploadFilePath('/uploads/du-test/sample.txt')).toBe(samplePath);
    expect(resolveUploadFilePath('storage/uploads/du-test/sample.txt')).toBe(samplePath);
  });

  it('rejects traversal and absolute filesystem paths', () => {
    expect(resolveUploadFilePath('uploads/../package.json')).toBeNull();
    expect(resolveUploadFilePath('storage/uploads/../../package.json')).toBeNull();
    expect(resolveUploadFilePath(resolve(process.cwd(), 'package.json'))).toBeNull();
  });

  it('maps upload URLs by pathname only', () => {
    expect(resolveUploadFilePath('https://example.com/uploads/du-test/sample.txt?token=secret')).toBe(samplePath);
  });

  it('does not resolve arbitrary remote URLs as upload files', () => {
    expect(resolveUploadFilePath('https://evil.example/private.pdf')).toBeNull();
  });
});

describe('PipelineExecutor remote file handling', () => {
  it('does not fetch arbitrary remote URLs', async () => {
    const getSpy = vi.spyOn(axios, 'get');
    const executor = new PipelineExecutor(
      { getRepository: vi.fn() } as never,
      {} as ExternalApiClient,
      {} as AsyncJobManager,
      { error: vi.fn(), warn: vi.fn() },
    );

    await expect((executor as any).resolveFile('https://evil.example/private.pdf')).resolves.toBeNull();
    expect(getSpy).not.toHaveBeenCalled();
  });
});
