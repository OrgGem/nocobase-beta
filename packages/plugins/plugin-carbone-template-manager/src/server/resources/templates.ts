import { Context, Next } from '@nocobase/actions';
import { createHash } from 'crypto';
import { COLLECTION } from '../../shared/constants';
import { PlaceholderParser } from '../services/placeholder-parser';
import { readAttachmentBuffer } from '../services/attachment-helper';
import type { PluginCarboneTemplateManagerServer } from '../plugin';

/**
 * Resource action handlers for `carboneTemplates`. The `:upload` and
 * `:parsePlaceholders` actions take an `attachmentId` (file already uploaded
 * via the standard `attachments:create` endpoint) so the user can pick any
 * file-manager storage at upload time. The server reads the buffer back,
 * extracts placeholders, sends to Carbone, and links the version to that
 * attachment so rollback always has the original bytes.
 */
export function makeTemplateActions(plugin: PluginCarboneTemplateManagerServer) {
  const parser = new PlaceholderParser();

  /**
   * Preview placeholders without persisting anything.
   */
  async function parsePlaceholders(ctx: Context, next: Next) {
    const { attachmentId } = ctx.action.params.values || {};
    const { buffer, attachment } = await readAttachmentBuffer(plugin.app, attachmentId);
    const schema = await parser.parse(buffer, attachment.mimetype);
    ctx.body = { schema, fileMd5: md5(buffer), fileSize: buffer.length };
    await next();
  }

  /**
   * Upload a new template (`templateId` not set) or a new version of an
   * existing template.
   */
  async function upload(ctx: Context, next: Next) {
    const v = ctx.action.params.values || {};
    const {
      attachmentId,
      name,
      description,
      category,
      tags,
      defaultOutputFormat,
      changeNote,
      templateId, // optional — when set we add a version
    } = v;

    if (!attachmentId) ctx.throw(400, 'attachmentId is required');
    if (!templateId && !name) ctx.throw(400, 'name is required for new templates');

    const client = await plugin.getCarboneClient();
    if (!client) ctx.throw(400, 'Carbone settings are not configured');

    const { buffer, attachment } = await readAttachmentBuffer(plugin.app, attachmentId);
    const fileMd5 = md5(buffer);
    const schema = await parser.parse(buffer, attachment.mimetype);

    const filename = attachment.filename || attachment.title || 'template';
    const carboneTemplateId = await client.uploadTemplate(buffer, filename);

    const db = plugin.db;
    const tplRepo = db.getRepository(COLLECTION.templates);
    const verRepo = db.getRepository(COLLECTION.versions);

    return await db.sequelize.transaction(async (transaction) => {
      let template = templateId ? await tplRepo.findOne({ filterByTk: templateId, transaction }) : null;

      if (!template) {
        template = await tplRepo.create({
          values: {
            name,
            description,
            category,
            tags: tags ?? [],
            originalFileName: filename,
            mimeType: attachment.mimetype,
            fileSize: buffer.length,
            defaultOutputFormat: defaultOutputFormat || 'pdf',
            placeholderSchema: schema,
            carboneTemplateId,
          },
          transaction,
        });
      }

      const lastVer = await verRepo.findOne({
        filter: { templateId: template.id },
        sort: ['-versionNumber'],
        transaction,
      });
      const versionNumber = (lastVer?.versionNumber ?? 0) + 1;

      const version = await verRepo.create({
        values: {
          templateId: template.id,
          versionNumber,
          carboneTemplateId,
          fileMd5,
          originalFileName: filename,
          mimeType: attachment.mimetype,
          fileSize: buffer.length,
          placeholderSchema: schema,
          changeNote,
          fileBackupId: attachmentId,
        },
        transaction,
      });

      await tplRepo.update({
        filterByTk: template.id,
        values: {
          currentVersionId: version.id,
          carboneTemplateId,
          originalFileName: filename,
          mimeType: attachment.mimetype,
          fileSize: buffer.length,
          placeholderSchema: schema,
          ...(description !== undefined ? { description } : {}),
          ...(category !== undefined ? { category } : {}),
          ...(tags !== undefined ? { tags } : {}),
          ...(defaultOutputFormat ? { defaultOutputFormat } : {}),
        },
        transaction,
      });

      ctx.body = {
        templateId: template.id,
        versionId: version.id,
        versionNumber,
        carboneTemplateId,
        fileMd5,
        placeholderSchema: schema,
      };
      await next();
    });
  }

  /**
   * Stream the backup file of a template's current version (or a specific
   * version if `?versionId=` is provided). Used by the "Download original"
   * button in the template manager.
   */
  async function download(ctx: Context, next: Next) {
    const { filterByTk } = ctx.action.params;
    const versionId = ctx.action.params.values?.versionId ?? ctx.action.params.versionId;

    const tpl = await plugin.db
      .getRepository(COLLECTION.templates)
      .findOne({ filterByTk, appends: ['currentVersion'] });
    if (!tpl) ctx.throw(404, 'template not found');

    const targetVersionId = versionId ?? tpl.currentVersionId;
    if (!targetVersionId) ctx.throw(404, 'no version to download');

    const ver = await plugin.db.getRepository(COLLECTION.versions).findOne({ filterByTk: targetVersionId });
    if (!ver?.fileBackupId) ctx.throw(404, 'backup file not available');

    const { buffer, attachment } = await readAttachmentBuffer(plugin.app, ver.fileBackupId);
    ctx.set('Content-Type', attachment.mimetype || 'application/octet-stream');
    ctx.set(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(attachment.filename || ver.originalFileName || 'template')}"`,
    );
    ctx.body = buffer;
    await next();
  }

  return { parsePlaceholders, upload, download };
}

