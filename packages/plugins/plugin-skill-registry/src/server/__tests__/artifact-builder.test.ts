import AdmZip from 'adm-zip';

import type { RegistrySkillCandidateV1 } from '../contracts/types';
import { buildArtifact, parseArtifactLimit, unpackArtifact } from '../services/artifact-builder';
import { canonicalJson } from '../services/canonical-json';
import { RegistryError } from '../contracts/errors';

function candidate(files: Array<{ path: string; content: Buffer }>): RegistrySkillCandidateV1 {
  return {
    contractVersion: 'registry-candidate/v1',
    source: {
      provider: 'skill-hub',
      sourceId: '1',
      externalKey: 'skillDefinitions:1',
      revision: 'sha256:source',
    },
    identity: { namespace: 'acme', slug: 'report' },
    manifest: {
      schemaVersion: 'registry.skill.nocobase.io/v1',
      name: 'acme/report',
      version: '1.0.0',
      displayName: 'Report',
      description: 'Builds a report',
      runtime: { kind: 'python', entrypoint: 'src/index.py' },
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object' },
      permissions: { network: 'deny' },
      dependencies: [],
      compatibility: { nocobase: '>=2.0.0' },
      tags: ['report'],
    },
    files,
    candidateDigest: 'sha256:candidate',
  };
}

describe('skill registry artifact builder', () => {
  it('falls back safely when an artifact limit environment value is invalid', () => {
    expect(parseArtifactLimit(undefined, 10)).toBe(10);
    expect(parseArtifactLimit('0', 10)).toBe(10);
    expect(parseArtifactLimit('10items', 10)).toBe(10);
    expect(parseArtifactLimit('9007199254740992', 10)).toBe(10);
    expect(parseArtifactLimit('25', 10)).toBe(25);
  });

  it('creates deterministic, verifiable artifacts', () => {
    const input = candidate([
      { path: 'src/index.py', content: Buffer.from('print("report")\n') },
      { path: 'SKILL.md', content: Buffer.from('# Report\n') },
    ]);

    const first = buildArtifact(input);
    const second = buildArtifact(input);

    expect(first.digest).toBe(second.digest);
    expect(first.content.equals(second.content)).toBe(true);
    expect(first.expandedSizeBytes).toBe(
      Buffer.byteLength(canonicalJson(input.manifest), 'utf8') +
        input.files.reduce((total, file) => total + file.content.length, 0),
    );

    const unpacked = unpackArtifact(first.content);
    expect(unpacked.manifest.name).toBe('acme/report');
    expect(unpacked.files.get('src/index.py')?.toString('utf8')).toContain('report');
  });

  it('rejects unsafe paths before creating a ZIP', () => {
    const input = candidate([{ path: '../escape.py', content: Buffer.from('print(1)') }]);

    let error: unknown;
    try {
      buildArtifact(input);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RegistryError);
    expect((error as RegistryError).code).toBe('ARTIFACT_UNSAFE_PATH');
  });

  it.each(['/absolute.py', 'C:\\absolute.py', '\\\\server\\share\\absolute.py'])(
    'rejects absolute or drive-qualified candidate path %s',
    (path) => {
      expect(() => buildArtifact(candidate([{ path, content: Buffer.from('print(1)') }]))).toThrowError(
        expect.objectContaining({ code: 'ARTIFACT_UNSAFE_PATH' }),
      );
    },
  );

  it.each(['manifest.json', 'MANIFEST.JSON'])('reserves generated manifest path against candidate path %s', (path) => {
    const input = candidate([
      { path: 'src/index.py', content: Buffer.from('print("safe")') },
      { path, content: Buffer.from('{"runtime":{"kind":"node","entrypoint":"evil.js"}}') },
    ]);

    expect(() => buildArtifact(input)).toThrowError(expect.objectContaining({ code: 'ARTIFACT_UNSAFE_PATH' }));
  });

  it('rejects case-insensitive and Unicode-normalized file path collisions', () => {
    const input = candidate([
      { path: 'src/index.py', content: Buffer.from('print("safe")') },
      { path: 'SRC/INDEX.PY', content: Buffer.from('print("collision")') },
      { path: 'café.txt', content: Buffer.from('first') },
      { path: 'cafe\u0301.txt', content: Buffer.from('second') },
    ]);

    expect(() => buildArtifact(input)).toThrowError(expect.objectContaining({ code: 'ARTIFACT_UNSAFE_PATH' }));
  });

  it('rejects a candidate count that leaves no quota for the generated manifest', () => {
    const files = Array.from({ length: 2000 }, (_, index) => ({
      path: index === 0 ? 'src/index.py' : `files/${index}.txt`,
      content: Buffer.alloc(0),
    }));

    expect(() => buildArtifact(candidate(files))).toThrowError(expect.objectContaining({ code: 'ARTIFACT_TOO_LARGE' }));
  });

  it('rejects case variants of manifest.json when unpacking an external ZIP', () => {
    const built = buildArtifact(candidate([{ path: 'src/index.py', content: Buffer.from('print("safe")') }]));
    const archive = new AdmZip(built.content);
    archive.addFile('MANIFEST.JSON', Buffer.from('{}'));

    expect(() => unpackArtifact(archive.toBuffer())).toThrowError(
      expect.objectContaining({ code: 'ARTIFACT_UNSAFE_PATH' }),
    );
  });

  it('requires the declared entrypoint to be included', () => {
    const input = candidate([{ path: 'SKILL.md', content: Buffer.from('# Report') }]);

    expect(() => buildArtifact(input)).toThrow('Entrypoint src/index.py is not included');
  });
});
