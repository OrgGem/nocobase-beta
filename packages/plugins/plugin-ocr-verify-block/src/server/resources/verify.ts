import { Context, Next } from '@nocobase/actions';
import { COLLECTION } from '../../shared/constants';
import {
  NormalizedOcrItem,
  OcrMappingProfile,
  VerifyAction,
  VerifyActionInput,
  VerifyPayloadInput,
} from '../../shared/types';
import { applyOcrItemChanges, normalizeOcrJson } from '../services/json-mapping';
import { ensureDefaultMapping, ensureSettings } from './settings';

function getValues(ctx: Context) {
  return { ...(ctx.action.params || {}), ...(ctx.action.params.values || {}) };
}

function modelToJson(model: any) {
  return model?.toJSON ? model.toJSON() : model;
}

function getAttachmentUrl(value: any): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (!first) return null;
  if (typeof first === 'string') return first;
  const url = first.url || first.preview || first.thumbnail || first.path;
  if (url) return url;
  if (first.id != null) {
    return `/api/filePreviewAuth:download?id=${encodeURIComponent(String(first.id))}&collection=attachments`;
  }
  return null;
}

function normalizeAttachmentId(value: unknown): string | number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return /^\d+$/.test(trimmed) ? trimmed : null;
  }

  return null;
}

function assertSafeFieldName(ctx: Context, fieldName: string | undefined, label: string) {
  if (!fieldName) return;
  if (fieldName.includes('.') || fieldName.includes('[') || fieldName.includes(']') || fieldName === '__proto__') {
    ctx.throw(400, `${label} must be a direct collection field`);
  }
}

function assertCollectionFields(ctx: Context, input: VerifyPayloadInput) {
  const collection = ctx.db.getCollection(input.collection);
  if (!collection) ctx.throw(400, `Unknown collection: ${input.collection}`);

  const fields = [
    ['pdfField', input.pdfField],
    ['jsonField', input.jsonField],
    ['statusField', input.statusField],
  ] as const;
  for (const [label, fieldName] of fields) {
    assertSafeFieldName(ctx, fieldName, label);
    if (fieldName && !collection.getField(fieldName)) {
      ctx.throw(400, `${label} does not exist in collection ${input.collection}: ${fieldName}`);
    }
  }

  return collection;
}

function getCurrentRoles(ctx: Context) {
  const state: any = ctx.state || {};
  if (state.currentRoles?.length) return state.currentRoles;
  if (state.currentRole) return [state.currentRole];
  const user = state.currentUser?.toJSON ? state.currentUser.toJSON() : state.currentUser;
  const roles = user?.roles?.map?.((role: any) => role.name || role) || [];
  return roles.length ? roles : ['anonymous'];
}

async function getAclParams(ctx: Context, collection: string, action: 'get' | 'update') {
  const actionParams: any = {};
  const actionCtx: any = {
    app: ctx.app,
    db: ctx.db,
    database: (ctx as any).database ?? ctx.db,
    request: (ctx as any).request,
    req: (ctx as any).req,
    state: {
      ...(ctx.state || {}),
      currentRoles: getCurrentRoles(ctx),
      currentUser: (ctx.state as any)?.currentUser?.toJSON
        ? (ctx.state as any).currentUser.toJSON()
        : (ctx.state as any)?.currentUser,
    },
    action: {
      actionName: action,
      name: action,
      resourceName: collection,
      params: actionParams,
      mergeParams(params: any) {
        Object.assign(actionParams, params || {});
      },
    },
    permission: {},
    getCurrentRepository() {
      return ctx.db.getRepository(collection);
    },
    throw(...args: any[]) {
      ctx.throw(...args);
    },
  };

  await ctx.app.acl.getActionParams(actionCtx);
  return {
    can: actionCtx.permission?.can,
    params: actionCtx.permission?.parsedParams || actionCtx.permission?.can?.params || actionParams || {},
  };
}

