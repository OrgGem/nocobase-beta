import type { Context, Next } from '@nocobase/actions';
import { PageIndexRunnerService } from './services/pageindex-runner';
import { LlmServiceMapper } from './services/llm-service-mapper';
import { getOrCreateSettings, saveSettings } from './services/settings';
import { canAccessReference } from './services/search-access';
import { getDisplayFilename, resolveExtname } from './services/file-utils';
import { getFileSearchQueueStatus } from './queue';
import { REQUIRED_PYTHON_PACKAGES } from './constants';

function getValues(ctx: Context): Record<string, any> {
  return ctx.action.params?.values || ctx.request?.body || {};
}

function currentUserId(ctx: Context) {
  return ctx.state?.currentUser?.id || ctx.auth?.user?.id || null;
}

async function ensureDocumentAndReference(ctx: Context, values: Record<string, any>) {
  const fileCollection = String(values.fileCollection || 'attachments');
  const fileId = values.fileId || values.filterByTk;
  if (!fileId) ctx.throw(400, 'fileId is required.');

  const fileRepo = ctx.db.getRepository(fileCollection);
  if (!fileRepo) ctx.throw(400, `File collection "${fileCollection}" does not exist.`);
  const file = await fileRepo.findOne({ filterByTk: fileId });
  if (!file) ctx.throw(404, `File ${fileCollection}:${fileId} not found.`);
  const attachment = typeof file.toJSON === 'function' ? file.toJSON() : file;

  const docRepo = ctx.db.getRepository('fileSearchDocuments');
  let document = await docRepo.findOne({ filter: { fileCollection, fileId: String(fileId) } });
  const docValues = {
    fileCollection,
    fileId: String(fileId),
    filename: getDisplayFilename(attachment),
    mimetype: attachment.mimetype,
    extname: resolveExtname(attachment),
    size: attachment.size,
    status: 'pending',
    createdById: attachment.createdById || currentUserId(ctx),
  };
  if (document) {
    await docRepo.update({ filterByTk: document.get('id'), values: docValues });
    document = await docRepo.findOne({ filterByTk: document.get('id') });
  } else {
    document = await docRepo.create({ values: docValues });
  }

  const ownerCollection = values.ownerCollection || fileCollection;
  const ownerRecordId = values.ownerRecordId || fileId;
  const refRepo = ctx.db.getRepository('fileSearchReferences');
  const existingRef = await refRepo.findOne({
    filter: {
      documentId: document.get('id'),
      ownerCollection,
      ownerRecordId: String(ownerRecordId),
      ownerField: values.ownerField || null,
    },
  });
  if (!existingRef) {
    await refRepo.create({
      values: {
        documentId: document.get('id'),
        ownerCollection,
        ownerRecordId: String(ownerRecordId),
        ownerField: values.ownerField || null,
        fileCollection,
        fileId: String(fileId),
        relationType: values.relationType || (ownerCollection === fileCollection ? 'standalone' : 'field'),
      },
    });
  }

  return document;
}

async function enqueueJob(ctx: Context, documentId: number | string, action = 'index') {
  const repo = ctx.db.getRepository('fileSearchJobs');
  const existing = await repo.findOne({ filter: { documentId, status: { $in: ['queued', 'running'] } } });
  if (existing) return existing;
  return repo.create({
    values: {
      documentId,
      action,
      status: 'queued',
      queuedAt: new Date(),
      attempts: 0,
    },
  });
}

