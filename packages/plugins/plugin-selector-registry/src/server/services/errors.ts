export type SelectorRegistryErrorCode =
  | 'REGISTRY_DISABLED'
  | 'APP_NOT_FOUND'
  | 'APP_INACTIVE'
  | 'ELEMENT_KEY_REQUIRED'
  | 'INVALID_SELECTOR_TYPE'
  | 'INVALID_FAILURE_TYPE'
  | 'INVALID_OUTCOME'
  | 'MISSING_APP'
  | 'MISSING_ITEMS'
  | 'NOT_FOUND';

export class SelectorRegistryError extends Error {
  constructor(
    public readonly code: SelectorRegistryErrorCode,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SelectorRegistryError';
  }
}
