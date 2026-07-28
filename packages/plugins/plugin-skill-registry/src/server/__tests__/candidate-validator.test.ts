import type { RegistrySkillCandidateV1, RegistrySourceDescriptor, RegistrySourceProvider } from '../contracts/types';
import { candidateDigest } from '../services/canonical-json';
import { validateDiscoveredExternalKeys, validateProviderCandidate } from '../services/candidate-validator';

const source: RegistrySourceDescriptor = {
  id: 'source-1',
  providerType: 'skill-hub',
  namespace: 'acme',
  providerConfig: {},
};

const provider = { type: 'skill-hub' } as RegistrySourceProvider;

function candidate(): RegistrySkillCandidateV1 {
  const manifest: RegistrySkillCandidateV1['manifest'] = {
    schemaVersion: 'registry.skill.nocobase.io/v1',
    name: 'acme/report',
    displayName: 'Report',
    description: '',
    runtime: { kind: 'python', entrypoint: 'src/index.py' },
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    permissions: {},
    dependencies: [],
    compatibility: {},
    tags: [],
  };
  const files = [{ path: 'src/index.py', content: Buffer.from('print("ok")') }];
  return {
    contractVersion: 'registry-candidate/v1',
    source: {
      provider: 'skill-hub',
      sourceId: source.id,
      externalKey: 'skillDefinitions:1',
      revision: 'revision-1',
    },
    identity: { namespace: 'acme', slug: 'report' },
    manifest,
    files,
    candidateDigest: candidateDigest(manifest, files),
  };
}

describe('provider candidate validation', () => {
  it('accepts a candidate only when its source binding and recomputed digest match', () => {
    const value = candidate();

    expect(
      validateProviderCandidate({ provider, source, externalKey: 'skillDefinitions:1', candidate: value }),
    ).toMatchObject({ candidateDigest: value.candidateDigest, source: value.source });
  });

  it('rejects bytes changed behind an unchanged provider digest', () => {
    const value = candidate();
    value.files[0].content = Buffer.from('print("changed")');

    expect(() =>
      validateProviderCandidate({ provider, source, externalKey: 'skillDefinitions:1', candidate: value }),
    ).toThrow(expect.objectContaining({ code: 'CANDIDATE_DIGEST_MISMATCH' }));
  });

  it('rejects a candidate returned for a different source item', () => {
    const value = candidate();
    value.source.externalKey = 'skillDefinitions:2';

    expect(() =>
      validateProviderCandidate({ provider, source, externalKey: 'skillDefinitions:1', candidate: value }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SOURCE_CANDIDATE' }));
  });

  it('rejects duplicate or excessive discovery results before sync work begins', () => {
    expect(() => validateDiscoveredExternalKeys(['skillDefinitions:1', 'skillDefinitions:1'])).toThrow(
      expect.objectContaining({ code: 'INVALID_SOURCE_CANDIDATE' }),
    );
    expect(() =>
      validateDiscoveredExternalKeys(Array.from({ length: 1001 }, (_, index) => `skillDefinitions:${index}`)),
    ).toThrow(expect.objectContaining({ code: 'SOURCE_ITEM_LIMIT_EXCEEDED' }));
  });
});
