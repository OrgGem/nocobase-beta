export const NAMESPACE = 'plugin-ocr-verify-block';

export const COLLECTION = {
  settings: 'ocrVerifySettings',
  mappingProfiles: 'ocrVerifyMappingProfiles',
  categories: 'ocrVerifyCategories',
  histories: 'ocrVerifyHistories',
} as const;

export const DEFAULT_SETTINGS = {
  pdfjsVersion: '4.10.38',
  pdfjsCdnUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs',
  pdfjsWorkerUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs',
  callbackUrl: '',
  callbackApiKey: '',
  callbackTimeoutMs: 15000,
  acceptStatus: 'accepted',
  rejectStatus: 'rejected',
  autoSave: true,
} as const;

export const DEFAULT_MAPPING = {
  name: 'default',
  title: 'Default OCR pages/items mapping',
  itemsPath: 'pages[].items[]',
  idPath: 'id',
  keyPath: 'key',
  valuePath: 'value',
  pagePath: 'position.page',
  rectPath: 'position',
  pointsPath: 'points',
  confidencePath: 'confidence',
  statusPath: 'status',
  enabled: true,
} as const;
