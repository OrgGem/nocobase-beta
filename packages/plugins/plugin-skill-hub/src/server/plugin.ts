import { Plugin } from '@nocobase/server';
import { resolve } from 'path';
import { createReadStream } from 'fs';
import { SandboxRunner } from './services/SandboxRunner';
import { FileManager } from './services/FileManager';
import { SkillManager } from './services/SkillManager';
import { WorkerEnvManager } from './services/WorkerEnvManager';
import { SkillExecutionTask } from './tasks/SkillExecutionTask';
import { createSkillExecuteTool } from './tools/skill-execute';

/**
 * Simple in-memory rate limiter per user.
 * Tracks execution counts within a sliding time window.
 */
class RateLimiter {
  private userExecutions = new Map<string, number[]>();

  constructor(
    private readonly maxExecutions: number = 10,
    private readonly windowMs: number = 60 * 1000, // 1 minute
  ) {}

  /**
   * Check if the user is allowed to execute.
   * @returns true if allowed, false if rate limited.
   */
  check(userId: string): boolean {
    const now = Date.now();
    const executions = this.userExecutions.get(userId) || [];

    // Remove expired entries
    const valid = executions.filter((t) => now - t < this.windowMs);
    this.userExecutions.set(userId, valid);

    if (valid.length >= this.maxExecutions) {
      return false;
    }

    valid.push(now);
    return true;
  }

  /** Get remaining executions for a user */
  remaining(userId: string): number {
    const now = Date.now();
    const executions = (this.userExecutions.get(userId) || []).filter(
      (t) => now - t < this.windowMs,
    );
    return Math.max(0, this.maxExecutions - executions.length);
  }

  /** Periodically clean up expired entries (call from interval) */
  cleanup() {
    const now = Date.now();
    for (const [userId, executions] of this.userExecutions) {
      const valid = executions.filter((t) => now - t < this.windowMs);
      if (valid.length === 0) {
        this.userExecutions.delete(userId);
      } else {
        this.userExecutions.set(userId, valid);
      }
    }
  }
}

export class PluginSkillHubServer extends Plugin {
  sandboxRunner: SandboxRunner;
  fileManager: FileManager;
  skillManager: SkillManager;
  workerEnvManager: WorkerEnvManager;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private initEnvDoneCallback: any = null;
  private initEnvProgressCallback: any = null;
  private rateLimiter = new RateLimiter(
    parseInt(process.env.SKILL_HUB_RATE_LIMIT_MAX || '10', 10),
    parseInt(process.env.SKILL_HUB_RATE_LIMIT_WINDOW_MS || '60000', 10),
  );

  async load() {
    // 1. Import collections
    await this.db.import({
      directory: resolve(__dirname, 'collections'),
    });

    // 2. Init services
    const storagePath = resolve(process.cwd(), 'storage', this.name);
    this.fileManager = new FileManager(storagePath);
    this.sandboxRunner = new SandboxRunner(this.fileManager, this.app.logger, storagePath);
    this.skillManager = new SkillManager(this.db);
    this.workerEnvManager = new WorkerEnvManager(this.app, this.db, storagePath);

    // 3. Register REST actions
    this.app.resourceManager.define({
      name: 'skillHub',
      actions: {
        download: this.handleDownload.bind(this),
        test: this.handleTest.bind(this),
        initEnv: this.handleInitEnv.bind(this),
        clearStorage: this.handleClearStorage.bind(this),
      },
    });

    // 4. Register ACL
    this.app.acl.registerSnippet({
      name: `pm.${this.name}`,
      actions: ['skillDefinitions:*', 'skillExecutions:*', 'skillHub:*', 'skillWorkerConfigs:*'],
    });

    // 4.5. Register DB hooks for automatic storage physical cleanup
    this.db.on('skillExecutions.afterDestroy', async (model, options) => {
      const execId = model.get('id');
      try {
        const dir = this.fileManager.getExecDir(String(execId));
        if (require('fs').existsSync(dir)) {
          require('fs').rmSync(dir, { recursive: true, force: true });
        }
      } catch (err) {
        this.app.logger.error(`[skill-hub] Failed to cleanup physical storage for execId ${execId}`, { error: err });
      }
    });

    // 5. Subscribe PubSub — worker processes skill execution tasks
    this.app.pubSubManager.subscribe('skill-hub.task', async (payload: any) => {
      if (process.env.SKILL_HUB_SANDBOX === 'false') return;
      await this.onQueueTask(payload);
    });

    // 5b. Subscribe PubSub — worker processes init-env tasks
    this.app.pubSubManager.subscribe('skill-hub.init-env', async (payload: any) => {
      if (process.env.SKILL_HUB_SANDBOX === 'false') return;
      await this.workerEnvManager.executeInit(payload);
    });

    // 6. Register AI tools + subscriptions (deferred — after all plugins loaded)
    this.app.on('afterStart', async () => {
      this.registerAITools();
      this.startCleanupInterval();
      await this.subscribeInitEnvDone();
    });
  }

