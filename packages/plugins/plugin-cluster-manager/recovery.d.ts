export declare const STARTUP_RECOVERY_LOCK_API_VERSION: 1;

export interface StartupRecoveryLease {
  readonly ownerToken: string;
  verify(): Promise<boolean>;
  renew(): Promise<boolean>;
  release(): Promise<boolean>;
}

export interface StartupRecoveryLockClient {
  readonly apiVersion: 1;
  readonly key: string;
  tryAcquire(ownerToken?: string): Promise<StartupRecoveryLease | null>;
  listClusterManagerNodes(): Promise<Array<{ id: string; workerMode: string; appRole?: string; isSandbox: boolean }>>;
  close(): Promise<void>;
}

export interface StartupRecoveryLockOptions {
  redisUrl?: string;
  registryRedisUrl?: string;
  registryClient?: RecoveryRedisClient;
  client?: RecoveryRedisClient;
  appName: string;
  lockName: string;
  ttlMs?: number;
  onError?: (error: Error) => void;
}

export interface RecoveryRedisClient {
  readonly isOpen: boolean;
  on?(event: 'error', listener: (error: Error) => void): unknown;
  connect?(): Promise<unknown>;
  quit?(): Promise<unknown>;
  set(key: string, value: string, options: { NX: true; PX: number }): Promise<string | null>;
  sendCommand(command: string[]): Promise<unknown>;
}

export declare function createStartupRecoveryLockClient(options: StartupRecoveryLockOptions): StartupRecoveryLockClient;
