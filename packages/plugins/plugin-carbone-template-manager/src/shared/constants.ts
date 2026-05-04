export const NAMESPACE = 'plugin-carbone-template-manager';

export const COLLECTION = {
  templates: 'carboneTemplates',
  versions: 'carboneTemplateVersions',
  renderLogs: 'carboneRenderLogs',
  renderCache: 'carboneRenderCache',
  settings: 'carboneSettings',
} as const;

/**
 * All output formats Carbone may support across editions.
 *
 * Community edition only renders a subset (DOCX/XLSX/PPTX passthrough + PDF
 * via LibreOffice); the full list is kept here so the UI/API don't have to
 * change when an EE license is added later.
 */
export const SUPPORTED_OUTPUT_FORMATS = [
  'pdf',
  'docx',
  'doc',
  'xlsx',
  'xls',
  'pptx',
  'odt',
  'ods',
  'odp',
  'html',
  'txt',
  'csv',
  'rtf',
  'epub',
  'jpg',
  'png',
  'svg',
] as const;

export type CarboneOutputFormat = (typeof SUPPORTED_OUTPUT_FORMATS)[number];

export const DEFAULTS = {
  endpoint: 'http://carbone:4000',
  carboneVersion: '4',
  timeoutMs: 60_000,
  maxRetries: 2,
  defaultOutputFormat: 'pdf' as CarboneOutputFormat,
  enableCache: true,
  cacheTTL: 86_400, // 1 day
  cacheMaxSize: 1024 * 1024 * 1024, // 1 GB
  enableMonitoring: true,
  monitoringRetentionDays: 30,
  rateLimitPerMinute: 60,
  keepRawInDatabase: true,
} as const;
