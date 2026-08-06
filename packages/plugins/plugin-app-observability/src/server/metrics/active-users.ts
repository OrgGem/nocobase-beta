import { createHash, randomBytes } from 'crypto';

export class ActiveUserWindow {
  private readonly users = new Map<string, number>();
  private readonly salt = randomBytes(16).toString('hex');
  constructor(
    private windowMs: number,
    private readonly now: () => number,
  ) {}
  observe(identifier: string | number): void {
    this.prune();
    this.users.set(createHash('sha256').update(this.salt).update(String(identifier)).digest('base64url'), this.now());
  }
  count(): number {
    this.prune();
    return this.users.size;
  }
  setWindowMs(windowMs: number): void {
    this.windowMs = windowMs;
    this.prune();
  }
  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    for (const [key, timestamp] of this.users) if (timestamp < cutoff) this.users.delete(key);
  }
}
