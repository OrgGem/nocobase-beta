import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { ServiceConfig, EndpointDef } from '../types';
import FormData from 'form-data';

export interface FileInput {
  fieldName: string;
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

export interface ApiCallOptions {
  endpoint: EndpointDef;
  body?: Record<string, any>;
  files?: FileInput[];
  overrideHeaders?: Record<string, string>;
}

export class ExternalApiClient {
  private config: ServiceConfig;
  private client: AxiosInstance;

  constructor(config: ServiceConfig) {
    this.config = config;
    this.client = axios.create({
      baseURL: config.baseUrl,
      timeout: config.defaultTimeout,
    });
  }

  private buildAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (!this.config.authType || this.config.authType === 'none') {
      return headers;
    }

    if (this.config.authType === 'bearer' && this.config.authKey) {
      headers['Authorization'] = `Bearer ${this.config.authKey}`;
    } else if (this.config.authType === 'api_key' && this.config.authKey) {
      // Assuming api_key is sent in Authorization header or x-api-key based on common patterns.
      // Usually authHeaderName handles custom API keys, but we'll default to x-api-key if not provided.
      const name = this.config.authHeaderName || 'x-api-key';
      headers[name] = this.config.authKey;
    } else if (this.config.authType === 'custom_header' && this.config.authHeaderName && this.config.authKey) {
      headers[this.config.authHeaderName] = this.config.authKey;
    }

    return headers;
  }

  async call(options: ApiCallOptions): Promise<{ status: number; data: any; headers: any }> {
    const { endpoint, body, files, overrideHeaders } = options;

    const url = endpoint.subpath;
    const method = endpoint.method.toLowerCase();
    
    let requestData: any = body;
    let headers: Record<string, string> = {
      ...this.buildAuthHeaders(),
      ...(endpoint.customHeaders || {}),
      ...(overrideHeaders || {}),
    };

    if (endpoint.fileInputMode === 'multipart' && files && files.length > 0) {
      const formData = new FormData();
      if (body) {
        for (const [key, value] of Object.entries(body)) {
          formData.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
        }
      }
      for (const file of files) {
        formData.append(file.fieldName, file.buffer, {
          filename: file.filename,
          contentType: file.mimeType,
        });
      }
      requestData = formData;
      headers = { ...headers, ...formData.getHeaders() };
    } else if (endpoint.fileInputMode === 'base64' && files && files.length > 0) {
      // Place base64 files under their fieldName keys within the body.
      // PipelineExecutor's inputMapping should map $files[n].base64 to the correct body path.
      // Here we nest them under a `_files` key to avoid overwriting body fields.
      const base64Files: Record<string, { data: string; filename: string; mimeType: string }> = {};
      for (const f of files) {
        base64Files[f.fieldName] = {
          data: f.buffer.toString('base64'),
          filename: f.filename,
          mimeType: f.mimeType,
        };
      }
      requestData = { ...body, _files: base64Files };
      headers['Content-Type'] = 'application/json';
    } else {
      headers['Content-Type'] = 'application/json';
    }

    try {
      const response: AxiosResponse = await this.client.request({
        url,
        method,
        data: ['post', 'put', 'patch'].includes(method) ? requestData : undefined,
        params: ['get', 'delete'].includes(method) ? requestData : undefined,
        headers,
      });

      return {
        status: response.status,
        data: response.data,
        headers: response.headers,
      };
    } catch (error: any) {
      if (error.response) {
        throw new Error(`API Error [${error.response.status}]: ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
  }

  async get(url: string, overrideHeaders?: Record<string, string>): Promise<any> {
    const headers = { ...this.buildAuthHeaders(), ...(overrideHeaders || {}) };
    const response = await this.client.get(url, { headers });
    return response.data;
  }
}