export function createActions(plugin: any) {
  return {
    settings: {
      async get(ctx: Context, next: Next) {
        ctx.body = await getOrCreateSettings(ctx.db);
        await next();
      },

      async save(ctx: Context, next: Next) {
        ctx.body = await saveSettings(ctx.db, getValues(ctx));
        await next();
      },

      async healthCheck(ctx: Context, next: Next) {
        const settings = await getOrCreateSettings(ctx.db);
        const llm = await new LlmServiceMapper(ctx.app).resolveEnv(settings);
        const pageIndex = await new PageIndexRunnerService(ctx.app).healthCheck(settings, llm.env);
        const docParserPlugin =
          ctx.app.pm?.get?.('@nocobase/plugin-document-parser') || ctx.app.pm?.get?.('plugin-document-parser');
        const docParser = Boolean(docParserPlugin);
        ctx.body = {
          pageIndex,
          llm: { ok: llm.ok, message: llm.message },
          parser: {
            ok: docParser,
            message: docParser ? 'Document Parser is available.' : 'Document Parser is missing.',
          },
          queue: getFileSearchQueueStatus(),
          requiredPythonPackages: REQUIRED_PYTHON_PACKAGES,
        };
        await next();
      },
    },

    fileSearch: {
      async indexFile(ctx: Context, next: Next) {
        const document = await ensureDocumentAndReference(ctx, getValues(ctx));
        const job = await enqueueJob(ctx, document.get('id'));
        ctx.body = { documentId: document.get('id'), jobId: job.get('id'), status: job.get('status') };
        await next();
      },

      async scanSources(ctx: Context, next: Next) {
        const values = getValues(ctx);
        const limit = Math.max(1, Math.min(Number(values.limit || 200) || 200, 1000));
        const collections = Array.from(ctx.db.collections.values())
          .filter(
            (collection: any) =>
              collection?.name === 'attachments' ||
              collection?.name === 'aiFiles' ||
              collection?.options?.template === 'file',
          )
          .map((collection: any) => collection.name);
        let scanned = 0;
        let queued = 0;

        for (const collectionName of collections) {
          const repo = ctx.db.getRepository(collectionName);
          if (!repo) continue;
          const records = await repo.find({ limit });
          for (const record of records) {
            scanned += 1;
            const document = await ensureDocumentAndReference(ctx, {
              fileCollection: collectionName,
              fileId: record.get('id'),
            });
            const job = await enqueueJob(ctx, document.get('id'));
            if (job.get('status') === 'queued') queued += 1;
          }
        }

        ctx.body = { scanned, queued, collections };
        await next();
      },

      async reindexDocument(ctx: Context, next: Next) {
        const documentId = ctx.action.params?.filterByTk || getValues(ctx).documentId;
        if (!documentId) ctx.throw(400, 'documentId is required.');
        const job = await enqueueJob(ctx, documentId, 'reindex');
        ctx.body = { documentId, jobId: job.get('id'), status: job.get('status') };
        await next();
      },

      async retryJob(ctx: Context, next: Next) {
        const jobId = ctx.action.params?.filterByTk || getValues(ctx).jobId;
        if (!jobId) ctx.throw(400, 'jobId is required.');
        await ctx.db.getRepository('fileSearchJobs').update({
          filterByTk: jobId,
          values: { status: 'queued', queuedAt: new Date(), startedAt: null, finishedAt: null, errorMessage: null },
        });
        ctx.body = { jobId, status: 'queued' };
        await next();
      },

      async cancelJob(ctx: Context, next: Next) {
        const jobId = ctx.action.params?.filterByTk || getValues(ctx).jobId;
        if (!jobId) ctx.throw(400, 'jobId is required.');
        await ctx.db.getRepository('fileSearchJobs').update({
          filter: { id: jobId, status: { $in: ['queued', 'running'] } },
          values: { status: 'cancelled', finishedAt: new Date() },
        });
        ctx.body = { jobId, status: 'cancelled' };
        await next();
      },

      async search(ctx: Context, next: Next) {
        const values = { ...ctx.action.params, ...getValues(ctx) };
        const query = String(values.query || '').trim();
        if (!query) ctx.throw(400, 'query is required.');
        const limit = Math.max(1, Math.min(Number(values.topK || values.pageSize || 10) || 10, 50));
        const settings = await getOrCreateSettings(ctx.db);
        const docs = await ctx.db.getRepository('fileSearchDocuments').find({
          filter: {
            status: 'indexed',
            pageIndexDocId: { $ne: null },
            ...(values.fileCollection ? { fileCollection: values.fileCollection } : {}),
          },
          sort: ['-indexedAt'],
          limit: 200,
        });

        const refRepo = ctx.db.getRepository('fileSearchReferences');
        const docIds = docs.map((doc) => doc.get('id')).filter(Boolean);
        const allRefs = docIds.length ? await refRepo.find({ filter: { documentId: { $in: docIds } } }) : [];

        const refsByDocId = new Map<string, any[]>();
        for (const ref of allRefs) {
          const docId = String(ref.get('documentId'));
          const group = refsByDocId.get(docId);
          if (group) {
            group.push(ref);
          } else {
            refsByDocId.set(docId, [ref]);
          }
        }

        const allowedDocs = [];
        for (const doc of docs) {
          const refs = refsByDocId.get(String(doc.get('id'))) || [];
          if (await canAccessReference(ctx, doc, refs)) {
            allowedDocs.push(doc);
          }
        }

        const llm = await new LlmServiceMapper(ctx.app).resolveEnv(settings);
        if (!llm.ok) ctx.throw(400, llm.message);
        const pageIndexDocIds = allowedDocs.map((doc) => doc.get('pageIndexDocId')).filter(Boolean);
        const searchResult = pageIndexDocIds.length
          ? await new PageIndexRunnerService(ctx.app).search(settings, pageIndexDocIds, query, limit, llm.env)
          : { results: [] };

        const docsByPageIndexId = new Map(allowedDocs.map((doc) => [String(doc.get('pageIndexDocId')), doc]));
        ctx.body = {
          rows: searchResult.results.map((item) => {
            const doc = docsByPageIndexId.get(String(item.doc_id));
            const refs = doc ? refsByDocId.get(String(doc.get('id'))) || [] : [];
            const file = doc
              ? {
                  documentId: doc.get('id'),
                  fileId: doc.get('fileId'),
                  fileCollection: doc.get('fileCollection'),
                  filename: doc.get('filename'),
                  mimetype: doc.get('mimetype'),
                  pageIndexDocId: doc.get('pageIndexDocId'),
                }
              : {};
            return {
              ...file,
              title: item.title,
              snippet: item.snippet || '',
              page: item.page,
              nodeId: item.node_id,
              score: item.score,
              references: refs.map((ref) => ({
                ownerCollection: ref.get('ownerCollection'),
                ownerRecordId: ref.get('ownerRecordId'),
                ownerField: ref.get('ownerField') || undefined,
              })),
            };
          }),
          count: searchResult.results.length,
          page: 1,
          pageSize: limit,
          totalPage: 1,
        };
        await next();
      },

      async overview(ctx: Context, next: Next) {
        const docRepo = ctx.db.getRepository('fileSearchDocuments');
        const jobRepo = ctx.db.getRepository('fileSearchJobs');
        const countBy = async (repo: any, status: string) => repo.count({ filter: { status } }).catch(() => 0);
        ctx.body = {
          documents: {
            indexed: await countBy(docRepo, 'indexed'),
            pending: await countBy(docRepo, 'pending'),
            failed: await countBy(docRepo, 'failed'),
            deleted: await countBy(docRepo, 'deleted'),
          },
          jobs: {
            queued: await countBy(jobRepo, 'queued'),
            running: await countBy(jobRepo, 'running'),
            failed: await countBy(jobRepo, 'failed'),
            succeeded: await countBy(jobRepo, 'succeeded'),
          },
          queue: getFileSearchQueueStatus(),
        };
        await next();
      },
    },
  };
}
