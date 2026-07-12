export class SecretCache {
  private values = new Map<string, string>();
  private envKeys = new Set<string>();

  get(key: string): string | undefined {
    return this.values.get(key);
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
  }

  has(key: string): boolean {
    return this.values.has(key);
  }

  invalidate(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }

  getAll(): Record<string, string> {
    return Object.fromEntries(this.values.entries());
  }

  markEnvKey(key: string): void {
    this.envKeys.add(key);
  }

  unmarkEnvKey(key: string): void {
    this.envKeys.delete(key);
  }

  isEnvKey(key: string): boolean {
    return this.envKeys.has(key);
  }

  getEnvKeys(): string[] {
    return [...this.envKeys];
  }

  clearEnvKeys(): void {
    this.envKeys.clear();
  }
}
