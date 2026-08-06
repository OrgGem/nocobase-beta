import type { NodeObservabilitySnapshot, ObservationAttribute, ServiceSnapshot } from '../contracts';
const ATTRIBUTE_LABELS = new Set(['llmService', 'provider', 'model', 'mode', 'endpoint']);
export function exportPrometheus(snapshot: NodeObservabilitySnapshot): string {
  const lines = [
    '# HELP nocobase_app_observability_requests_total Observations started by service.',
    '# TYPE nocobase_app_observability_requests_total counter',
  ];
  for (const service of Object.values(snapshot.services)) {
    const labels = serviceLabels(snapshot, service);
    lines.push(`nocobase_app_observability_requests_total${labels} ${service.requestCount}`);
    lines.push(`nocobase_app_observability_inflight${labels} ${service.inflight}`);
    lines.push(`nocobase_app_observability_failures_total${labels} ${service.failureCount}`);
    lines.push(`nocobase_app_observability_rejections_total${labels} ${service.rejectedCount}`);
    lines.push(`nocobase_app_observability_latency_ms_sum${labels} ${service.latency.sum}`);
    lines.push(`nocobase_app_observability_latency_ms_count${labels} ${service.latency.count}`);
    lines.push(`nocobase_app_observability_input_tokens_total${labels} ${service.inputTokens}`);
    lines.push(`nocobase_app_observability_output_tokens_total${labels} ${service.outputTokens}`);
  }
  lines.push('# TYPE nocobase_app_observability_active_users gauge');
  lines.push(
    `nocobase_app_observability_active_users${formatLabels({ app: snapshot.appName, node: snapshot.nodeId })} ${
      snapshot.activeUsers
    }`,
  );
  return `${lines.join('\n')}\n`;
}
function serviceLabels(snapshot: NodeObservabilitySnapshot, service: ServiceSnapshot): string {
  const attributes: Record<string, ObservationAttribute> = {};
  for (const [key, value] of Object.entries(service.attributes)) if (ATTRIBUTE_LABELS.has(key)) attributes[key] = value;
  return formatLabels({
    app: snapshot.appName,
    node: snapshot.nodeId,
    service: service.service,
    operation: service.operation,
    streaming: service.streaming,
    ...attributes,
  });
}
function formatLabels(labels: Record<string, ObservationAttribute>): string {
  const entries = Object.entries(labels)
    .filter(([, value]) => value != null)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, value]) => `${key.replace(/[^a-zA-Z0-9_]/g, '_')}="${escapeLabel(String(value))}"`)
    .join(',')}}`;
}
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}