function assertFieldAcl(ctx: Context, acl: any, fields: string[], action: 'get' | 'update') {
  const allowedFields = acl?.params?.fields;
  const allowedAppends = acl?.params?.appends || [];
  if (!Array.isArray(allowedFields) || allowedFields.length === 0) return;
  if (allowedFields.includes('*')) return;
  const allowed = new Set([...allowedFields, ...allowedAppends]);
  const denied = fields.filter(Boolean).filter((field) => !allowed.has(field));
  if (denied.length) {
    ctx.throw(403, `No ${action} permission for field(s): ${denied.join(', ')}`);
  }
}

function aclFilter(acl: any) {
  return acl?.params?.filter ? { ...acl.params.filter } : undefined;
}

async function getMapping(
  ctx: Context,
  input: VerifyPayloadInput,
): Promise<OcrMappingProfile & { id?: any; name?: string }> {
  const repo = ctx.db.getRepository(COLLECTION.mappingProfiles);
  let row: any = null;
  if (input.mappingProfileId) row = await repo.findOne({ filterByTk: input.mappingProfileId });
  if (!row && input.mappingProfileName) row = await repo.findOne({ filter: { name: input.mappingProfileName } });
  if (!row) row = await ensureDefaultMapping(ctx.db);
  return modelToJson(row);
}

async function getRecord(ctx: Context, input: VerifyPayloadInput, acl: any) {
  if (input.dataSource && input.dataSource !== 'main') {
    ctx.throw(400, 'Only the main data source is supported in the first OCR verify block version');
  }
  if (!input.collection || !input.recordId) ctx.throw(400, 'collection and recordId are required');
  assertCollectionFields(ctx, input);

  const repo = ctx.db.getRepository(input.collection);
  const record = await repo.findOne({
    filterByTk: input.recordId,
    filter: aclFilter(acl),
    appends: input.pdfField ? [input.pdfField] : [],
    context: ctx,
  });
  if (!record) ctx.throw(404, `Record not found or not accessible: ${input.collection}/${input.recordId}`);
  return { repo, record, json: modelToJson(record) };
}

function cloneJson(value: any) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

