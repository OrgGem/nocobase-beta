import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { resolveUploadFilePath } from '../services/PipelineExecutor';

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
});