/**
 * Version-scoped actions: rollback, schema diff.
 */
export function makeVersionActions(plugin: PluginCarboneTemplateManagerServer) {
  /**
   * Set a previous version as the current one. If Carbone has evicted the
   * SHA-256 entry (community LRU), we re-upload from the backup attachment
   * before flipping `currentVersionId`.
   */
  async function rollback(ctx: Context, next: Next) {
    const { filterByTk } = ctx.action.params;

    const verRepo = plugin.db.getRepository(COLLECTION.versions);
    const tplRepo = plugin.db.getRepository(COLLECTION.templates);

    const version = await verRepo.findOne({ filterByTk });
    if (!version) ctx.throw(404, 'version not found');

    const client = await plugin.getCarboneClient();
    if (!client) ctx.throw(400, 'Carbone settings are not configured');

    let carboneTemplateId = version.carboneTemplateId;

    // Probe Carbone via HEAD-like GET — community edition may have evicted the
    // templateId. If gone, re-upload from the backup attachment.
    let exists = true;
    try {
      exists = await client.templateExists(carboneTemplateId);
    } catch (err: any) {
      plugin.app.logger.warn(`[carbone-template-manager] rollback probe error (continuing): ${err?.message ?? err}`);
    }
    if (!exists) {
      if (!version.fileBackupId) {
        ctx.throw(409, 'Carbone no longer has this template and no backup is available');
      }
      const { buffer, attachment } = await readAttachmentBuffer(plugin.app, version.fileBackupId);
      carboneTemplateId = await client.uploadTemplate(
        buffer,
        attachment.filename || version.originalFileName || 'template',
      );
      await verRepo.update({ filterByTk: version.id, values: { carboneTemplateId } });
    }

    await tplRepo.update({
      filterByTk: version.templateId,
      values: {
        currentVersionId: version.id,
        carboneTemplateId,
        placeholderSchema: version.placeholderSchema,
        originalFileName: version.originalFileName,
        mimeType: version.mimeType,
        fileSize: version.fileSize,
      },
    });

    ctx.body = { ok: true, templateId: version.templateId, versionId: version.id, carboneTemplateId };
    await next();
  }

  /**
   * Diff the placeholder schemas of two versions. Returns added/removed paths.
   */
  async function diffSchema(ctx: Context, next: Next) {
    const { from, to } = ctx.action.params.values || {};
    const verRepo = plugin.db.getRepository(COLLECTION.versions);
    const a = await verRepo.findOne({ filterByTk: from });
    const b = await verRepo.findOne({ filterByTk: to });
    if (!a || !b) ctx.throw(404, 'version not found');

    const aPaths = collectLeafPaths(a.placeholderSchema);
    const bPaths = collectLeafPaths(b.placeholderSchema);
    ctx.body = {
      from: a.versionNumber,
      to: b.versionNumber,
      added: [...bPaths].filter((p) => !aPaths.has(p)),
      removed: [...aPaths].filter((p) => !bPaths.has(p)),
    };
    await next();
  }

  async function destroy(ctx: Context, next: Next) {
    const { filterByTk } = ctx.action.params;
    const verRepo = plugin.db.getRepository(COLLECTION.versions);
    const tplRepo = plugin.db.getRepository(COLLECTION.templates);

    const version = await verRepo.findOne({ filterByTk });
    if (!version) ctx.throw(404, 'version not found');

    const template = await tplRepo.findOne({ filterByTk: version.templateId });
    if (template?.currentVersionId === version.id) {
      ctx.throw(400, 'Cannot delete the current version');
    }

    const client = await plugin.getCarboneClient();
    const deleteRemote = version.carboneTemplateId
      ? await canDeleteRemoteTemplate(plugin, version.carboneTemplateId, version.id)
      : false;
    if (client && deleteRemote) {
      try {
        await client.deleteTemplate(version.carboneTemplateId);
      } catch (err: any) {
        plugin.app.logger.warn(
          `[carbone-template-manager] delete template probe error (ignoring): ${err?.message ?? err}`,
        );
      }
    }

    await verRepo.destroy({ filterByTk });
    ctx.body = { ok: true };
    await next();
  }

  return { rollback, diffSchema, destroy };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function md5(buf: Buffer): string {
  return createHash('md5').update(buf).digest('hex');
}

function collectLeafPaths(schema: any): Set<string> {
  const out = new Set<string>();
  walk(schema?.d || [], out);
  return out;
}
function walk(nodes: any[], out: Set<string>) {
  for (const n of nodes) {
    if (n.children?.length) walk(n.children, out);
    else out.add(n.path);
  }
}

async function canDeleteRemoteTemplate(
  plugin: PluginCarboneTemplateManagerServer,
  carboneTemplateId: string,
  deletingVersionId: number | string,
): Promise<boolean> {
  const verRepo = plugin.db.getRepository(COLLECTION.versions);
  const tplRepo = plugin.db.getRepository(COLLECTION.templates);

  const siblingVersions = await verRepo.find({
    filter: {
      carboneTemplateId,
      id: { $ne: deletingVersionId },
    },
    fields: ['id'],
    limit: 1,
  });
  if (siblingVersions.length > 0) return false;

  const activeTemplates = await tplRepo.find({
    filter: {
      carboneTemplateId,
      currentVersionId: { $ne: deletingVersionId },
    },
    fields: ['id'],
    limit: 1,
  });
  return activeTemplates.length === 0;
}
