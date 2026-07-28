import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { SkillRepositoryService } from '../SkillRepositoryService';

describe('SkillRepositoryService registry package materialization', () => {
  let storagePath = '';

  beforeEach(() => {
    storagePath = mkdtempSync(join(tmpdir(), 'skill-repository-service-'));
  });

  afterEach(() => {
    rmSync(storagePath, { recursive: true, force: true });
  });

  it('materializes all portable artifact files and rejects traversal paths', () => {
    const repository = new SkillRepositoryService(storagePath);

    repository.writeSkillPackage('registry-acme-report', [
      { path: 'SKILL.md', content: Buffer.from('# Report\n') },
      { path: 'src/index.py', content: Buffer.from('from .format import render\n') },
      { path: 'src/format.py', content: Buffer.from('def render():\n    return "ok"\n') },
    ]);

    const packageRoot = repository.getSkillPath('registry-acme-report');
    expect(readFileSync(join(packageRoot, 'src', 'format.py'), 'utf8')).toContain('return "ok"');
    expect(() =>
      repository.writeSkillPackage('registry-acme-report', [{ path: '../escape.py', content: Buffer.alloc(0) }]),
    ).toThrow('Invalid skill package path');
  });
});
