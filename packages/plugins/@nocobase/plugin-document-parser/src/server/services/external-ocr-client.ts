/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import axios, { AxiosRequestConfig } from 'axios';
import FormData from 'form-data';
import type { AttachmentLike } from './internal-parser-registry';

// ─── Provider config types ─────────────────────────────────────────────────────

export type OcrAuthType = 'bearer' | 'api-key-header' | 'basic' | 'custom-headers' | 'none';
export type OcrRequestFormat = 'multipart' | 'json-base64' | 'url';

export type OcrProviderConfig = {
  apiEndpoint: string;
  authType: OcrAuthType;
  apiKey?: string;
  authConfig?: {
    headerName?: string; // for api-key-header
    username?: string; // for basic auth
    password?: string; // for basic auth
    customHeaders?: Record<string, string>; // for custom-headers
  };
  requestFormat: OcrRequestFormat;
  requestConfig?: {
    // multipart
    fileFieldName?: string;
    filenameFieldName?: string;
    mimetypeFieldName?: string;
    extraFields?: Record<string, string>;
    // json-base64
    base64FieldPath?: string;
    filenameFieldPath?: string;
    mimetypeFieldPath?: string;
    extraBody?: Record<string, any>;
    // url
    urlFieldPath?: string;
  };
  responseTextPath?: string;
  timeout?: number;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Set a value at a dot-path inside an object, creating intermediate objects */
function setByPath(obj: Record<string, any>, dotPath: string, value: any): void {
  const parts = dotPath.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

/** Get a value from an object via dot-path. Supports simple array index: "pages.0.text" */
function getByPath(obj: any, dotPath: string): any {
  if (!obj || !dotPath) return undefined;
  const parts = dotPath.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

/** Build Authorization / custom headers based on authType */
function buildAuthHeaders(config: OcrProviderConfig): Record<string, string> {
  const { authType, apiKey, authConfig = {} } = config;
  const headers: Record<string, string> = {};

  switch (authType) {
    case 'bearer':
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      break;
    case 'api-key-header': {
      const headerName = authConfig.headerName || 'X-Api-Key';
      if (apiKey) headers[headerName] = apiKey;
      break;
    }
    case 'basic': {
      const { username = '', password = '' } = authConfig;
      const encoded = Buffer.from(`${username}:${password}`).toString('base64');
      headers['Authorization'] = `Basic ${encoded}`;
      break;
    }
    case 'custom-headers':
      Object.assign(headers, authConfig.customHeaders ?? {});
      break;
    case 'none':
    default:
      break;
  }

  return headers;
}

// ─── Main client ──────────────────────────────────────────────────────────────

export type ExternalOcrCallOptions = {
  /** Raw file bytes */
  fileBuffer: Buffer;
  /** Original filename */
  filename: string;
  /** MIME type */
  mimetype: string;
  /** Download URL (used when requestFormat = 'url') */
  fileUrl?: string;
};

/**
 * Call an external OCR/document-parse API and return the extracted text.
 *
 * Supports three request formats:
 *  - `multipart`   → multipart/form-data (most common for file upload APIs)
 *  - `json-base64` → JSON body with base64-encoded file
 *  - `url`         → JSON body with file download URL (provider fetches the file itself)
 *
 * Auth methods: bearer, api-key-header, basic, custom-headers, none.
 */
export async function callExternalOcr(
  providerConfig: OcrProviderConfig,
  options: ExternalOcrCallOptions,
): Promise<string> {
  const {
    apiEndpoint,
    requestFormat = 'multipart',
    requestConfig = {},
    responseTextPath = 'text',
    timeout = 60000,
  } = providerConfig;

  const authHeaders = buildAuthHeaders(providerConfig);
  const axiosConfig: AxiosRequestConfig = {
    timeout,
    headers: { ...authHeaders },
  };
  let body: any;

  if (requestFormat === 'multipart') {
    const form = new FormData();
    const fileFieldName = requestConfig.fileFieldName || 'file';

    form.append(fileFieldName, options.fileBuffer, {
      filename: options.filename,
      contentType: options.mimetype,
    });

    if (requestConfig.filenameFieldName) {
      form.append(requestConfig.filenameFieldName, options.filename);
    }
    if (requestConfig.mimetypeFieldName) {
      form.append(requestConfig.mimetypeFieldName, options.mimetype);
    }
    for (const [k, v] of Object.entries(requestConfig.extraFields ?? {})) {
      form.append(k, v);
    }

    body = form;
    axiosConfig.headers = {
      ...axiosConfig.headers,
      ...form.getHeaders(),
    };
  } else if (requestFormat === 'json-base64') {
    const base64 = options.fileBuffer.toString('base64');
    const jsonBody: Record<string, any> = { ...(requestConfig.extraBody ?? {}) };

    setByPath(jsonBody, requestConfig.base64FieldPath || 'file', base64);
    if (requestConfig.filenameFieldPath) {
      setByPath(jsonBody, requestConfig.filenameFieldPath, options.filename);
    }
    if (requestConfig.mimetypeFieldPath) {
      setByPath(jsonBody, requestConfig.mimetypeFieldPath, options.mimetype);
    }

    body = jsonBody;
    axiosConfig.headers = {
      ...axiosConfig.headers,
      'Content-Type': 'application/json',
    };
  } else if (requestFormat === 'url') {
    if (!options.fileUrl) {
      throw new Error('[DocumentParser] requestFormat=url but no fileUrl was provided');
    }
    const jsonBody: Record<string, any> = { ...(requestConfig.extraBody ?? {}) };
    setByPath(jsonBody, requestConfig.urlFieldPath || 'url', options.fileUrl);

    body = jsonBody;
    axiosConfig.headers = {
      ...axiosConfig.headers,
      'Content-Type': 'application/json',
    };
  } else {
    throw new Error(`[DocumentParser] Unknown requestFormat: ${requestFormat}`);
  }

  const response = await axios.post(apiEndpoint, body, axiosConfig);
  const responseData = response.data;

  const text = getByPath(responseData, responseTextPath);
  if (typeof text !== 'string') {
    throw new Error(
      `[DocumentParser] Could not extract text from response at path "${responseTextPath}". ` +
        `Response: ${JSON.stringify(responseData).slice(0, 300)}`,
    );
  }

  return text;
}

/**
 * Lightweight connectivity test — sends a GET (or HEAD) to the provider endpoint
 * to check reachability and auth. Used by the "Test Connection" button.
 */
export async function testOcrProviderConnection(
  providerConfig: Pick<OcrProviderConfig, 'apiEndpoint' | 'authType' | 'apiKey' | 'authConfig' | 'timeout'>,
): Promise<{ ok: boolean; status?: number; message?: string }> {
  try {
    const authHeaders = buildAuthHeaders(providerConfig as OcrProviderConfig);
    const response = await axios.get(providerConfig.apiEndpoint, {
      headers: authHeaders,
      timeout: providerConfig.timeout ?? 10000,
      // Don't throw on 4xx/5xx so we can return the status to the UI
      validateStatus: () => true,
    });
    const ok = response.status >= 200 && response.status < 400;
    let message: string | undefined;
    if (!ok && response.status < 500) {
      message = `Auth/config error: HTTP ${response.status}`;
    } else if (response.status >= 500) {
      message = `Server error: HTTP ${response.status}`;
    }
    return { ok, status: response.status, message };
  } catch (err: any) {
    return { ok: false, message: err?.message ?? String(err) };
  }
}