  private async onQueueTask(message: { id: string }) {
    const execution = await this.db.getRepository('skillExecutions').findOne({
      filter: { id: message.id },
      appends: ['skill'],
    });
    if (!execution) return;

    const task = new SkillExecutionTask(
      execution,
      this.sandboxRunner,
      this.fileManager,
      this.app,
    );
    await task.run();
  }

  /**
   * Execute skill — called by both AI tool and REST test endpoint.
   * Dispatches to worker via EventQueue, waits for result via PubSub.
   * Pushes progress to SSE via runtime.writer (if within AI tool context).
   * Includes rate limiting and graceful abort propagation.
   */
  async executeSkill(skill: any, inputArgs: Record<string, any>, ctx?: any): Promise<any> {
    // ── Rate limiting ──
    const userId = ctx?.state?.currentUser?.id;
    if (userId) {
      if (!this.rateLimiter.check(String(userId))) {
        const remaining = this.rateLimiter.remaining(String(userId));
        throw new Error(
          `Rate limit exceeded. You can execute up to ${this.rateLimiter['maxExecutions']} ` +
          `skills per minute. Remaining: ${remaining}. Please wait and try again.`,
        );
      }
    }

    const execution = await this.db.getRepository('skillExecutions').create({
      values: {
        skillId: skill.id,
        status: 'pending',
        inputArgs,
        sessionId: ctx?.state?.sessionId,
        triggeredById: ctx?.state?.currentUser?.id,
      },
    });

    const execId = String(execution.id);

    this.app.logger.info(
      `[skill-hub] Queued execution ${execId}: skill=${skill.get ? skill.get('name') : skill.name}, ` +
      `user=${userId || 'system'}`,
    );

    // Dispatch to worker via EventQueue
    await this.app.pubSubManager.publish('skill-hub.task', { id: execId });

    // Track PubSub subscriptions for cleanup
    const cleanups: Array<{ channel: string; callback: any }> = [];

    // Define callbacks with references for unsubscribe
    const progressChannel = `skill-hub.progress.${execId}`;
    const doneChannel = `skill-hub.done.${execId}`;
    const abortChannel = `skill-hub.abort.${execId}`;

    const progressCallback = async (progress: any) => {
      try {
        ctx?.runtime?.writer?.({
          action: 'skillProgress',
          body: { execId, skillName: skill.name || skill.get?.('name'), ...progress },
        });
      } catch {
        // Ignore SSE write errors (connection may have closed)
      }
    };

    // Wait for result via PubSub (progress streaming + completion)
    let result: any;
    try {
      result = await new Promise<any>(async (resolve, reject) => {
        const timeoutMs = ((skill.timeoutSeconds || skill.get?.('timeoutSeconds') || 60) + 15) * 1000;
        const timeout = setTimeout(() => {
          reject(new Error(`Skill execution timeout after ${skill.timeoutSeconds || 60}s`));
        }, timeoutMs);

        const doneCallback = async (data: any) => {
          clearTimeout(timeout);
          resolve(data);
        };

        // Subscribe progress → push to SSE via runtime.writer
        await this.app.pubSubManager.subscribe(progressChannel, progressCallback);
        cleanups.push({ channel: progressChannel, callback: progressCallback });

        // Subscribe completion
        await this.app.pubSubManager.subscribe(doneChannel, doneCallback);
        cleanups.push({ channel: doneChannel, callback: doneCallback });

        // Handle user abort (cancel chat) → propagate to worker
        if (ctx?.req?.signal || ctx?.signal) {
          const signal = ctx.req?.signal || ctx.signal;
          signal.addEventListener?.('abort', () => {
            clearTimeout(timeout);
            // Publish abort to worker via PubSub
            this.app.pubSubManager.publish(abortChannel, { reason: 'user_cancel' }).catch(() => {});
            // Also update the execution status
            this.db.getRepository('skillExecutions').update({
              filter: { id: execId },
              values: { status: 'canceled' },
            }).catch(() => {});
            reject(new Error('Canceled by user'));
          });
        }
      });
    } finally {
      // Cleanup all PubSub subscriptions
      for (const { channel, callback } of cleanups) {
        try {
          await this.app.pubSubManager.unsubscribe(channel, callback);
        } catch {
          // ignore cleanup errors
        }
      }
    }

    // Build download URLs for output files
    const filesWithUrls = (result.files || []).map((f: any) => ({
      ...f,
      downloadUrl: `/api/skillHub:download?execId=${execId}&filename=${encodeURIComponent(f.name)}`,
    }));

    return { ...result, files: filesWithUrls, execId };
  }

