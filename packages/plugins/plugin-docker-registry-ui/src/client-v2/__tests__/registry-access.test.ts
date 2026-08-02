import { describe, expect, it } from 'vitest';
import { dockerArchiveFilename, externalImageReference } from '../registry-access';

describe('private Registry access', () => {
  it('does not generate an external Docker reference when the public host is blank', () => {
    expect(externalImageReference('', 'demo/alpine', 'latest')).toBeUndefined();
    expect(externalImageReference(undefined, 'demo/alpine', 'latest')).toBeUndefined();
  });

  it('normalizes an explicitly configured external Registry host', () => {
    expect(externalImageReference(' https://registry.example.com/ ', 'demo/alpine', 'latest')).toBe(
      'registry.example.com/demo/alpine:latest',
    );
  });

  it('matches the Docker archive filename returned by the server', () => {
    expect(dockerArchiveFilename('team/my-app', 'release/1')).toBe('team-my-app-release-1.docker.tar');
  });
});
