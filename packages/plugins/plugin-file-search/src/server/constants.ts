export const FILE_SEARCH_WORKER_PROCESS = 'file-search:index';
export const FILE_SEARCH_QUEUE_ALIAS = 'plugin-file-search.index';

export const DEFAULT_ALLOWED_EXTNAMES = [
  '.pdf',
  '.md',
  '.markdown',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
  '.csv',
  '.tsv',
  '.html',
  '.htm',
  '.txt',
];

export const REQUIRED_PYTHON_PACKAGES = ['pageindex', 'litellm', 'pymupdf', 'PyPDF2', 'python-dotenv', 'pyyaml'];

export const DEFAULT_SETTINGS = {
  singletonKey: 'default',
  enabled: true,
  autoIndex: false,
  enableAiTool: false,
  parserStrategy: 'document-parser',
  llmService: null,
  indexModel: null,
  retrieveModel: null,
  pageIndexWorkspace: 'storage/pageindex',
  pageIndexPythonCommand: process.env.PAGEINDEX_PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3'),
  maxFileSizeMb: 50,
  allowedExtnames: DEFAULT_ALLOWED_EXTNAMES,
  concurrency: 1,
  timeoutMs: 30 * 60 * 1000,
};

export const DOCUMENT_STATUSES = ['pending', 'indexed', 'failed', 'deleted'] as const;
export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
