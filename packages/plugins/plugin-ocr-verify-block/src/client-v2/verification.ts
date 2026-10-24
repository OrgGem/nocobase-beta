import type { APIClient } from '@nocobase/client-v2';
import type { VerifyAction, VerifyPayloadInput } from '../shared/types';
import type { OcrBlockProps, OcrItem, OcrPayload, OcrSettings, OcrStatus } from './types';

export type OcrRecordContext = {
  record?: Record<string, unknown>;
  collection?: {
    name?: string;
    dataSourceKey?: string;
    getFilterByTK?: (record: Record<string, unknown>) => unknown;
  };
  inputArgs?: { collectionName?: string; dataSourceKey?: string; filterByTk?: unknown };
};

export function resolveVerificationInput(props: OcrBlockProps, context: OcrRecordContext): Partial<VerifyPayloadInput> {
  const manual = props.sourceMode === 'manualRecord' || (!props.sourceMode && props.recordId != null);
  const collection = manual
    ? props.collection
    : props.collection || context.collection?.name || context.inputArgs?.collectionName;
  const sameCollection = !props.collection || props.collection === context.collection?.name;
  const record = sameCollection ? context.record : undefined;
  const contextKey = record
    ? context.collection?.getFilterByTK?.(record) ?? record.id
    : collection === context.inputArgs?.collectionName
      ? context.inputArgs?.filterByTk
      : undefined;
  const key = manual ? props.recordId : contextKey;
  return {
    dataSource: manual
      ? props.dataSource || 'main'
      : context.collection?.dataSourceKey || context.inputArgs?.dataSourceKey || 'main',
    collection,
    recordId: typeof key === 'string' || typeof key === 'number' ? key : undefined,
    pdfField: props.pdfField,
    jsonField: props.jsonField,
    statusField: props.statusField,
    categoryId: props.categoryId,
    categoryName: props.categoryName,
    mappingProfileId: props.mappingProfileId,
    mappingProfileName: props.mappingProfileName || 'default',
  };
}

type Response<T> = { data: { data: T } };
type OcrApi = Pick<APIClient, 'request'>;

export async function loadVerification(api: OcrApi, input: VerifyPayloadInput) {
  const [settings, payload] = await Promise.all([
    api.request<unknown, Response<OcrSettings>>({ url: 'ocrVerifySettings:get', method: 'get' }),
    api.request<unknown, Response<OcrPayload>>({ url: 'ocrVerify:getPayload', method: 'post', data: input }),
  ]);
  return { settings: settings.data.data, payload: payload.data.data };
}

export async function submitVerification(
  api: OcrApi,
  action: VerifyAction,
  input: VerifyPayloadInput,
  data: unknown,
  items: OcrItem[],
) {
  const response = await api.request<unknown, Response<{ data?: unknown; items?: OcrItem[] }>>({
    url: `ocrVerify:${action}`,
    method: 'post',
    data: { ...input, data, items },
  });
  return response.data.data;
}

export async function getOcrStatus(api: OcrApi, attachmentId: string | number): Promise<OcrStatus> {
  const response = await api.request<unknown, Response<{ data: OcrStatus }>>({
    url: 'filePreviewAuth:getOcrStatus',
    method: 'post',
    data: { attachmentId },
  });
  // file-preview-auth itself returns { data: status }; server dataWrapping adds the outer data envelope.
  return response.data.data.data;
}

export function formatOcrValue(value: unknown): string {
  if (value == null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
