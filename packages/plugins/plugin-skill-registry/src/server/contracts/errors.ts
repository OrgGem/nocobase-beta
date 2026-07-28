export class RegistryError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message?: string,
  ) {
    super(message || code);
    this.name = 'RegistryError';
  }
}

export function toRegistryError(error: unknown): RegistryError {
  if (error instanceof RegistryError) {
    return error;
  }
  // Do not reflect provider/database/fs exception text through a public action. Those
  // messages routinely contain SQL, local paths, repository IDs, or credentials.
  return new RegistryError('INTERNAL_ERROR', 500, 'An internal Skill Registry error occurred.');
}
