import { resolve } from 'path';
import { createReadStream, createWriteStream, unlinkSync } from 'fs';
import * as os from 'os';
import { SandboxRunner } from '../services/SandboxRunner';
import { FileManager } from '../services/FileManager';
import { SkillManager } from '../services/SkillManager';
import { WorkerEnvManager } from '../services/WorkerEnvManager';
import { SkillExecutionTask } from './tasks/SkillExecutionTask';
import { createSkillExecuteTool } from '../tools/skill-execute';
import { McpController } from './mcp/McpController';
import { SkillRepositoryService } from '../services/SkillRepositoryService';
import { gitListSkills, gitSyncSkills } from './actions/git-import';
import { parseJsonText, stringifyJsonText, parseJsonLike } from './utils/json-fields';

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

export class SkillHubSubFeature {
  sandboxRunner: SandboxRunner;
  fileManager: FileManager;
  skillManager: SkillManager;
  workerEnvManager: WorkerEnvManager;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private initEnvDoneCallback: any = null;
  private initEnvProgressCallback: any = null;
  private mcpController: McpController;
  private skillRepoService: SkillRepositoryService;
  private rateLimiter = new RateLimiter(
    parseInt(process.env.SKILL_HUB_RATE_LIMIT_MAX || '10', 10),
    parseInt(process.env.SKILL_HUB_RATE_LIMIT_WINDOW_MS || '60000', 10),
  );
  private skillTemplates = new Map<string, any>();

  constructor(private plugin: any) {}

  get app() { return this.plugin.app; }
  get db() { return this.plugin.db; }
  get name() { return this.plugin.name; }

  async load() {
    // 1. Collections and migrations are now handled by parent orchestrator plugin

    // 2. Init services
    const storagePath = resolve(process.cwd(), 'storage', 'plugin-skill-hub'); // Keep old storage path for backwards compatibility
    this.fileManager = new FileManager(storagePath);
    this.sandboxRunner = new SandboxRunner(this.fileManager, this.app.logger, storagePath);
    this.skillManager = new SkillManager(this.db);
    this.workerEnvManager = new WorkerEnvManager(this.app, this.db, storagePath);
    this.skillRepoService = new SkillRepositoryService(storagePath);
    this.mcpController = new McpController(this);

    // 3. Register REST actions
    this.app.resourceManager.define({
      name: 'skillHub',
      actions: {
        download: this.handleDownload.bind(this),
        test: this.handleTest.bind(this),
        initEnv: this.handleInitEnv.bind(this),
        clearStorage: this.handleClearStorage.bind(this),
        mcpListTools: this.mcpController.listTools.bind(this.mcpController),
        mcpCallTool: this.mcpController.callTool.bind(this.mcpController),
        listTemplates: this.handleListTemplates.bind(this),
        gitListSkills,
        gitSyncSkills,
      },
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

    this.db.on('skillDefinitions.afterSave', async (model, options) => {
      // If a zip file was uploaded, extract it and update the skill record
      if (model.changed('fileId') && model.get('fileId')) {
        try {
          const attachment = await this.db.getRepository('attachments').findOne({
            filter: { id: model.get('fileId') },
            transaction: options.transaction,
          });

          if (attachment) {
            const fileManager = this.app.pm.get('@nocobase/plugin-file-manager') as any;
            if (!fileManager) {
              this.app.logger.warn('[skill-hub] plugin-file-manager not found, cannot extract skill package');
              return;
            }

            const streamData = await fileManager.getFileStream(attachment);
            if (!streamData || !streamData.stream) {
              this.app.logger.warn(`[skill-hub] Could not get file stream for attachment ${attachment.get('id')}`);
              return;
            }

            const tempZipPath = resolve(os.tmpdir(), `skill_${Date.now()}_${model.get('id')}.zip`);

            await new Promise((resolvePipe, rejectPipe) => {
              const writeStream = createWriteStream(tempZipPath);
              streamData.stream.pipe(writeStream);
              writeStream.on('finish', resolvePipe);
              writeStream.on('error', rejectPipe);
              streamData.stream.on('error', rejectPipe);
            });

            if (require('fs').existsSync(tempZipPath)) {
              const skillName = model.get('name');
              const { metadata, instructions } = await this.skillRepoService.extractSkillPackage(skillName, tempZipPath);
              const code = this.skillRepoService.getSkillCode(skillName);

              const updateValues: any = { storageType: attachment.get('storageId') ? `storage-${attachment.get('storageId')}` : 'local' };
              if (code) updateValues.codeTemplate = code;
              if (metadata.description) updateValues.description = metadata.description;
              if (metadata.title) updateValues.title = metadata.title;
              if (metadata.language) updateValues.language = metadata.language;
              if (metadata.inputSchema) updateValues.inputSchema = stringifyJsonText(parseJsonLike(metadata.inputSchema, null));
              if (metadata.interactionSchema) updateValues.interactionSchema = stringifyJsonText(parseJsonLike(metadata.interactionSchema, null));
              if (metadata.packages) updateValues.packages = stringifyJsonText(parseJsonLike(metadata.packages, []), []);
              if (metadata.timeoutSeconds) updateValues.timeoutSeconds = metadata.timeoutSeconds;
              if (instructions) updateValues.instructions = instructions;

              await this.db.getRepository('skillDefinitions').update({
                filter: { id: model.get('id') },
                values: updateValues,
                transaction: options.transaction,
              });
              
              unlinkSync(tempZipPath);
              this.app.logger.info(`[skill-hub] Successfully extracted zip and updated skill: ${skillName}`);
            }
          }
        } catch (err) {
          this.app.logger.error(`[skill-hub] Failed to unpack skill zip`, { error: err });
        }
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
      // Ensure any newly added built-in skills are seeded automatically on upgrade/restart
      await this.skillManager.seedDefaults().catch((e) => {
        this.app.logger.error(`[skill-hub] Failed to seed default skills: ${e.message}`);
      });
    });
  }

  private async onQueueTask(message: { id: string }) {
    this.app.logger.info(`[skill-hub] Worker received queue task: ${message.id}`);
    const execution = await this.db.getRepository('skillExecutions').findOne({
      filter: { id: message.id },
      appends: ['skill'],
    });
    if (!execution) {
      this.app.logger.warn(`[skill-hub] Task ${message.id} ignored: execution record not found.`);
      return;
    }

    const task = new SkillExecutionTask(
      execution,
      this.sandboxRunner,
      this.fileManager,
      this.skillRepoService,
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
        inputArgs: stringifyJsonText(inputArgs, {}),
        sessionId: ctx?.state?.sessionId,
        triggeredById: ctx?.state?.currentUser?.id,
      },
    });

    const execId = String(execution.id);

    this.app.logger.info(
      `[skill-hub] Queued execution ${execId}: skill=${skill.get ? skill.get('name') : skill.name}, ` +
      `user=${userId || 'system'}`,
    );

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
      let resolvePromise: any;
      let rejectPromise: any;
      
      const resultPromise = new Promise<any>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });

