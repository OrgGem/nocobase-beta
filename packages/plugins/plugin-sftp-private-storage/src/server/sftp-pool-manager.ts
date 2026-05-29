import type SftpClient from 'ssh2-sftp-client';
import type { Pool } from 'generic-pool';
import crypto from 'crypto';

export interface SftpPoolOptions {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  authMethod?: 'password' | 'privateKey';
  readyTimeout?: number;
  retries?: number;
  retryFactor?: number;
  retryMinTimeout?: number;
  poolMax?: number;
  poolMin?: number;
  idleTimeoutMillis?: number;
  acquireTimeoutMillis?: number;
}

class SftpPoolManager {
  private pools = new Map<string, Pool<SftpClient>>();

  private getConfigHash(config: SftpPoolOptions): string {
    const secretFingerprint = crypto
      .createHash('sha256')
      .update([config.password || '', config.privateKey || '', config.passphrase || ''].join('\n'))
      .digest('hex');

    return JSON.stringify({
      host: config.host,
      port: config.port || 22,
      username: config.username,
      authMethod: config.authMethod,
      secretFingerprint,
    });
  }

  getPool(config: SftpPoolOptions): Pool<SftpClient> {
    const hash = this.getConfigHash(config);
    if (!this.pools.has(hash)) {
      const factory = {
        create: async (): Promise<SftpClient> => {
          let SftpClientClass;
          try {
            SftpClientClass = require('ssh2-sftp-client');
          } catch (e) {
            throw new Error('ssh2-sftp-client module is not installed. Please run `npm install ssh2-sftp-client` first.');
          }
          const SftpClientCtor = SftpClientClass.default || SftpClientClass;
          const client = new SftpClientCtor();
          const connectOptions: any = {
            host: config.host,
            port: config.port || 22,
            username: config.username,
            readyTimeout: Number(config.readyTimeout || process.env.SFTP_POOL_READY_TIMEOUT || 15000),
            retries: Number(config.retries ?? process.env.SFTP_POOL_RETRIES ?? 2),
            retry_factor: Number(config.retryFactor || process.env.SFTP_POOL_RETRY_FACTOR || 2),
            retry_minTimeout: Number(config.retryMinTimeout || process.env.SFTP_POOL_RETRY_MIN_TIMEOUT || 2000),
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
        max: Number(config.poolMax || process.env.SFTP_POOL_MAX || 10),
        min: Number(config.poolMin ?? process.env.SFTP_POOL_MIN ?? 0),
        idleTimeoutMillis: Number(config.idleTimeoutMillis || process.env.SFTP_POOL_IDLE_TIMEOUT || 30000),
        acquireTimeoutMillis: Number(config.acquireTimeoutMillis || process.env.SFTP_POOL_ACQUIRE_TIMEOUT || 15000),
        testOnBorrow: true,
      };

      let genericPoolClass;
      try {
        genericPoolClass = require('generic-pool');
      } catch (e) {
        throw new Error('generic-pool module is not installed. Please run `npm install generic-pool` first.');
      }
      const genericPoolLib = genericPoolClass.default || genericPoolClass;
      const pool = genericPoolLib.createPool(factory, poolOpts);
      this.pools.set(hash, pool);
    }

    return this.pools.get(hash)!;
  }

  async acquire(config: SftpPoolOptions): Promise<{ client: SftpClient; release: () => void; destroy: () => Promise<void>; pool: Pool<SftpClient> }> {
    const pool = this.getPool(config);
    const client = await pool.acquire();
    let returned = false;
    const release = () => {
      if (returned) return;
      returned = true;
      try {
        pool.release(client);
      } catch (e) {}
    };
    const destroy = async () => {
      if (returned) return;
      returned = true;
      await pool.destroy(client).catch(() => {});
    };
    return { client, release, destroy, pool };
  }

  async closePool(config: SftpPoolOptions) {
    const hash = this.getConfigHash(config);
    const pool = this.pools.get(hash);
    if (!pool) return;
    this.pools.delete(hash);
    await pool.drain().then(() => pool.clear()).catch(() => {});
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
