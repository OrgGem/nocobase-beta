import { Instruction, JOB_STATUS } from '@nocobase/plugin-workflow';
import type { FlowNodeModel, Processor } from '@nocobase/plugin-workflow';
import { COLLECTION, CarboneOutputFormat } from '../../shared/constants';
import { CacheManager, inputMd5 } from '../services/cache-manager';
import { RenderPipeline } from '../services/render-pipeline';
import { RenderLogger } from '../services/render-logger';
import type { PluginCarboneTemplateManagerServer } from '../plugin';

/**
 * Workflow instruction `carbone-render`.
 *
 * Config:
 *   - `templateId` — id of a managed `carboneTemplates` row.
 *   - `data`       — an object whose values may reference workflow variables.
 *                    Resolved via `processor.getParsedValue(...)` so any
 *                    upstream node can feed the render.
 *   - `format`     — output format (defaults to template's defaultOutputFormat).
 *   - `filename`   — optional output filename.
 *   - `bypassCache` / `persistOutput` — pass-through to the pipeline.
 *   - `ignoreFail` — when true, render errors resolve the job instead of
 *                    failing the workflow.
 *
 * Job result: `{ attachmentId, url, format, size, cacheHit, cacheKey,
 *                durationMs, carboneTemplateId }` so downstream nodes can
 * attach the file (e.g. mailer, request) without an extra DB query.
 */
export function makeCarboneRenderInstructionClass(plugin: PluginCarboneTemplateManagerServer) {
  return class CarboneRenderInstruction extends Instruction {
    async run(node: FlowNodeModel, prevJob: any, processor: Processor) {
      const t0 = Date.now();
      const config = processor.getParsedValue(node.config, node.id) || {};
      const {
        templateId,
        versionId,
        data,
        format,
        filename,
        bypassCache,
        persistOutput,
        ignoreFail,
      } = config;
      const renderLogger = new RenderLogger(plugin.app);
      let resolvedTpl: any = null;

      try {
        if (!templateId) {
          return failOrIgnore(ignoreFail, 'templateId is required');
        }

        const tpl = await plugin.db
          .getRepository(COLLECTION.templates)
          .findOne({ filterByTk: templateId, appends: ['currentVersion'] });
        resolvedTpl = tpl;
        if (!tpl) return failOrIgnore(ignoreFail, `template ${templateId} not found`);
        if (!tpl.enabled) return failOrIgnore(ignoreFail, `template ${templateId} is disabled`);
        if (!tpl.carboneTemplateId) {
          return failOrIgnore(ignoreFail, `template ${templateId} has no Carbone id`);
        }

        const version = versionId
          ? await plugin.db
              .getRepository(COLLECTION.versions)
              .findOne({ filterByTk: versionId })
          : tpl.currentVersion;
        if (!version) return failOrIgnore(ignoreFail, `template version ${versionId ?? tpl.currentVersionId} not found`);
        if (Number(version.templateId) !== Number(tpl.id)) {
          return failOrIgnore(ignoreFail, `version ${version.id} does not belong to template ${tpl.id}`);
        }
        const carboneTemplateId = version.carboneTemplateId ?? tpl.carboneTemplateId;

        const client = await plugin.getCarboneClient();
        if (!client) return failOrIgnore(ignoreFail, 'Carbone settings are not configured');

        const pipeline = new RenderPipeline(plugin.app, client, new CacheManager(plugin.app));
        const outcome = await pipeline.render({
          templateId: tpl.id,
          versionId: version.id,
          carboneTemplateId,
          data: data ?? {},
          format: (format as CarboneOutputFormat | undefined) ?? tpl.defaultOutputFormat,
          filename: filename ?? tpl.originalFileName?.replace(/\.[^.]+$/, '') ?? tpl.name,
          bypassCache: !!bypassCache,
          persistOutput: persistOutput !== false, // default true for workflows
        });

        // Best-effort log entry — workflow renders count toward monitoring too.
        renderLogger
          .log({
            action: 'renderById',
            templateId: tpl.id,
            versionId: version.id,
            carboneTemplateId,
            format: outcome.format,
            filename,
            cacheKey: outcome.cacheKey,
            cacheHit: outcome.cacheHit,
            inputMd5: outcome.inputMd5,
            outputBytes: outcome.size,
            durationMs: outcome.durationMs,
            outputAttachmentId: outcome.attachmentId,
            inputData: data ?? {},
            roleName: 'workflow',
            status: 'success',
          })
          .catch(() => undefined);

        return {
          status: JOB_STATUS.RESOLVED,
          result: {
            attachmentId: outcome.attachmentId,
            url: outcome.url,
            format: outcome.format,
            size: outcome.size,
            cacheHit: outcome.cacheHit,
            cacheKey: outcome.cacheKey,
            durationMs: outcome.durationMs,
            carboneTemplateId,
          },
        };
      } catch (err: any) {
        renderLogger
          .log({
            action: 'renderById',
            templateId: resolvedTpl?.id ?? (templateId ? Number(templateId) : undefined),
            versionId: versionId ? Number(versionId) : resolvedTpl?.currentVersionId,
            carboneTemplateId: resolvedTpl?.carboneTemplateId,
            format: (format as CarboneOutputFormat | undefined) ?? resolvedTpl?.defaultOutputFormat,
            filename,
            inputMd5: inputMd5(data ?? {}),
            durationMs: Date.now() - t0,
            inputData: data ?? {},
            roleName: 'workflow',
            status: 'error',
            errorMessage: err?.message || String(err),
          })
          .catch(() => undefined);
        return failOrIgnore(ignoreFail, err?.message || String(err));
      }
    }
  };
}

function failOrIgnore(ignoreFail: boolean, message: string) {
  return {
    status: ignoreFail ? JOB_STATUS.RESOLVED : JOB_STATUS.FAILED,
    result: ignoreFail ? { error: message } : message,
  };
}
