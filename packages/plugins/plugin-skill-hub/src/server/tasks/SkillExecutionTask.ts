import Application from '@nocobase/server';
import { SandboxRunner } from '../services/SandboxRunner';
import { FileManager } from '../services/FileManager';

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
      const codeTemplate = skill.get ? skill.get('codeTemplate') : skill.codeTemplate;
      const code = this.renderTemplate(codeTemplate, inputArgs, execId);
      await this.execution.update({ executedCode: code });

      const language = skill.get ? skill.get('language') : skill.language;
      const timeoutSeconds = skill.get ? skill.get('timeoutSeconds') : skill.timeoutSeconds;
      const maxOutputSizeMb = skill.get ? skill.get('maxOutputSizeMb') : skill.maxOutputSizeMb;

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
