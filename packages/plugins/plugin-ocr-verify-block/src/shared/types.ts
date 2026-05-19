export type VerifyAction = 'saveDraft' | 'accept' | 'reject';

export interface OcrPoint {
  x: number;
  y: number;
}

export interface OcrRect {
  x: number;
  y: number;
  width: number;
  height: number;
  unit?: 'px' | 'point' | 'normalized' | string;
}

export interface NormalizedOcrItem {
  id?: string;
  key: string;
  value: any;
  page?: number;
  rect?: OcrRect;
  points?: OcrPoint[];
  confidence?: number;
  status?: string;
}

export interface OcrMappingProfile {
  itemsPath: string;
  idPath?: string;
  keyPath: string;
  valuePath: string;
  pagePath?: string;
  rectPath?: string;
  pointsPath?: string;
  confidencePath?: string;
  statusPath?: string;
}

export interface VerifyPayloadInput {
  dataSource?: string;
  collection: string;
  recordId: string | number;
  pdfField: string;
  jsonField: string;
  statusField?: string;
  mappingProfileId?: string | number;
  mappingProfileName?: string;
}

export interface VerifyActionInput extends VerifyPayloadInput {
  action?: VerifyAction;
  data?: any;
  items?: Array<Partial<NormalizedOcrItem>>;
  status?: string;
  callbackUrl?: string;
}