      const timeoutMs = ((skill.timeoutSeconds || skill.get?.('timeoutSeconds') || 60) + 15) * 1000;
      const timeout = setTimeout(() => {
        rejectPromise(new Error(`Skill execution timeout after ${skill.timeoutSeconds || 60}s`));
      }, timeoutMs);

      const doneCallback = async (data: any) => {
        clearTimeout(timeout);
        resolvePromise(data);
      };

      // Subscribe progress and completion FIRST (before dispatching)
      await this.app.pubSubManager.subscribe(progressChannel, progressCallback);
      cleanups.push({ channel: progressChannel, callback: progressCallback });

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
          rejectPromise(new Error('Canceled by user'));
        });
      }

      // NOW Dispatch to worker via EventQueue
      await this.app.pubSubManager.publish('skill-hub.task', { id: execId });

      // Wait for completion
      result = await resultPromise;
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

    // Build download URLs for output files (use base64 filename to prevent Markdown link breaks if LLM decodes spaces)
    const filesWithUrls = (result.files || []).map((f: any) => {
      const b64name = Buffer.from(f.name).toString('base64url');
      return {
        ...f,
        downloadUrl: `/api/skillHub:download?execId=${execId}&f=${b64name}`,
      };
    });

    return { ...result, files: filesWithUrls, execId };
  }

  private async handleDownload(ctx: any, next: any) {
    const { execId, filename, f } = ctx.action.params;
    let targetFile = filename;
    if (f) {
      targetFile = Buffer.from(f, 'base64url').toString('utf8');
    }

    if (!execId || !targetFile) {
      ctx.throw(400, 'Missing execId or filename');
    }

    const currentUser = ctx?.state?.currentUser;
    if (!currentUser) {
      ctx.throw(401, 'Unauthorized');
    }

    const execution = await this.db.getRepository('skillExecutions').findOne({
      filter: { id: execId },
    });

    if (!execution) {
      ctx.throw(404, 'Execution not found');
    }

    const isOwner = execution.triggeredById === currentUser.id;
    const isAdmin = currentUser.roles?.some((r: any) => r.name === 'root' || r === 'root' || r.name === 'admin');

    if (!isOwner && !isAdmin) {
      ctx.throw(403, 'Permission denied: you cannot view files from this execution');
    }

    const filePath = this.fileManager.getOutputFilePath(execId, targetFile);
    if (!filePath) {
      ctx.throw(404, 'File not found');
    }

    ctx.attachment(targetFile);
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
    const customPackages = parseJsonText(config.get?.('customPackages') ?? config.customPackages, {
      python: [],
      node: [],
    });
    const message = await this.workerEnvManager.initEnvironment(
      config.get ? {
        npmRegistryUrl: config.get('npmRegistryUrl'),
        npmAuthToken: config.get('npmAuthToken'),
        pypiIndexUrl: config.get('pypiIndexUrl'),
        pypiTrustedHost: config.get('pypiTrustedHost'),
        aptMirrorUrl: config.get('aptMirrorUrl'),
        aptGpgKeyUrl: config.get('aptGpgKeyUrl'),
        customPackages,
      } : config,
    );
    ctx.body = { message };
    await next();
  }

  /**
   * Subscribe to init-env done AND progress PubSub channels.
   * When a worker finishes init, auto-update the DB with status.
   */
  private async subscribeInitEnvDone() {
    this.initEnvDoneCallback = async (data: any) => {
      try {
        const values: any = {
          initStatus: data.status,
          lastInitLog: data.log,
        };
        if (data.status === 'succeeded' && data.whitelist) {
          values.packageWhitelist = stringifyJsonText(data.whitelist, { python: [], node: [], apt: [] });
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
    
    this.initEnvProgressCallback = async (data: any) => {
      try {
        await this.db.getRepository('skillWorkerConfigs').update({
          filter: {},
          values: {
            initProgressPercent: data.percent,
            initProgressLog: data.log,
          },
          forceUpdate: true,
        });
      } catch (err) {
        // ignore progress update errors
      }
    };

    await this.app.pubSubManager.subscribe('skill-hub.init-env.done', this.initEnvDoneCallback);
    await this.app.pubSubManager.subscribe('skill-hub.init-env.progress', this.initEnvProgressCallback);
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

      // 2. Dynamic tools — each enabled skill becomes a separate AI tool.
      aiPlugin.ai.toolsManager.registerDynamicTools(async (register: { registerTools: (options: any) => void }) => {
        try {
          const skills = await this.db.getRepository('skillDefinitions').find({
            filter: { enabled: true },
          });

          if (!skills || skills.length === 0) return;

          const tools = await Promise.all(skills.map(async (skill: any) => {
            const sanitizedToolName = skill.get('name').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
            const autoCall = !!skill.get('autoCall');
            const interactionSchema = parseJsonText(skill.get('interactionSchema'), null);
            const fullDescription = await this.getSkillDescriptionForAI(skill);
            const baseDescription = `${fullDescription || skill.get('description')}\nLanguage: ${skill.get('language')}`;
            const description = !autoCall && interactionSchema
              ? `${baseDescription}\n\nIMPORTANT: This skill requires human confirmation. Pass best-effort args; the user will adjust them in UI before execution.`
              : baseDescription;
            return {
              scope: 'CUSTOM' as const,
              execution: 'backend' as const,
              defaultPermission: (autoCall ? 'ALLOW' : 'ASK') as 'ALLOW' | 'ASK',
              introduction: {
                title: `Skill Hub: ${skill.get('title')}`,
                about: skill.get('description') || `Thực thi kỹ năng ${skill.get('title')}`,
              },
              definition: {
                name: `skill_hub_${sanitizedToolName}`,
                description,
                schema: parseJsonText(skill.get('inputSchema'), { type: 'object', properties: {} }),
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
          }));

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
    if (this.initEnvProgressCallback) {
      try {
        await this.app.pubSubManager.unsubscribe('skill-hub.init-env.progress', this.initEnvProgressCallback);
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

  private async handleListTemplates(ctx: any, next: () => Promise<any>) {
    // Dynamic Pull: discover templates from all active plugins in the system
    try {
      const allPlugins = this.app.pm.getPlugins();
      for (const [, pluginInstance] of allPlugins) {
        if (typeof (pluginInstance as any).getSkillTemplates === 'function') {
          const pluginSkills = (pluginInstance as any).getSkillTemplates();
          if (Array.isArray(pluginSkills)) {
            for (const s of pluginSkills) {
              if (!this.skillTemplates.has(s.name)) {
                this.skillTemplates.set(s.name, this.hydrateSkillTemplate(pluginInstance.name, s));
              }
            }
          }
        }
      }
    } catch (e) {
      this.app.logger.warn(`[skill-hub] Failed to discover some plugin skills: ${e.message}`);
    }

    ctx.body = { data: Array.from(this.skillTemplates.values()) };
    await next();
  }

  // ─── Extension API: other plugins register/unregister skills ───



  /**
   * Register a skill template into memory for UI importing.
   */
  registerSkillTemplate(pluginName: string, skillDef: any) {
    this.skillTemplates.set(skillDef.name, this.hydrateSkillTemplate(pluginName, skillDef));
    this.app.logger.info(`[skill-hub] Registered skill template "${skillDef.name}" from plugin "${pluginName}"`);
  }

  resolveSkillTemplate(templateName: string) {
    if (!templateName) return null;
    const cached = this.skillTemplates.get(templateName);
    if (cached) return cached;

    try {
      const allPlugins = this.app.pm.getPlugins();
      for (const [, pluginInstance] of allPlugins) {
        if (typeof (pluginInstance as any).getSkillTemplates !== 'function') continue;
        const pluginSkills = (pluginInstance as any).getSkillTemplates();
        if (!Array.isArray(pluginSkills)) continue;
        const found = pluginSkills.find((s: any) => s?.name === templateName);
        if (found) {
          const hydrated = this.hydrateSkillTemplate(pluginInstance.name, found);
          this.skillTemplates.set(templateName, hydrated);
          return hydrated;
        }
      }
    } catch (e: any) {
      this.app.logger.warn(`[skill-hub] Failed to resolve plugin skill "${templateName}": ${e.message}`);
    }

    return null;
  }

  async getSkillDescriptionForAI(skill: any) {
    const description = skill.get ? skill.get('description') : skill.description;
    const instructions = await this.getSkillInstructions(skill);
    const maxInlineInstructionChars = 24000;
    const inlineInstructions = instructions && instructions.length > maxInlineInstructionChars
      ? `${instructions.slice(0, maxInlineInstructionChars)}\n\n[Instructions truncated in tool description. Call skill_hub_execute with action="describe" and this skillName to load the complete workflow.]`
      : instructions;
    return [description, inlineInstructions ? `Instructions:\n${inlineInstructions}` : ''].filter(Boolean).join('\n\n');
  }

  async getSkillInstructions(skill: any) {
    const storedInstructions = skill.get ? skill.get('instructions') : skill.instructions;
    if (storedInstructions) return storedInstructions;

    const storageType = skill.get ? skill.get('storageType') : skill.storageType;
    if (storageType !== 'plugin') return '';

    const templateName = (skill.get ? skill.get('pluginSource') : skill.pluginSource) ||
      (skill.get ? skill.get('name') : skill.name);
    const template = this.resolveSkillTemplate(templateName);
    return template?.instructions || '';
  }

  private hydrateSkillTemplate(pluginName: string, skillDef: any) {
    const skillName = skillDef.name;
    const packageRoot = skillDef.skillPackage?.rootDir;
    let packageInfo: any = null;

    if (packageRoot && this.skillRepoService) {
      packageInfo = this.skillRepoService.readSkillPackage(packageRoot);
    }

    const metadata = packageInfo?.metadata || {};
    const packageInstructions = packageInfo?.instructions;

    return {
      ...skillDef,
      title: skillDef.title || metadata.title || skillName,
      description: skillDef.description || metadata.description || '',
      instructions: [skillDef.instructions, packageInstructions].filter(Boolean).join('\n\n').trim(),
      language: skillDef.language || metadata.language || 'python',
      codeTemplate: skillDef.codeTemplate || packageInfo?.code || '',
      storageType: 'plugin',
      storageUrl: skillDef.storageUrl || `plugin://${pluginName}/${skillName}`,
      // Keep pluginSource as the skill template name because existing DB records use it for lookup.
      pluginSource: skillName,
      pluginName,
    };
  }



  async install() {
    await this.skillManager.seedDefaults();
  }
}

export default SkillHubSubFeature;