  private async handleDownload(ctx: any, next: any) {
    const { execId, filename } = ctx.action.params;
    if (!execId || !filename) {
      ctx.throw(400, 'Missing execId or filename');
    }

    const filePath = this.fileManager.getOutputFilePath(execId, filename);
    if (!filePath) {
      ctx.throw(404, 'File not found');
    }

    ctx.attachment(filename);
    ctx.body = createReadStream(filePath);
    await next();
  }

  private async handleTest(ctx: any, next: any) {
    const { skillId, input } = ctx.action.params.values || {};
    if (!skillId) {
      ctx.throw(400, 'Missing skillId');
    }

    const skill = await this.db.getRepository('skillDefinitions').findOne({
      filter: { id: skillId },
    });
    if (!skill) {
      ctx.throw(404, 'Skill not found');
    }

    const result = await this.executeSkill(skill, input || {}, ctx);
    ctx.body = result;
    await next();
  }

  /**
   * Handle Init Environment request from admin UI.
   * Dispatches init task to all workers via EventQueue.
   */
  private async handleInitEnv(ctx: any, next: any) {
    const config = await this.workerEnvManager.getOrCreateConfig();
    const message = await this.workerEnvManager.initEnvironment(
      config.get ? {
        npmRegistryUrl: config.get('npmRegistryUrl'),
        npmAuthToken: config.get('npmAuthToken'),
        pypiIndexUrl: config.get('pypiIndexUrl'),
        pypiTrustedHost: config.get('pypiTrustedHost'),
        aptMirrorUrl: config.get('aptMirrorUrl'),
        aptGpgKeyUrl: config.get('aptGpgKeyUrl'),
      } : config,
    );
    ctx.body = { message };
    await next();
  }

  /**
   * Subscribe to init-env done PubSub channel.
   * When a worker finishes init, auto-update the DB with status + whitelist.
   */
  private async subscribeInitEnvDone() {
    this.initEnvDoneCallback = async (data: any) => {
      try {
        const values: any = {
          initStatus: data.status,
          lastInitLog: data.log,
        };
        if (data.status === 'succeeded' && data.whitelist) {
          values.packageWhitelist = data.whitelist;
        }
        await this.db.getRepository('skillWorkerConfigs').update({
          filter: {},
          values,
          forceUpdate: true,
        });
        this.app.logger.info(`[skill-hub] Init env ${data.status}`);
      } catch (err) {
        this.app.logger.warn('[skill-hub] Failed to update init env status:', err);
      }
    };
    await this.app.pubSubManager.subscribe('skill-hub.init-env.done', this.initEnvDoneCallback);
  }

