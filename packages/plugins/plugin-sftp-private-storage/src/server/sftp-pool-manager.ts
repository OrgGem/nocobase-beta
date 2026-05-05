import SftpClient from 'ssh2-sftp-client';
import genericPool, { Pool } from 'generic-pool';
import { Readable } from 'stream';

export interface SftpPoolOptions {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  authMethod?: 'password' | 'privateKey';
}

class SftpPoolManager {
  private pools = new Map<string, Pool<SftpClient>>();

  private getConfigHash(config: SftpPoolOptions): string {
    return JSON.stringify({
      host: config.host,
      port: config.port || 22,
      username: config.username,
      authMethod: config.authMethod,
      password: config.password,
      privateKey: config.privateKey,
      passphrase: config.passphrase,
    });
  }

  getPool(config: SftpPoolOptions): Pool<SftpClient> {
    const hash = this.getConfigHash(config);
    if (!this.pools.has(hash)) {
      const factory = {
        create: async (): Promise<SftpClient> => {
          const client = new SftpClient();
          const connectOptions: any = {
            host: config.host,
            port: config.port || 22,
            username: config.username,
            readyTimeout: 15000,
            retries: 2,
            retry_factor: 2,
            retry_minTimeout: 2000,
          };
          if (config.authMethod === 'privateKey' && config.privateKey) {
            connectOptions.privateKey = config.privateKey;
            if (config.passphrase) connectOptions.passphrase = config.passphrase;
          } else if (config.password) {
            connectOptions.password = config.password;
          }
          await client.connect(connectOptions);
          return client;
        },
        destroy: async (client: SftpClient): Promise<void> => {
          try {
            await client.end();
          } catch (e) {}
        },
        validate: async (client: SftpClient): Promise<boolean> => {
          try {
            await client.cwd();
            return true;
          } catch (e) {
            return false;
          }
        }
      };

      const poolOpts = {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000,
        acquireTimeoutMillis: 15000,
        testOnBorrow: true,
      };

      const pool = genericPool.createPool(factory, poolOpts);
      this.pools.set(hash, pool);
    }

    return this.pools.get(hash)!;
  }

  async acquire(config: SftpPoolOptions): Promise<{ client: SftpClient; release: () => void; pool: Pool<SftpClient> }> {
    const pool = this.getPool(config);
    const client = await pool.acquire();
    const release = () => {
      try {
        pool.release(client);
      } catch (e) {}
    };
    return { client, release, pool };
  }

  async closeAll() {
    const promises: Promise<any>[] = [];
    for (const pool of this.pools.values()) {
      promises.push(pool.drain().then(() => pool.clear()));
    }
    await Promise.allSettled(promises);
    this.pools.clear();
  }
}

export const sftpPoolManager = new SftpPoolManager();
