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
import { getOrchestratorTraceContext } from '../services/ExecutionSpanService';
import { tryGetAIToolsManager } from '../utils/ai-manager';
import type { ToolsRuntime } from '@nocobase/ai';

type ToolRuntimeInput = string | ToolsRuntime | undefined;
const SKILL_TASK_POLL_INTERVAL_MS = Number.parseInt(process.env.SKILL_HUB_TASK_POLL_INTERVAL_MS || '5000', 10);
const SKILL_TASK_POLL_LIMIT = Number.parseInt(process.env.SKILL_HUB_TASK_POLL_LIMIT || '3', 10);

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeToolRuntime(runtime: ToolRuntimeInput): ToolsRuntime | undefined {
  if (!runtime) return undefined;
  if (typeof runtime === 'string') {
    return { toolCallId: runtime, writer: () => {} };
  }
  return runtime;
}

function assignToolRuntime(ctx: any, runtime: ToolRuntimeInput) {
  const normalizedRuntime = normalizeToolRuntime(runtime);
  if (!ctx || !normalizedRuntime) return () => {};
  const previousRuntime = ctx.runtime;
  ctx.runtime = normalizedRuntime;
  return () => {
    if (previousRuntime === undefined) {
      delete ctx.runtime;
    } else {
      ctx.runtime = previousRuntime;
    }
  };
}

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
    const executions = (this.userExecutions.get(userId) || []).filter((t) => now - t < this.windowMs);
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
  private skillTaskCallback: any = null;
  private initEnvTaskCallback: any = null;
  private skillTaskPoller: ReturnType<typeof setInterval> | null = null;
  private skillTaskPolling = false;
  private mcpController: McpController;
  private skillRepoService: SkillRepositoryService;
  private rateLimiter = new RateLimiter(
    parseInt(process.env.SKILL_HUB_RATE_LIMIT_MAX || '10', 10),
    parseInt(process.env.SKILL_HUB_RATE_LIMIT_WINDOW_MS || '60000', 10),
  );
  private skillTemplates = new Map<string, any>();
  private readonly afterStart = async () => {
    this.registerAITools();
    this.startCleanupInterval();
    this.startSkillTaskPoller();
    await this.subscribeInitEnvDone();
    await this.skillManager.seedDefaults().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      (this as any).app.logger.error(`[skill-hub] Failed to seed default skills: ${message}`);
    });
  };

  constructor(private plugin: any) {}

  get app() {
    return this.plugin.app;
  }
  get db() {
    return this.plugin.db;
  }
  get name() {
    return this.plugin.name;
  }

  async load() {
    // 1. Collections and migrations are now handled by parent orchestrator plugin

    // 2. Init services
    const storagePath = resolve(process.cwd(), 'storage', 'plugin-skill-hub'); // Keep old storage path for backwards compatibility
    this.fileManager = new FileManager(storagePath);
    this.sandboxRunner = new SandboxRunner(this.fileManager, (this as any).app.logger, storagePath);
    this.skillManager = new SkillManager((this as any).db);
    this.workerEnvManager = new WorkerEnvManager((this as any).app, (this as any).db, storagePath);
    this.skillRepoService = new SkillRepositoryService(storagePath);
    this.mcpController = new McpController(this);

    // 3. Register REST actions
    (this as any).app.resourceManager.define({
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
    (this as any).db.on('skillExecutions.afterDestroy', async (model, options) => {
      const execId = model.get('id');
      try {
        const dir = this.fileManager.getExecDir(String(execId));
        if (require('fs').existsSync(dir)) {
          require('fs').rmSync(dir, { recursive: true, force: true });
        }
      } catch (err) {
        (this as any).app.logger.error(`[skill-hub] Failed to cleanup physical storage for execId ${execId}`, {
          error: err,
        });
      }
    });

    (this as any).db.on('skillDefinitions.afterSave', async (model, options) => {
      // If a zip file was uploaded, extract it and update the skill record
      if (model.changed('fileId') && model.get('fileId')) {
        try {
          const attachment = await (this as any).db.getRepository('attachments').findOne({
            filter: { id: model.get('fileId') },
            transaction: options.transaction,
          });

          if (attachment) {
            const fileManager = (this as any).app.pm.get('@nocobase/plugin-file-manager') as any;
            if (!fileManager) {
              (this as any).app.logger.warn('[skill-hub] plugin-file-manager not found, cannot extract skill package');
              return;
            }

            const rawStorageId = attachment.get('storageId') || attachment.storageId;
            let matchedKey = null;
            if (rawStorageId) {
              const strId = String(rawStorageId);
              for (const key of fileManager.storagesCache.keys()) {
                if (String(key) === strId) {
                  matchedKey = key;
                  break;
                }
              }
            }

            const attachmentObj = typeof attachment.toJSON === 'function' ? attachment.toJSON() : { ...attachment };
            if (matchedKey !== null) {
              attachmentObj.storageId = matchedKey;
            }

            const streamData = await fileManager.getFileStream(attachmentObj);
            if (!streamData || !streamData.stream) {
              (this as any).app.logger.warn(
                `[skill-hub] Could not get file stream for attachment ${attachment.get('id')}`,
              );
              return;
            }

            const tempZipPath = resolve(os.tmpdir(), `skill_${Date.now()}_${model.get('id')}.zip`);

            await new Promise((resolve, reject) => {
              const writeStream = createWriteStream(tempZipPath);
              streamData.stream.pipe(writeStream);
              writeStream.on('finish', resolve);
              writeStream.on('error', reject);
              streamData.stream.on('error', reject);
            });

            if (require('fs').existsSync(tempZipPath)) {
              const skillName = model.get('name');
              const { metadata, instructions } = await this.skillRepoService.extractSkillPackage(
                skillName,
                tempZipPath,
              );
              const code = this.skillRepoService.getSkillCode(skillName);

              const updateValues: any = {
                storageType: attachment.get('storageId') ? `storage-${attachment.get('storageId')}` : 'local',
              };
              if (code) updateValues.codeTemplate = code;
              if (metadata.description) updateValues.description = metadata.description;
              if (metadata.title) updateValues.title = metadata.title;
              if (metadata.language) updateValues.language = metadata.language;
              if (metadata.inputSchema)
                updateValues.inputSchema = stringifyJsonText(parseJsonLike(metadata.inputSchema, null));
              if (metadata.interactionSchema)
                updateValues.interactionSchema = stringifyJsonText(parseJsonLike(metadata.interactionSchema, null));
              if (metadata.packages)
                updateValues.packages = stringifyJsonText(parseJsonLike(metadata.packages, []), []);
              if (metadata.timeoutSeconds) updateValues.timeoutSeconds = metadata.timeoutSeconds;
              if (instructions) updateValues.instructions = instructions;

              await (this as any).db.getRepository('skillDefinitions').update({
                filter: { id: model.get('id') },
                values: updateValues,
                transaction: options.transaction,
              });

              unlinkSync(tempZipPath);
              (this as any).app.logger.info(`[skill-hub] Successfully extracted zip and updated skill: ${skillName}`);
            }
          }
        } catch (err) {
          (this as any).app.logger.error(`[skill-hub] Failed to unpack skill zip`, { error: err });
        }
      }
    });

    // 5. Subscribe PubSub — worker processes skill execution tasks
    if (shouldRunSkillSandbox()) {
      this.skillTaskCallback = async (payload: any) => {
        await this.onQueueTask(payload);
      };
      (this as any).app.pubSubManager.subscribe('skill-hub.task', this.skillTaskCallback);
    }

    // 5b. Subscribe PubSub — worker processes init-env tasks
    if (shouldRunSkillSandbox()) {
      this.initEnvTaskCallback = async (payload: any) => {
        await this.workerEnvManager.executeInit(payload);
      };
      (this as any).app.pubSubManager.subscribe('skill-hub.init-env', this.initEnvTaskCallback);
    }

    // 6. Register AI tools + subscriptions (deferred — after all plugins loaded)
    (this as any).app.on('afterStart', this.afterStart);
  }

  private async onQueueTask(message: { id: string }) {
    (this as any).app.logger.info(`[skill-hub] Worker received queue task: ${message.id}`);
    if (process.env.SKILL_HUB_SANDBOX === 'false') {
      return;
    }
    const claimed = await this.claimSkillExecution(message.id);
    if (!claimed) {
      (this as any).app.logger.debug(`[skill-hub] Task ${message.id} ignored: already claimed or not pending.`);
      return;
    }

    const execution = await (this as any).db.getRepository('skillExecutions').findOne({
      filter: { id: message.id },
      appends: ['skill'],
    });
    if (!execution) {
      (this as any).app.logger.warn(`[skill-hub] Task ${message.id} ignored: execution record not found.`);
      return;
    }

    const task = new SkillExecutionTask(
      execution,
      this.sandboxRunner,
      this.fileManager,
      this.skillRepoService,
      (this as any).app,
    );
    await task.run();
  }

  private async claimSkillExecution(id: string): Promise<boolean> {
    const model = (this as any).db.getModel('skillExecutions');
    const now = new Date();
    const [affected] = await model.update(
      {
        status: 'running',
        startedAt: now,
        heartbeatAt: now,
        workerId: `${process.env.HOSTNAME || process.env.COMPUTERNAME || 'worker'}:${process.pid}`,
      },
      {
        where: {
          id,
          status: 'pending',
        },
      },
    );
    return affected > 0;
  }

  private startSkillTaskPoller() {
    if (!shouldRunSkillSandbox() || this.skillTaskPoller) {
      return;
    }

    const tick = () => {
      this.processSkillExecutionQueue().catch((error) => {
        (this as any).app.logger.warn(`[skill-hub] Pending task poll failed: ${error?.message || error}`);
      });
    };

    this.skillTaskPoller = setInterval(tick, SKILL_TASK_POLL_INTERVAL_MS);
    (this.skillTaskPoller as any).unref?.();
    setTimeout(tick, 1000);
  }

  private async processSkillExecutionQueue() {
    await this.recoverStaleSkillExecutions();
    await this.processPendingSkillExecutions();
  }

  private async recoverStaleSkillExecutions() {
    const staleAfterMs = positiveInteger(process.env.SKILL_HUB_STALE_EXECUTION_MS, 120000);
    const maxRetries = positiveInteger(process.env.SKILL_HUB_MAX_EXECUTION_RETRIES, 2);
    const cutoff = new Date(Date.now() - staleAfterMs);
    const repo = (this as any).db.getRepository('skillExecutions');
    const model = (this as any).db.getModel('skillExecutions');
    const staleExecutions = await repo.find({
      filter: {
        status: 'running',
        $or: [{ heartbeatAt: null }, { heartbeatAt: { $lt: cutoff } }],
      },
      limit: SKILL_TASK_POLL_LIMIT,
    });

    for (const execution of staleExecutions) {
      const id = execution.get('id');
      const retryCount = Number(execution.get('retryCount') || 0);
      const failed = retryCount >= maxRetries;
      const Op = model.sequelize.Sequelize.Op;
      const [affected] = await model.update(
        {
          status: failed ? 'failed' : 'pending',
          retryCount: retryCount + 1,
          workerId: null,
          heartbeatAt: null,
          stderr: failed ? `Execution abandoned after ${retryCount + 1} worker attempts.` : execution.get('stderr'),
        },
        {
          where: {
            id,
            status: 'running',
            [Op.or]: [{ heartbeatAt: null }, { heartbeatAt: { [Op.lt]: cutoff } }],
          },
        },
      );
      if (affected > 0) {
        (this as any).app.logger.warn(
          `[skill-hub] Recovered stale execution ${id}: ${failed ? 'failed' : 'returned to pending'}.`,
        );
      }
    }
  }

  private async processPendingSkillExecutions() {
    if (this.skillTaskPolling) return;
    this.skillTaskPolling = true;
    try {
      const records = await (this as any).db.getRepository('skillExecutions').find({
        filter: { status: 'pending' },
        sort: ['createdAt'],
        limit: SKILL_TASK_POLL_LIMIT,
      });
      for (const record of records) {
        await this.onQueueTask({ id: String(record.get('id')) });
      }
    } finally {
      this.skillTaskPolling = false;
    }
  }

  /**
   * Execute skill — called by both AI tool and REST test endpoint.
   * Dispatches to sandbox workers via PubSub, waits for result via PubSub.
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

    const traceContext = getOrchestratorTraceContext(ctx);
    const execution = await (this as any).db.getRepository('skillExecutions').create({
      values: {
        skillId: skill.id,
        status: 'pending',
        inputArgs: stringifyJsonText(inputArgs, {}),
        sessionId: ctx?.state?.sessionId,
        orchestratorRootRunId: traceContext?.rootRunId,
        orchestratorSpanId: traceContext?.spanId,
        orchestratorParentSpanId: traceContext?.parentSpanId,
        orchestratorToolCallId: traceContext?.toolCallId,
        agentLoopRunId: traceContext?.agentLoopRunId,
        agentLoopStepId: traceContext?.agentLoopStepId,
        triggeredById: ctx?.state?.currentUser?.id,
      },
    });

    const execId = String(execution.id);

    (this as any).app.logger.info(
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
      await (this as any).app.pubSubManager.subscribe(progressChannel, progressCallback);
      cleanups.push({ channel: progressChannel, callback: progressCallback });

      await (this as any).app.pubSubManager.subscribe(doneChannel, doneCallback);
      cleanups.push({ channel: doneChannel, callback: doneCallback });

      // Handle user abort (cancel chat) → propagate to worker
      if (ctx?.req?.signal || ctx?.signal) {
        const signal = ctx.req?.signal || ctx.signal;
        signal.addEventListener?.('abort', () => {
          clearTimeout(timeout);
          // Publish abort to worker via PubSub
          (this as any).app.pubSubManager.publish(abortChannel, { reason: 'user_cancel' }).catch(() => {});
          // Also update the execution status
          (this as any).db
            .getRepository('skillExecutions')
            .update({
              filter: { id: execId },
              values: { status: 'canceled' },
            })
            .catch(() => {});
          rejectPromise(new Error('Canceled by user'));
        });
      }

      // NOW dispatch to sandbox workers.
      await (this as any).app.pubSubManager.publish('skill-hub.task', { id: execId });

      // Wait for completion
      result = await resultPromise;
    } finally {
      // Cleanup all PubSub subscriptions
      for (const { channel, callback } of cleanups) {
        try {
          await (this as any).app.pubSubManager.unsubscribe(channel, callback);
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

    return {
      ...result,
      files: filesWithUrls,
      execId,
      agentLoopRunId: traceContext?.agentLoopRunId,
      agentLoopStepId: traceContext?.agentLoopStepId,
    };
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

    const execution = await (this as any).db.getRepository('skillExecutions').findOne({
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

    const skill = await (this as any).db.getRepository('skillDefinitions').findOne({
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
      config.get
        ? {
            npmRegistryUrl: config.get('npmRegistryUrl'),
            npmAuthToken: config.get('npmAuthToken'),
            pypiIndexUrl: config.get('pypiIndexUrl'),
            pypiTrustedHost: config.get('pypiTrustedHost'),
            aptMirrorUrl: config.get('aptMirrorUrl'),
            aptGpgKeyUrl: config.get('aptGpgKeyUrl'),
            customPackages,
          }
        : config,
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
        await (this as any).db.getRepository('skillWorkerConfigs').update({
          filter: {},
          values,
          forceUpdate: true,
        });
        (this as any).app.logger.info(`[skill-hub] Init env ${data.status}`);
      } catch (err) {
        (this as any).app.logger.warn('[skill-hub] Failed to update init env status:', err);
      }
    };

    this.initEnvProgressCallback = async (data: any) => {
      try {
        await (this as any).db.getRepository('skillWorkerConfigs').update({
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

    await (this as any).app.pubSubManager.subscribe('skill-hub.init-env.done', this.initEnvDoneCallback);
    await (this as any).app.pubSubManager.subscribe('skill-hub.init-env.progress', this.initEnvProgressCallback);
  }

  private getSkillRecordId(skill: any) {
    return String(skill.get ? skill.get('id') : skill.id);
  }

  private resolveLoopInteractionSchema(loopConfig: any) {
    if (!loopConfig) return null;

    const schema = parseJsonText(loopConfig.get ? loopConfig.get('schema') : loopConfig.schema, null);
    const prompt = loopConfig.get ? loopConfig.get('prompt') : loopConfig.prompt;

    if (schema && typeof schema === 'object') {
      return prompt && !schema.prompt ? { ...schema, prompt } : schema;
    }

    if (prompt) {
      return {
        type: 'confirm',
        prompt,
      };
    }

    return null;
  }

  private async getLoopConfigsBySkillId(skillIds: Array<string | number>) {
    const ids = Array.from(new Set(skillIds.map((id) => String(id)).filter(Boolean)));
    const configsBySkillId = new Map<string, any>();
    if (!ids.length) return configsBySkillId;

    try {
      const configs = await (this as any).db.getRepository('skillLoopConfigs').find({
        filter: {
          enabled: true,
          skillId: {
            $in: ids,
          },
        },
        sort: ['-updatedAt'],
      });

      for (const config of configs || []) {
        const skillId = String(config.get ? config.get('skillId') : config.skillId);
        if (!configsBySkillId.has(skillId)) {
          configsBySkillId.set(skillId, config);
        }
      }
    } catch (err) {
      (this as any).app.logger.warn('[skill-hub] Failed to load loop configs', err);
    }

    return configsBySkillId;
  }

  private registerAITools() {
    try {
      // Register on the SAME tools manager the harness resolves from
      // (app.aiManager.toolsManager). Using pluginAI.ai.toolsManager here while
      // the harness reads app.aiManager.toolsManager would register skill tools
      // on one object and look them up on another if the wiring ever diverges.
      const toolsManager = tryGetAIToolsManager((this as any).app);
      if (!toolsManager) {
        (this as any).app.logger.warn('[skill-hub] plugin-ai not available, skip AI tool registration.');
        return;
      }

      // 1. General tool (list + execute)
      toolsManager.registerTools(createSkillExecuteTool(this));

      // 2. Dynamic tools — each enabled skill becomes a separate AI tool.
      toolsManager.registerDynamicTools(async (register: { registerTools: (options: any) => void }) => {
        try {
          const skills = await (this as any).db.getRepository('skillDefinitions').find({
            filter: { enabled: true },
          });

          if (!skills || skills.length === 0) return;

          const loopConfigsBySkillId = await this.getLoopConfigsBySkillId(
            skills.map((skill: any) => this.getSkillRecordId(skill)),
          );

          const tools = await Promise.all(
            skills.map(async (skill: any) => {
              const sanitizedToolName = skill
                .get('name')
                .toLowerCase()
                .replace(/[^a-z0-9_]/g, '_')
                .replace(/_+/g, '_')
                .replace(/^_|_$/g, '');
              const autoCall = !!skill.get('autoCall');
              const loopConfig = loopConfigsBySkillId.get(this.getSkillRecordId(skill));
              const loopInteractionSchema = this.resolveLoopInteractionSchema(loopConfig);
              const skillInteractionSchema = parseJsonText(skill.get('interactionSchema'), null);
              const interactionSchema = loopInteractionSchema || skillInteractionSchema;
              const requiresHumanReview = !!interactionSchema;
              const fullDescription = await this.getSkillDescriptionForAI(skill);
              const baseDescription = `${fullDescription || skill.get('description')}\nLanguage: ${skill.get(
                'language',
              )}`;
              const description = requiresHumanReview
                ? `${baseDescription}\n\nIMPORTANT: This skill is bound to a Skill Hub human-in-the-loop review template. Pass best-effort args; the user can approve, edit, or reject them before execution.`
                : baseDescription;
              return {
                scope: 'CUSTOM' as const,
                execution: 'backend' as const,
                defaultPermission: (requiresHumanReview ? 'ASK' : autoCall ? 'ALLOW' : 'ASK') as 'ALLOW' | 'ASK',
                introduction: {
                  title: `Skill Hub: ${skill.get('title')}`,
                  about: skill.get('description') || `Thực thi kỹ năng ${skill.get('title')}`,
                },
                definition: {
                  name: `skill_hub_${sanitizedToolName}`,
                  description,
                  schema: parseJsonText(skill.get('inputSchema'), { type: 'object', properties: {} }),
                },
                invoke: async (toolCtx: any, args: any, runtime?: ToolRuntimeInput) => {
                  const restoreRuntime = assignToolRuntime(toolCtx, runtime);
                  try {
                    // Re-fetch skill to get latest version (hot-reload support)
                    const latestSkill = await (this as any).db.getRepository('skillDefinitions').findOne({
                      filter: { id: skill.get('id'), enabled: true },
                    });
                    if (!latestSkill) {
                      return { status: 'error', content: `Skill "${skill.get('name')}" is no longer available` };
                    }
                    const result = await this.executeSkill(latestSkill, args, toolCtx);
                    return {
                      status: result.status === 'succeeded' ? 'success' : 'error',
                      result: result, // Attach raw result
                    };
                  } finally {
                    restoreRuntime();
                  }
                },
              };
            }),
          );

          register.registerTools(tools);
        } catch (err) {
          (this as any).app.logger.warn('[skill-hub] Failed to provide dynamic tools', err);
        }
      });

      (this as any).app.logger.info('[skill-hub] AI tools registered (dynamic provider + general tool).');
    } catch (error) {
      (this as any).app.logger.warn('[skill-hub] Failed to register AI tools:', error);
    }
  }

  private startCleanupInterval() {
    if (this.cleanupInterval) return;
    // Check old execution files every hour, rate limiter every 5 minutes
    const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

    this.cleanupInterval = setInterval(async () => {
      // 1. Storage Retention Cleanup
      try {
        const config = await (this as any).db.getRepository('skillWorkerConfigs').findOne();
        const hours = config ? config.get('retentionHours') : 24;

        if (hours && hours > 0) {
          const MAX_AGE_MS = hours * 60 * 60 * 1000;
          const cutoff = new Date(Date.now() - MAX_AGE_MS);
          const repo = (this as any).db.getRepository('skillExecutions');

          const outdated = await repo.find({
            filter: { createdAt: { $lt: cutoff } },
          });

          if (outdated.length > 0) {
            for (const record of outdated) {
              await record.destroy(); // Fires afterDestroy hook which removes physical folder
            }
            (this as any).app.logger.info(`[skill-hub] Auto-cleaned up ${outdated.length} expired execution records`);
          }
        }
      } catch (err) {
        (this as any).app.logger.warn('[skill-hub] Auto Cleanup error:', err);
      }

      // 2. Cleanup rate limiter stale entries
      this.rateLimiter.cleanup();
    }, CLEANUP_INTERVAL);
  }

  async beforeStop() {
    (this as any).app.off?.('afterStart', this.afterStart);
    (this as any).app.removeListener?.('afterStart', this.afterStart);
    // Unsubscribe PubSub
    if (this.skillTaskCallback) {
      try {
        await (this as any).app.pubSubManager.unsubscribe('skill-hub.task', this.skillTaskCallback);
      } catch {
        /* ignore */
      }
    }
    if (this.initEnvTaskCallback) {
      try {
        await (this as any).app.pubSubManager.unsubscribe('skill-hub.init-env', this.initEnvTaskCallback);
      } catch {
        /* ignore */
      }
    }
    if (this.initEnvDoneCallback) {
      try {
        await (this as any).app.pubSubManager.unsubscribe('skill-hub.init-env.done', this.initEnvDoneCallback);
      } catch {
        /* ignore */
      }
    }
    if (this.initEnvProgressCallback) {
      try {
        await (this as any).app.pubSubManager.unsubscribe('skill-hub.init-env.progress', this.initEnvProgressCallback);
      } catch {
        /* ignore */
      }
    }

    // Clear cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    if (this.skillTaskPoller) {
      clearInterval(this.skillTaskPoller);
      this.skillTaskPoller = null;
    }
  }

  // --- Handlers ---
  private async handleClearStorage(ctx: any, next: () => Promise<any>) {
    const { type } = ctx.request.body || ctx.action.params.values;
    const repo = (this as any).db.getRepository('skillExecutions');
    let count = 0;

    if (type === 'all') {
      const results = await repo.find({ fields: ['id'] });
      for (const rec of results) {
        await rec.destroy();
      }
      count = results.length;
    } else if (type === 'expired') {
      const config = await (this as any).db.getRepository('skillWorkerConfigs').findOne();
      const hours = config ? config.get('retentionHours') : 24;
      if (hours > 0) {
        const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
        const results = await repo.find({ filter: { createdAt: { $lt: cutoff } }, fields: ['id'] });
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
      const allPlugins = (this as any).app.pm.getPlugins();
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
      (this as any).app.logger.warn(`[skill-hub] Failed to discover some plugin skills: ${e.message}`);
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
    (this as any).app.logger.info(
      `[skill-hub] Registered skill template "${skillDef.name}" from plugin "${pluginName}"`,
    );
  }

  resolveSkillTemplate(templateName: string) {
    if (!templateName) return null;
    const cached = this.skillTemplates.get(templateName);
    if (cached) return cached;

    try {
      const allPlugins = (this as any).app.pm.getPlugins();
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
      (this as any).app.logger.warn(`[skill-hub] Failed to resolve plugin skill "${templateName}": ${e.message}`);
    }

    return null;
  }

  async getSkillDescriptionForAI(skill: any) {
    const description = skill.get ? skill.get('description') : skill.description;
    const instructions = await this.getSkillInstructions(skill);
    const maxInlineInstructionChars = 24000;
    const inlineInstructions =
      instructions && instructions.length > maxInlineInstructionChars
        ? `${instructions.slice(
            0,
            maxInlineInstructionChars,
          )}\n\n[Instructions truncated in tool description. Call skill_hub_execute with action="describe" and this skillName to load the complete workflow.]`
        : instructions;
    return [description, inlineInstructions ? `Instructions:\n${inlineInstructions}` : ''].filter(Boolean).join('\n\n');
  }

  async getSkillInstructions(skill: any) {
    const storedInstructions = skill.get ? skill.get('instructions') : skill.instructions;
    if (storedInstructions) return storedInstructions;

    const storageType = skill.get ? skill.get('storageType') : skill.storageType;
    if (storageType !== 'plugin') return '';

    const templateName =
      (skill.get ? skill.get('pluginSource') : skill.pluginSource) || (skill.get ? skill.get('name') : skill.name);
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
export function shouldRunSkillSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SKILL_HUB_SANDBOX === 'false') return false;
  const workerMode = String(env.WORKER_MODE || '').trim();
  if (!workerMode) return true;
  if (
    workerMode === '*' ||
    workerMode
      .split(',')
      .map((value) => value.trim())
      .includes('skill-hub:sandbox')
  ) {
    return true;
  }
  return workerMode
    .split(',')
    .map((value) => value.trim())
    .includes('skill-hub.task');
}
