export function externalImageReference(
  publicRegistryHost: string | undefined,
  repository: string,
  reference: string,
): string | undefined {
  const host = publicRegistryHost
    ?.trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  if (!host) return undefined;
  return `${host}/${repository}:${reference}`;
}

export function dockerArchiveFilename(repository: string, reference: string): string {
  const safeRepository = repository.replace(/[^a-zA-Z0-9_.-]+/g, '-');
  const safeReference = reference.replace(/[^a-zA-Z0-9_.-]+/g, '-');
  return `${safeRepository}-${safeReference}.docker.tar`;
}