async function invokeCallback(ctx: Context, settings: any, payload: any) {
  const callbackUrl = settings.callbackUrl;
  if (!callbackUrl) return { callbackUrl: '', callbackStatus: 'skipped', callbackResponse: '' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.callbackTimeoutMs || 15000);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (settings.callbackApiKey) headers['X-API-Key'] = settings.callbackApiKey;
    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      callbackUrl,
      callbackStatus: String(response.status),
      callbackResponse: text.slice(0, 5000),
    };
  } catch (err: any) {
    return {
      callbackUrl,
      callbackStatus: 'error',
      callbackResponse: err?.message || String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function getPayload(ctx: Context, next: Next) {
  const input = getValues(ctx) as VerifyPayloadInput;
  if (!input.collection || !input.recordId) ctx.throw(400, 'collection and recordId are required');
  if (!input.pdfField || !input.jsonField) ctx.throw(400, 'pdfField and jsonField are required');

  const acl = await getAclParams(ctx, input.collection, 'get');
  assertFieldAcl(ctx, acl, [input.pdfField, input.jsonField, input.statusField].filter(Boolean), 'get');

  const { json } = await getRecord(ctx, input, acl);
  const mapping = await getMapping(ctx, input);

  const pdfAttachment = json[input.pdfField];
  const firstPdf = Array.isArray(pdfAttachment) ? pdfAttachment[0] : pdfAttachment;
  const attachmentId = normalizeAttachmentId(firstPdf?.attachmentId ?? firstPdf?.id ?? firstPdf?.uid);

  let ocrStatus = 'no-ocr';
  let ocrError = null;
  let ocrRawData = null;

  const ocrResultRepo = ctx.db.getRepository('attachmentOcrResults');
  if (attachmentId && ocrResultRepo) {
    const ocrRecord = await ocrResultRepo.findOne({
      filter: { attachmentId },
    });
    if (ocrRecord) {
      ocrStatus = ocrRecord.get('status') || 'no-ocr';
      ocrError = ocrRecord.get('error') || null;
      ocrRawData = ocrRecord.get('data') || null;
    }
  }

  let ocrJson = json[input.jsonField];
  if (!ocrJson && ocrRawData) {
    ocrJson = ocrRawData;
  }
  const items = normalizeOcrJson(ocrJson, mapping);

  ctx.body = {
    dataSource: input.dataSource || 'main',
    collection: input.collection,
    recordId: input.recordId,
    pdfField: input.pdfField,
    jsonField: input.jsonField,
    statusField: input.statusField,
    status: input.statusField ? json[input.statusField] : undefined,
    pdfUrl: getAttachmentUrl(json[input.pdfField]),
    attachmentId,
    ocrStatus,
    ocrError,
    data: ocrJson,
    items,
    mapping,
  };
  await next();
}

async function runAction(ctx: Context, action: VerifyAction) {
  const input = getValues(ctx) as VerifyActionInput;
  if (!input.collection || !input.recordId) ctx.throw(400, 'collection and recordId are required');
  if (!input.jsonField) ctx.throw(400, 'jsonField is required');

  const settings = modelToJson(await ensureSettings(ctx.db));
  const mapping = await getMapping(ctx, input);
  const readAcl = await getAclParams(ctx, input.collection, 'get');
  const updateAcl = await getAclParams(ctx, input.collection, 'update');
  assertFieldAcl(ctx, readAcl, [input.pdfField, input.jsonField, input.statusField].filter(Boolean), 'get');
  assertFieldAcl(ctx, updateAcl, [input.jsonField, input.statusField].filter(Boolean), 'update');

  const { record, json } = await getRecord(ctx, input, updateAcl);
  const beforeJson = cloneJson(json[input.jsonField]);
  const afterJson = cloneJson(input.data ?? beforeJson ?? {});
  const changedItems = input.items?.length ? applyOcrItemChanges(afterJson, mapping, input.items) : [];

  const values: Record<string, any> = { [input.jsonField]: afterJson };
  let status = input.status;
  if (action === 'accept') status = input.status || settings.acceptStatus || 'accepted';
  if (action === 'reject') status = input.status || settings.rejectStatus || 'rejected';
  if (status && input.statusField) values[input.statusField] = status;

  await record.update(values, {
    fields: Object.keys(values),
    context: ctx,
  });

  const callbackPayload = {
    event: `ocr.verify.${action}`,
    dataSource: input.dataSource || 'main',
    collection: input.collection,
    recordId: input.recordId,
    status,
    jsonField: input.jsonField,
    pdfField: input.pdfField,
    data: afterJson,
    changedItems,
  };
  const callback =
    action === 'saveDraft'
      ? { callbackUrl: '', callbackStatus: 'skipped', callbackResponse: '' }
      : await invokeCallback(ctx, settings, callbackPayload);

  const history = await ctx.db.getRepository(COLLECTION.histories).create({
    values: {
      dataSource: input.dataSource || 'main',
      collectionName: input.collection,
      recordId: String(input.recordId),
      pdfField: input.pdfField,
      jsonField: input.jsonField,
      statusField: input.statusField,
      action,
      status,
      beforeJson,
      afterJson,
      changedItems,
      ...callback,
    },
  });

  ctx.body = {
    ok: true,
    action,
    status,
    data: afterJson,
    items: normalizeOcrJson(afterJson, mapping) as NormalizedOcrItem[],
    history: modelToJson(history),
    callback,
  };
}

export async function saveDraft(ctx: Context, next: Next) {
  await runAction(ctx, 'saveDraft');
  await next();
}

export async function accept(ctx: Context, next: Next) {
  await runAction(ctx, 'accept');
  await next();
}

export async function reject(ctx: Context, next: Next) {
  await runAction(ctx, 'reject');
  await next();
}

export async function testCallback(ctx: Context, next: Next) {
  const settings = modelToJson(await ensureSettings(ctx.db));
  const values = getValues(ctx);
  const callbackUrl = values.callbackUrl || settings.callbackUrl;
  const callbackApiKey = values.callbackApiKey || (callbackUrl === settings.callbackUrl ? settings.callbackApiKey : '');
  const result = await invokeCallback(
    ctx,
    { ...settings, ...values, callbackUrl, callbackApiKey },
    {
      event: 'ocr.verify.test',
      ok: true,
      sentAt: new Date().toISOString(),
    },
  );
  ctx.body = { ok: result.callbackStatus !== 'error', ...result };
  await next();
}