  private registerAITools() {
    try {
      const aiPlugin = this.app.pm.get('@nocobase/plugin-ai') as any;
      if (!aiPlugin?.ai?.toolsManager) {
        this.app.logger.warn('[skill-hub] plugin-ai not available, skip AI tool registration.');
        return;
      }

      // 1. General tool (list + execute)
      aiPlugin.ai.toolsManager.registerTools(createSkillExecuteTool(this));

      // Register a group for our skills
      aiPlugin.ai.toolsManager.registerToolGroup({
        groupName: 'skill_hub',
        title: 'Skill Hub',
        description: 'Auto-generated tools from Skill Hub',
      });

      // 2. Dynamic tools — each enabled skill becomes a separate AI tool.
      aiPlugin.ai.toolsManager.registerDynamicTools(async (register: { registerTools: (options: any) => void }) => {
        try {
          const skills = await this.db.getRepository('skillDefinitions').find({
            filter: { enabled: true },
          });

          if (!skills || skills.length === 0) return;

          const tools = skills.map((skill: any) => {
            const sanitizedToolName = skill.get('name').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
            return {
              scope: 'CUSTOM' as const,
              execution: 'backend' as const,
              defaultPermission: 'ASK' as const,
              introduction: {
                title: `Skill Hub: ${skill.get('title')}`,
                about: skill.get('description') || `Thực thi kỹ năng ${skill.get('title')}`,
              },
              definition: {
                name: `skill_hub.${sanitizedToolName}`,
                description: `${skill.get('description')}\nLanguage: ${skill.get('language')}`,
                schema: skill.get('inputSchema') || { type: 'object', properties: {} },
              },
              invoke: async (toolCtx: any, args: any) => {
                // Re-fetch skill to get latest version (hot-reload support)
                const latestSkill = await this.db.getRepository('skillDefinitions').findOne({
                  filter: { id: skill.get('id'), enabled: true },
                });
                if (!latestSkill) {
                  return { error: `Skill "${skill.get('name')}" is no longer available` };
                }
                const result = await this.executeSkill(latestSkill, args, toolCtx);
                return {
                  status: result.status === 'succeeded' ? 'success' : 'error',
                  result: result, // Attach raw result
                };
              },
            };
          });

          register.registerTools(tools);
        } catch (err) {
          this.app.logger.warn('[skill-hub] Failed to provide dynamic tools', err);
        }
      });

      this.app.logger.info('[skill-hub] AI tools registered (dynamic provider + general tool).');
    } catch (error) {
      this.app.logger.warn('[skill-hub] Failed to register AI tools:', error);
    }
  }

  private startCleanupInterval() {
    // Check old execution files every hour, rate limiter every 5 minutes
    const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

    this.cleanupInterval = setInterval(async () => {
      // 1. Storage Retention Cleanup
      try {
        const config = await this.db.getRepository('skillWorkerConfigs').findOne();
        const hours = config ? config.get('retentionHours') : 24;
        
        if (hours && hours > 0) {
          const MAX_AGE_MS = hours * 60 * 60 * 1000;
          const cutoff = new Date(Date.now() - MAX_AGE_MS);
          const repo = this.db.getRepository('skillExecutions');
          
          const outdated = await repo.find({
            where: { createdAt: { $lt: cutoff } }
          });
          
          if (outdated.length > 0) {
            for (const record of outdated) {
              await record.destroy(); // Fires afterDestroy hook which removes physical folder
            }
            this.app.logger.info(`[skill-hub] Auto-cleaned up ${outdated.length} expired execution records`);
          }
        }
      } catch (err) {
        this.app.logger.warn('[skill-hub] Auto Cleanup error:', err);
      }

      // 2. Cleanup rate limiter stale entries
      this.rateLimiter.cleanup();
    }, CLEANUP_INTERVAL);
  }

  async beforeStop() {
    // Unsubscribe PubSub
    if (this.initEnvDoneCallback) {
      try {
        await this.app.pubSubManager.unsubscribe('skill-hub.init-env.done', this.initEnvDoneCallback);
      } catch { /* ignore */ }
    }

    // Clear cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  // --- Handlers ---
  private async handleClearStorage(ctx: any, next: () => Promise<any>) {
    const { type } = ctx.request.body || ctx.action.params.values;
    const repo = this.db.getRepository('skillExecutions');
    let count = 0;

    if (type === 'all') {
      const results = await repo.find({ fields: ['id'] });
      for (const rec of results) {
        await rec.destroy();
      }
      count = results.length;
    } else if (type === 'expired') {
      const config = await this.db.getRepository('skillWorkerConfigs').findOne();
      const hours = config ? config.get('retentionHours') : 24;
      if (hours > 0) {
        const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
        const results = await repo.find({ where: { createdAt: { $lt: cutoff } }, fields: ['id'] });
        for (const rec of results) {
          await rec.destroy();
        }
        count = results.length;
      }
    }

    ctx.body = { count };
    await next();
  }

  async install() {
    await this.skillManager.seedDefaults();
  }
}

export default PluginSkillHubServer;
