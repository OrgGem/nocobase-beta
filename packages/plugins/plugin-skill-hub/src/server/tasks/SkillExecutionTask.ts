import Application from '@nocobase/server';
import { SandboxRunner } from '../services/SandboxRunner';
import { FileManager } from '../services/FileManager';
import { SkillRepositoryService } from '../services/SkillRepositoryService';

/**
 * Lightweight abort controller compatible with the SandboxRunner signal interface.
 * Worker-side: subscribes to PubSub abort channel and triggers signal.
 */
class TaskAbortController {
  private listeners: Array<() => void> = [];
  private _aborted = false;

  get aborted() {
    return this._aborted;
  }

  get signal() {
    return {
      addEventListener: (_event: string, listener: () => void) => {
        if (this._aborted) {
          listener();
        } else {
          this.listeners.push(listener);
        }
      },
    };
  }

  abort() {
    if (this._aborted) return;
    this._aborted = true;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // ignore
      }
    }
    this.listeners = [];
  }
}

export class SkillExecutionTask {
  constructor(
    private execution: any,
    private sandboxRunner: SandboxRunner,
    private fileManager: FileManager,
    private skillRepoService: SkillRepositoryService,
    private app: Application,
  ) {}

  async run() {
    const skill = this.execution.get('skill') || this.execution.skill;
    const execId = String(this.execution.get('id'));

    await this.execution.update({ status: 'running' });

    // Set up abort controller — listens for cancel from main server via PubSub
    const abortController = new TaskAbortController();
    const abortChannel = `skill-hub.abort.${execId}`;
    const abortCallback = async () => {
      this.app.logger.info(`[skill-hub] Task ${execId}: received abort signal`);
      abortController.abort();
    };

    try {
      // Subscribe to abort channel before starting execution
      await this.app.pubSubManager.subscribe(abortChannel, abortCallback);

      // Render code template with input args
      const inputArgs = this.execution.get('inputArgs') || {};
      const storageType = skill.get ? skill.get('storageType') : skill.storageType;
      
      let rawCodeTemplate = skill.get ? skill.get('codeTemplate') : skill.codeTemplate;
      let language = skill.get ? skill.get('language') : skill.language;
      let timeoutSeconds = skill.get ? skill.get('timeoutSeconds') : skill.timeoutSeconds;
      let maxOutputSizeMb = skill.get ? skill.get('maxOutputSizeMb') : skill.maxOutputSizeMb;

      if (storageType === 'plugin') {
        const pluginSkillName = skill.get ? skill.get('pluginSource') : skill.pluginSource;
        const skillHub = this.app.pm.get('plugin-skill-hub') as any;
        const pluginTemplate = skillHub?.skillTemplates?.get(pluginSkillName);
        
        if (pluginTemplate) {
          rawCodeTemplate = pluginTemplate.codeTemplate;
          language = pluginTemplate.language;
          if (pluginTemplate.timeoutSeconds) timeoutSeconds = pluginTemplate.timeoutSeconds;
          if (pluginTemplate.maxOutputSizeMb) maxOutputSizeMb = pluginTemplate.maxOutputSizeMb;
        } else {
          throw new Error(`Plugin skill "${pluginSkillName}" not found. Is the parent plugin enabled?`);
        }
      }

      const code = this.renderTemplate(rawCodeTemplate, inputArgs, execId);
      await this.execution.update({ executedCode: code });

      // Load package whitelist for import validation
      let packageWhitelist: string[] = [];
      try {
        const workerConfig = await this.app.db.getRepository('skillWorkerConfigs').findOne();
        if (workerConfig) {
          const wl = workerConfig.get ? workerConfig.get('packageWhitelist') : workerConfig.packageWhitelist;
          if (wl) {
            packageWhitelist = (language === 'node' ? wl.node : wl.python) || [];
          }
        }
      } catch {
        // Skip whitelist validation if config not available
      }

      // Pre-hydrate execution workspace with package contents (multi-file support)
      const workDir = this.fileManager.createExecDir(execId);
      const skillName = skill.name || skill.get?.('name');
      const fileId = skill.get ? skill.get('fileId') : skill.fileId;

      // In multi-node setups, local cache might be missing on this specific worker node. Re-download from S3 if needed.
      if (!require('fs').existsSync(this.skillRepoService.getSkillPath(skillName)) && fileId) {
        const fmPlugin = this.app.pm.get('@nocobase/plugin-file-manager') as any;
        const attachment = await this.app.db.getRepository('attachments').findOne({ filter: { id: fileId } });
        if (fmPlugin && attachment) {
          try {
            const streamData = await fmPlugin.getFileStream(attachment);
            if (streamData?.stream) {
              const tempZipPath = require('path').resolve(require('os').tmpdir(), `skill_${Date.now()}_exec.zip`);
              await new Promise((resolvePipe, rejectPipe) => {
                const writeStream = require('fs').createWriteStream(tempZipPath);
                streamData.stream.pipe(writeStream);
                writeStream.on('finish', resolvePipe);
                writeStream.on('error', rejectPipe);
                streamData.stream.on('error', rejectPipe);
              });
              await this.skillRepoService.extractSkillPackage(skillName, tempZipPath);
              require('fs').unlinkSync(tempZipPath);
              this.app.logger.info(`[skill-hub] Task ${execId}: Auto-restored skill package ${skillName} from S3/Storage`);
            }
          } catch (fetchErr) {
            this.app.logger.warn(`[skill-hub] Task ${execId}: Failed to fetch skill package ${skillName} from storage`, { error: fetchErr });
          }
        }
      }

      this.skillRepoService.copySkillPackageTo(skillName, workDir);

      const result = await this.sandboxRunner.execute({
        language,
        code,
        execId,
        timeoutSeconds: timeoutSeconds || 60,
        maxOutputSizeMb: maxOutputSizeMb || 50,
        signal: abortController.signal,
        packageWhitelist,
        onProgress: (progress) => {
          // Worker → PubSub → Main Server → runtime.writer → SSE → Client
          this.app.pubSubManager.publish(
            `skill-hub.progress.${execId}`,
            progress,
          );
        },
      });

      // Determine final status
      let status: string;
      if (result.canceled) {
        status = 'canceled';
      } else if (result.timedOut) {
        status = 'timeout';
      } else {
        status = result.success ? 'succeeded' : 'failed';
      }

      await this.execution.update({
        status,
        stdout: result.stdout,
        stderr: result.stderr,
        outputFiles: result.files,
        durationMs: result.durationMs,
      });

      // Notify main server: task completed
      await this.app.pubSubManager.publish(
        `skill-hub.done.${execId}`,
        {
          status,
          stdout: result.stdout?.slice(0, 3000),
          stderr: result.stderr?.slice(0, 1000),
          files: result.files,
        },
      );

      // Log execution metrics
      this.app.logger.info(
        `[skill-hub] Execution ${execId} ${status}: ` +
        `skill=${skill.get ? skill.get('name') : skill.name}, ` +
        `language=${language}, ` +
        `duration=${result.durationMs}ms, ` +
        `files=${result.files.length}, ` +
        `outputSize=${this.fileManager.getTotalOutputSize(execId)}bytes`,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      await this.execution.update({
        status: 'failed',
        stderr: errorMessage,
      });

      await this.app.pubSubManager.publish(
        `skill-hub.done.${execId}`,
        {
          status: 'failed',
          stderr: errorMessage,
          files: [],
        },
      );

      this.app.logger.error(`[skill-hub] Execution ${execId} error: ${errorMessage}`);
    } finally {
      // Always cleanup abort subscription
      try {
        await this.app.pubSubManager.unsubscribe(abortChannel, abortCallback);
      } catch {
        // ignore cleanup errors
      }
    }
  }

  private renderTemplate(template: string, args: Record<string, any>, execId: string): string {
    let code = template;
    for (const [key, value] of Object.entries(args)) {
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      code = code.replaceAll(`{{${key}}}`, serialized);
    }
    // Inject outputDir so code templates can use {{outputDir}}
    code = code.replaceAll('{{outputDir}}', this.fileManager.getOutputDir(execId));
    return code;
  }
}
