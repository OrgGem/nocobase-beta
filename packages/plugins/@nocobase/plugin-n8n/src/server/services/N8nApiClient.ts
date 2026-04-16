export class N8nApiClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async request(path: string, options: { method?: string; body?: any; timeout?: number } = {}) {
    const { method = 'GET', body, timeout = 10000 } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {
        'X-N8N-API-KEY': this.apiKey,
        Accept: 'application/json',
      };
      if (body) {
        headers['Content-Type'] = 'application/json';
      }
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`n8n API error ${res.status}: ${text}`);
      }
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        return res.json();
      }
      return res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  // Workflows
  async listWorkflows(cursor?: string, limit = 250) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    return this.request(`/api/v1/workflows?${params}`);
  }

  async listAllWorkflows() {
    const all: any[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.listWorkflows(cursor);
      all.push(...(res.data || []));
      cursor = res.nextCursor;
    } while (cursor);
    return all;
  }

  async getWorkflow(id: string) {
    return this.request(`/api/v1/workflows/${id}`);
  }

  async activateWorkflow(id: string) {
    return this.request(`/api/v1/workflows/${id}/activate`, { method: 'POST' });
  }

  async deactivateWorkflow(id: string) {
    return this.request(`/api/v1/workflows/${id}/deactivate`, { method: 'POST' });
  }

  async createWorkflow(data: any) {
    return this.request('/api/v1/workflows', { method: 'POST', body: data });
  }

  async updateWorkflow(id: string, data: any) {
    return this.request(`/api/v1/workflows/${id}`, { method: 'PATCH', body: data });
  }

  async deleteWorkflow(id: string) {
    return this.request(`/api/v1/workflows/${id}`, { method: 'DELETE' });
  }

  // Executions
  async listExecutions(params: { status?: string; workflowId?: string; limit?: number; cursor?: string } = {}) {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.workflowId) qs.set('workflowId', params.workflowId);
    qs.set('limit', String(params.limit || 20));
    if (params.cursor) qs.set('cursor', params.cursor);
    return this.request(`/api/v1/executions?${qs}`);
  }

  async getExecution(id: string) {
    return this.request(`/api/v1/executions/${id}`);
  }

  async retryExecution(id: string) {
    return this.request(`/api/v1/executions/${id}/retry`, { method: 'POST' });
  }

  async stopExecution(id: string) {
    return this.request(`/api/v1/executions/${id}/stop`, { method: 'POST' });
  }

  async deleteExecution(id: string) {
    return this.request(`/api/v1/executions/${id}`, { method: 'DELETE' });
  }

  // Variables
  async listVariables() {
    return this.request('/api/v1/variables');
  }

  async createVariable(data: { key: string; value: string; type?: string }) {
    return this.request('/api/v1/variables', { method: 'POST', body: data });
  }

  async updateVariable(id: string, data: { key?: string; value?: string }) {
    return this.request(`/api/v1/variables/${id}`, { method: 'PATCH', body: data });
  }

  async deleteVariable(id: string) {
    return this.request(`/api/v1/variables/${id}`, { method: 'DELETE' });
  }

  // Credentials
  async listCredentials() {
    return this.request('/api/v1/credentials');
  }

  async getCredentialTypes() {
    return this.request('/api/v1/credential-types');
  }

  async createCredential(data: any) {
    return this.request('/api/v1/credentials', { method: 'POST', body: data });
  }

  async updateCredential(id: string, data: any) {
    return this.request(`/api/v1/credentials/${id}`, { method: 'PATCH', body: data });
  }

  async deleteCredential(id: string) {
    return this.request(`/api/v1/credentials/${id}`, { method: 'DELETE' });
  }

  // Monitoring
  async healthCheck(): Promise<{ status: string; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.request('/healthz', { timeout: 5000 });
      return { status: 'healthy', latencyMs: Date.now() - start };
    } catch {
      return { status: 'unhealthy', latencyMs: Date.now() - start };
    }
  }

  async getMetricsRaw(): Promise<Record<string, Array<{ labels: Record<string, string>; value: number }>>> {
    const text = await this.request('/metrics', { timeout: 5000 });
    return parsePrometheusText(text as string);
  }

  async getMetricsSnapshot() {
    const raw = await this.getMetricsRaw();
    const getValue = (name: string, labelFilter?: Record<string, string>): number => {
      const entries = raw[name] || [];
      if (!labelFilter) return entries[0]?.value ?? 0;
      const entry = entries.find((e) =>
        Object.entries(labelFilter).every(([k, v]) => e.labels[k] === v),
      );
      return entry?.value ?? 0;
    };

    return {
      timestamp: Date.now(),
      cpu: getValue('process_cpu_seconds_total'),
      memoryRss: getValue('process_resident_memory_bytes'),
      heapUsed: getValue('nodejs_heap_size_used_bytes'),
      heapTotal: getValue('nodejs_heap_size_total_bytes'),
      eventLoopLag: getValue('nodejs_eventloop_lag_seconds'),
      eventLoopP99: getValue('nodejs_eventloop_lag_p99_seconds'),
      activeHandles: getValue('nodejs_active_handles_total'),
      activeRequests: getValue('nodejs_active_requests_total'),
      queueWaiting: getValue('n8n_queue_waiting_total') || getValue('bull_waiting_count'),
      queueActive: getValue('n8n_queue_active_total') || getValue('bull_active_count'),
      queueCompleted: getValue('n8n_queue_completed_total') || getValue('bull_completed_count'),
      queueFailed: getValue('n8n_queue_failed_total') || getValue('bull_failed_count'),
      activeWorkflows: getValue('n8n_active_workflows_total'),
    };
  }

  async getWorkers() {
    try {
      return await this.request('/api/v1/workers');
    } catch {
      return [];
    }
  }

  async triggerWebhook(path: string, data?: any) {
    const webhookUrl = path.startsWith('http') ? path : `${this.baseUrl}/webhook/${path}`;
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: data ? JSON.stringify(data) : undefined,
    });
    return res.json().catch(() => ({ status: res.status }));
  }
}

function parsePrometheusText(text: string): Record<string, Array<{ labels: Record<string, string>; value: number }>> {
  const result: Record<string, Array<{ labels: Record<string, string>; value: number }>> = {};
  if (!text || typeof text !== 'string') return result;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)\{?(.*?)\}?\s+([\d.eE+-]+|NaN|Inf|-Inf)$/);
    if (!match) continue;

    const [, name, labelsStr, valueStr] = match;
    const value = parseFloat(valueStr);
    if (isNaN(value)) continue;

    const labels: Record<string, string> = {};
    if (labelsStr) {
      const labelRegex = /(\w+)="([^"]*)"/g;
      let m: RegExpExecArray | null;
      while ((m = labelRegex.exec(labelsStr)) !== null) {
        labels[m[1]] = m[2];
      }
    }

    if (!result[name]) result[name] = [];
    result[name].push({ labels, value });
  }
  return result;
}
