import type { FolderContext } from './types';
import {
  buildContainsFilter,
  buildDateRangeFilter,
  combineODataFilters,
  odataString,
  uniqueStrings,
} from '../utils/odata';

type UiPathRecord = Record<string, unknown>;

type UiPathClientLike = {
  get<T = UiPathRecord>(endpoint: string, options?: Record<string, unknown>): Promise<T>;
};

type LoggerLike = {
  warn?: (message: string) => void;
  debug?: (message: string) => void;
};

export type CorrelationConfidence = 'high' | 'medium' | 'low';

export interface CorrelatedRecord<T extends UiPathRecord = UiPathRecord> {
  confidence: CorrelationConfidence;
  reason: string;
  record: T;
}

interface CorrelationInput {
  folder?: FolderContext;
  bufferSeconds?: number;
}

interface FromLogInput extends CorrelationInput {
  logId?: string | number;
  jobKey?: string;
  timeStamp?: string;
  queueItemId?: string | number;
  queueItemKey?: string;
  queueReference?: string;
}

interface FromQueueItemInput extends CorrelationInput {
  queueItemId: string | number;
}

interface FromJobInput extends CorrelationInput {
  jobId?: string | number;
  jobKey?: string;
}

interface TimeWindow {
  start: string;
  end: string;
}

interface ProcessingAttempt {
  record: UiPathRecord;
  jobId?: number;
  jobKey?: string;
  robotId?: number;
  machine?: string;
  window?: TimeWindow;
}

interface LimitStatus {
  returned: number;
  limit: number;
  truncated: boolean;
}

interface TraceLimits {
  jobs: LimitStatus;
  queueItems: LimitStatus;
  strictLogs: LimitStatus;
  contextLogs: LimitStatus;
  processingAttempts: LimitStatus;
}

const DEFAULT_BUFFER_SECONDS = 30;
const MAX_JOB_CANDIDATES = 50;
const MAX_QUEUE_CANDIDATES = 50;
const MAX_STRICT_LOGS = 500;
const MAX_CONTEXT_LOGS = 200;
const MAX_PROCESSING_ATTEMPTS = 20;
const MAX_ATTEMPT_WINDOWS = 10;
const MAX_JOB_KEYS_PER_QUERY = 20;

function asRecord(value: unknown): UiPathRecord {
  return value && typeof value === 'object' ? (value as UiPathRecord) : {};
}

function asArray(value: unknown): UiPathRecord[] {
  const body = asRecord(value);
  if (Array.isArray(body.value)) return body.value.filter(isRecord);
  if (Array.isArray(body.ProcessingHistory)) return body.ProcessingHistory.filter(isRecord);
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is UiPathRecord {
  return Boolean(value) && typeof value === 'object';
}

function valueFor(record: UiPathRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];

    let current: unknown = record;
    for (const segment of key.split('.')) {
      if (!current || typeof current !== 'object') break;
      const nested = asRecord(current);
      const actualKey = Object.keys(nested).find((candidate) => candidate.toLowerCase() === segment.toLowerCase());
      current = actualKey ? nested[actualKey] : undefined;
    }
    if (current !== undefined && current !== null) return current;
  }
  return undefined;
}

function stringValue(record: UiPathRecord, key: string): string | undefined {
  const value = valueFor(record, [key]);
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function stringValueFor(record: UiPathRecord, keys: string[]): string | undefined {
  const value = valueFor(record, keys);
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function numberValue(record: UiPathRecord, key: string): number | undefined {
  const value = valueFor(record, [key]);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value);
  return undefined;
}

function numberValueFor(record: UiPathRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = numberValue(record, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function validDate(value?: string): value is string {
  return Boolean(value && Number.isFinite(new Date(value).getTime()));
}

function dateOrNow(value?: string): string {
  return validDate(value) ? value : new Date().toISOString();
}

function addSeconds(value: string, seconds: number): string {
  return new Date(new Date(value).getTime() + seconds * 1000).toISOString();
}

function normalizeMachine(value?: string): string | undefined {
  const normalized = value?.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  return normalized || undefined;
}

function buildJobKeyFilter(jobKeys: string[]): string | undefined {
  const filters = uniqueStrings(jobKeys)
    .slice(0, MAX_JOB_KEYS_PER_QUERY)
    .map((key) => `JobKey eq ${odataString(key)}`);
  return filters.length ? filters.join(' or ') : undefined;
}

function extractJobKeys(value: unknown): string[] {
  const found: string[] = [];
  const visit = (current: unknown, keyName = '') => {
    if (current == null) return;
    if (typeof current === 'string') {
      if (/job_?key|jobkey/i.test(keyName)) found.push(current);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item) => visit(item, keyName));
      return;
    }
    if (typeof current === 'object') {
      Object.entries(current).forEach(([key, nested]) => visit(nested, key));
    }
  };
  visit(value);
  return uniqueStrings(found);
}

function extractQueueTermsFromLog(log: UiPathRecord): string[] {
  const directTerms = ['QueueItemKey', 'queueItemKey', 'QueueItemId', 'queueItemId', 'Reference', 'reference'].map(
    (field) => stringValue(log, field),
  );
  const message = stringValue(log, 'Message') || '';
  const messageTerms = Array.from(
    message.matchAll(/\b(?:QueueItemKey|QueueItemId|Reference)\s*[:=]\s*["']?([^\s,"']+)/gi),
  ).map((match) => match[1]);
  return uniqueStrings([...directTerms, ...messageTerms]);
}

function windowFromRecord(record: UiPathRecord, startKeys: string[], endKeys: string[]): TimeWindow | undefined {
  const start = stringValueFor(record, startKeys);
  if (!validDate(start)) return undefined;
  return { start, end: dateOrNow(stringValueFor(record, endKeys)) };
}

function createLimits(): TraceLimits {
  const status = (limit: number): LimitStatus => ({ returned: 0, limit, truncated: false });
  return {
    jobs: status(MAX_JOB_CANDIDATES),
    queueItems: status(MAX_QUEUE_CANDIDATES),
    strictLogs: status(MAX_STRICT_LOGS),
    contextLogs: status(MAX_CONTEXT_LOGS),
    processingAttempts: status(MAX_PROCESSING_ATTEMPTS),
  };
}

function updateLimit(status: LimitStatus, records: UiPathRecord[]): void {
  status.returned = Math.max(status.returned, records.length);
  status.truncated ||= records.length >= status.limit;
}

function dedupeRecords(records: UiPathRecord[]): UiPathRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = [
      stringValue(record, 'Id'),
      stringValue(record, 'Key'),
      stringValue(record, 'JobKey'),
      stringValue(record, 'TimeStamp'),
      stringValue(record, 'Message'),
    ]
      .filter(Boolean)
      .join('|');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortByTime(records: UiPathRecord[]): UiPathRecord[] {
  return [...records].sort((left, right) =>
    (stringValue(left, 'TimeStamp') || '').localeCompare(stringValue(right, 'TimeStamp') || ''),
  );
}

function confidenceRank(confidence: CorrelationConfidence): number {
  return confidence === 'high' ? 3 : confidence === 'medium' ? 2 : 1;
}

function mergeCandidates(candidates: CorrelatedRecord[]): CorrelatedRecord[] {
  const byKey = new Map<string, CorrelatedRecord>();
  for (const candidate of candidates) {
    const record = candidate.record;
    const key = stringValue(record, 'Id') || stringValue(record, 'Key') || JSON.stringify(record);
    const existing = byKey.get(key);
    if (!existing || confidenceRank(candidate.confidence) > confidenceRank(existing.confidence))
      byKey.set(key, candidate);
  }
  return [...byKey.values()].sort((left, right) => confidenceRank(right.confidence) - confidenceRank(left.confidence));
}

function queueItemRobotId(record: UiPathRecord): number | undefined {
  return numberValue(asRecord(record.Robot), 'Id') || numberValue(record, 'RobotId');
}

function recordMachine(record: UiPathRecord): string | undefined {
  return normalizeMachine(stringValueFor(record, ['HostMachineName', 'MachineName', 'Machine', 'HostName']));
}

function recordRobotId(record: UiPathRecord): number | undefined {
  return numberValue(record, 'RobotId') || numberValue(asRecord(record.Robot), 'Id');
}

function queueOverlapEvidence(
  queueItem: UiPathRecord,
  robotId?: number,
  machine?: string,
): { confidence: CorrelationConfidence; reason: string } {
  const robotMatches = robotId !== undefined && robotId === queueItemRobotId(queueItem);
  const queueMachine = recordMachine(queueItem);
  const machineMatches = Boolean(machine && queueMachine && machine === queueMachine);
  if (robotMatches && machineMatches) {
    return {
      confidence: 'medium',
      reason: 'Queue processing time overlaps the execution on the same Robot and Machine.',
    };
  }
  if (robotMatches) {
    return { confidence: 'medium', reason: 'Queue processing time overlaps the execution on the same Robot.' };
  }
  if (machineMatches) {
    return { confidence: 'medium', reason: 'Queue processing time overlaps the execution on the same Machine.' };
  }
  return { confidence: 'low', reason: 'Queue processing time overlaps the execution window.' };
}

export class UiPathCorrelationService {
  constructor(
    private readonly client: UiPathClientLike,
    private readonly logger: LoggerLike = {},
  ) {}

  async fromQueueItem(input: FromQueueItemInput) {
    const limits = createLimits();
    const diagnostics: string[] = [];
    const bufferSeconds = input.bufferSeconds ?? DEFAULT_BUFFER_SECONDS;
    const queueItem = asRecord(
      await this.client.get(`/odata/QueueItems(${input.queueItemId})`, {
        query: { $expand: 'Robot' },
        folder: input.folder,
      }),
    );
    if (!Object.keys(queueItem).length) throw new Error('Queue item not found');

    const queueWindow = windowFromRecord(queueItem, ['StartProcessing', 'CreationTime'], ['EndProcessing']);
    const queueTerms = uniqueStrings([stringValue(queueItem, 'Key'), stringValue(queueItem, 'Reference')]);
    const fallbackJobKeys = extractJobKeys(queueItem);
    const historyResult = await this.getProcessingHistory(input.queueItemId, input.folder);
    if (historyResult.error) diagnostics.push(historyResult.error);
    const attempts = historyResult.records
      .map((record) => this.parseProcessingAttempt(record))
      .slice(0, MAX_PROCESSING_ATTEMPTS);
    updateLimit(
      limits.processingAttempts,
      attempts.map((attempt) => attempt.record),
    );

    const candidates: CorrelatedRecord[] = [];
    const attemptedJobIds = uniqueStrings(
      attempts.map((attempt) => (attempt.jobId === undefined ? undefined : String(attempt.jobId))),
    );
    const attemptedJobKeys = uniqueStrings(attempts.map((attempt) => attempt.jobKey));
    const resolvedById = await Promise.all(
      attemptedJobIds.map(async (jobId) => {
        const job = await this.getRecord(`/odata/Jobs(${jobId})`, input.folder);
        return job ? { job, reason: 'Matched Queue Item processing-history Job ID.' } : undefined;
      }),
    );
    resolvedById.filter(Boolean).forEach((match) => {
      if (match) candidates.push({ record: match.job, confidence: 'high', reason: match.reason });
    });

    const historyJobs = await Promise.all(
      attemptedJobKeys.map((jobKey) => this.findJobsByKey(jobKey, input.folder, limits)),
    );
    historyJobs
      .flat()
      .forEach((job) =>
        candidates.push({ record: job, confidence: 'high', reason: 'Matched Queue Item processing-history Job Key.' }),
      );

    const fallbackJobs = await Promise.all(
      fallbackJobKeys.map((jobKey) => this.findJobsByKey(jobKey, input.folder, limits)),
    );
    fallbackJobs
      .flat()
      .forEach((job) =>
        candidates.push({ record: job, confidence: 'high', reason: 'Matched Job Key embedded in the Queue Item.' }),
      );

    const windows = attempts.map((attempt) => attempt.window).filter((window): window is TimeWindow => Boolean(window));
    const fallbackWindows = windows.length ? windows : queueWindow ? [queueWindow] : [];
    const robotId = queueItemRobotId(queueItem);
    const machine = recordMachine(queueItem);
    const overlapJobs = await Promise.all(
      fallbackWindows
        .slice(0, MAX_ATTEMPT_WINDOWS)
        .map((window) =>
          this.findJobsForWindow({ from: window.start, to: window.end, robotId, folder: input.folder, limits }),
        ),
    );
    overlapJobs.flat().forEach((job) => {
      const jobRobotId = numberValue(job, 'RobotId') || numberValue(asRecord(job.Robot), 'Id');
      const jobMachine = recordMachine(job);
      const robotMatches = robotId !== undefined && robotId === jobRobotId;
      const machineMatches = Boolean(machine && jobMachine && machine === jobMachine);
      candidates.push({
        record: job,
        confidence: robotMatches || machineMatches ? 'medium' : 'low',
        reason:
          robotMatches && machineMatches
            ? 'Queue processing window overlaps this job on the same Robot and Machine.'
            : robotMatches
              ? 'Queue processing window overlaps this job on the same Robot.'
              : machineMatches
                ? 'Queue processing window overlaps this job on the same Machine.'
                : 'Queue processing window overlaps this job.',
      });
    });

    const jobs = mergeCandidates(candidates);
    const jobKeys = uniqueStrings([
      ...fallbackJobKeys,
      ...attemptedJobKeys,
      ...jobs.map((candidate) => stringValue(candidate.record, 'Key')),
    ]);
    const strictWindows = fallbackWindows;
    const strictLogs = await this.findLogsForWindows({
      jobKeys,
      queueTerms,
      windows: strictWindows,
      folder: input.folder,
      limit: MAX_STRICT_LOGS,
      limitStatus: limits.strictLogs,
    });
    const contextLogs = await this.findLogsForWindows({
      jobKeys,
      queueTerms,
      windows: strictWindows.map((window) => ({
        start: addSeconds(window.start, -bufferSeconds),
        end: addSeconds(window.end, bufferSeconds),
      })),
      folder: input.folder,
      limit: MAX_CONTEXT_LOGS,
      limitStatus: limits.contextLogs,
    });

    return {
      queueItem,
      job: jobs[0]?.record || null,
      jobs,
      logs: strictLogs,
      contextLogs,
      processingAttempts: attempts,
      processingWindow: queueWindow ? { start: queueWindow.start, end: queueWindow.end, bufferSeconds } : null,
      limits,
      diagnostics,
    };
  }

  async fromLog(input: FromLogInput) {
    const limits = createLimits();
    const diagnostics: string[] = [];
    const bufferSeconds = input.bufferSeconds ?? DEFAULT_BUFFER_SECONDS;
    let log: UiPathRecord = { Id: input.logId, TimeStamp: input.timeStamp, JobKey: input.jobKey };
    if (input.logId && (!input.timeStamp || !input.jobKey)) {
      const resolved = await this.getRecord(`/odata/RobotLogs(${input.logId})`, input.folder);
      if (resolved) log = resolved;
    }

    const timeStamp = stringValue(log, 'TimeStamp') || input.timeStamp;
    const jobKey = stringValue(log, 'JobKey') || input.jobKey;
    if (!timeStamp && !jobKey) throw new Error('logId or jobKey/timeStamp is required for correlation');
    const jobs = jobKey
      ? await this.findJobsByKey(jobKey, input.folder, limits)
      : await this.findJobsForWindow({ from: timeStamp, to: timeStamp, folder: input.folder, limits });
    const primaryJob = jobs[0];
    const runtime = primaryJob ? windowFromRecord(primaryJob, ['StartTime', 'CreationTime'], ['EndTime']) : undefined;
    let queueTerms = uniqueStrings([input.queueItemKey, input.queueReference, ...extractQueueTermsFromLog(log)]);
    if (!queueTerms.length && jobKey && runtime) {
      const jobLogs = await this.findLogsForWindows({
        jobKeys: [jobKey],
        windows: [runtime],
        folder: input.folder,
        limit: MAX_STRICT_LOGS,
        limitStatus: limits.strictLogs,
      });
      queueTerms = uniqueStrings(jobLogs.flatMap(extractQueueTermsFromLog));
    }

    const exactQueueItems = await this.findQueueItemsByIdentity(input.queueItemId, queueTerms, input.folder, limits);
    const fallbackQueueItems = exactQueueItems.length
      ? []
      : runtime
        ? await this.findQueueItemsForWindow(runtime.start, runtime.end, [], input.folder, limits)
        : timeStamp
          ? await this.findQueueItemsForTimestamp(timeStamp, input.folder, limits)
          : [];
    const executionRobotId = primaryJob ? recordRobotId(primaryJob) : recordRobotId(log);
    const executionMachine = primaryJob ? recordMachine(primaryJob) : recordMachine(log);
    const queueItems = (exactQueueItems.length ? exactQueueItems : fallbackQueueItems).map((record) => {
      if (exactQueueItems.length) {
        return {
          record,
          confidence: 'high' as const,
          reason: 'Matched a Queue Item ID, Key, or Reference found in the log.',
        };
      }
      return { record, ...queueOverlapEvidence(record, executionRobotId, executionMachine) };
    });
    const nearbyLogs = timeStamp
      ? await this.findLogsForWindows({
          jobKeys: jobKey ? [jobKey] : [],
          windows: [{ start: addSeconds(timeStamp, -bufferSeconds), end: addSeconds(timeStamp, bufferSeconds) }],
          folder: input.folder,
          limit: MAX_CONTEXT_LOGS,
          limitStatus: limits.contextLogs,
        })
      : [];

    return {
      log,
      job: primaryJob || null,
      jobs: jobs.map((record) => ({
        record,
        confidence: jobKey ? 'high' : 'medium',
        reason: jobKey ? 'Matched by JobKey.' : 'Matched by time overlap.',
      })),
      queueItems,
      nearbyLogs,
      limits,
      diagnostics,
    };
  }

  async fromJob(input: FromJobInput) {
    const limits = createLimits();
    const diagnostics: string[] = [];
    const job = await this.resolveJob(input, limits);
    const jobKey = stringValue(job, 'Key') || input.jobKey;
    const runtime = windowFromRecord(job, ['StartTime', 'CreationTime'], ['EndTime']);
    const logs = runtime
      ? await this.findLogsForWindows({
          jobKeys: jobKey ? [jobKey] : [],
          windows: [runtime],
          folder: input.folder,
          limit: MAX_STRICT_LOGS,
          limitStatus: limits.strictLogs,
        })
      : [];
    const queueTerms = uniqueStrings(logs.flatMap(extractQueueTermsFromLog));
    const exactQueueItems = await this.findQueueItemsByIdentity(undefined, queueTerms, input.folder, limits);
    const overlapQueueItems = runtime
      ? await this.findQueueItemsForWindow(runtime.start, runtime.end, [], input.folder, limits)
      : [];
    const jobRobotId = recordRobotId(job);
    const jobMachine = recordMachine(job);
    const queueCandidates = mergeCandidates([
      ...exactQueueItems.map((record) => ({
        record,
        confidence: 'high' as const,
        reason: 'Matched a Queue Item Key or Reference found in the job logs.',
      })),
      ...overlapQueueItems.map((record) => ({ record, ...queueOverlapEvidence(record, jobRobotId, jobMachine) })),
    ]);

    if (jobKey && runtime) {
      const historyMatches = await Promise.all(
        queueCandidates.slice(0, MAX_ATTEMPT_WINDOWS).map(async (candidate) => {
          const queueId = numberValue(candidate.record, 'Id');
          if (queueId === undefined) return undefined;
          const history = await this.getProcessingHistory(queueId, input.folder);
          if (history.error) diagnostics.push(history.error);
          return history.records.some((record) => this.parseProcessingAttempt(record).jobKey === jobKey)
            ? candidate.record
            : undefined;
        }),
      );
      const confirmedQueueIds = new Set(historyMatches.filter(isRecord).map((record) => stringValue(record, 'Id')));
      queueCandidates.forEach((candidate) => {
        if (confirmedQueueIds.has(stringValue(candidate.record, 'Id'))) {
          candidate.confidence = 'high';
          candidate.reason = 'Matched this Job Key in Queue Item processing history.';
        }
      });
    }

    return {
      job,
      logs,
      queueItems: queueCandidates,
      runtimeWindow: runtime ? { start: runtime.start, end: runtime.end } : null,
      limits,
      diagnostics,
    };
  }

  private parseProcessingAttempt(record: UiPathRecord): ProcessingAttempt {
    return {
      record,
      jobId: numberValueFor(record, ['JobId', 'Job.Id', 'JobExecutionId', 'ExecutionId']),
      jobKey: stringValueFor(record, ['JobKey', 'Job.Key', 'ExecutionKey']),
      robotId: numberValueFor(record, ['RobotId', 'Robot.Id']),
      machine: normalizeMachine(stringValueFor(record, ['MachineName', 'HostMachineName', 'Machine', 'HostName'])),
      window: windowFromRecord(
        record,
        ['StartProcessing', 'StartTime', 'ProcessingStartTime', 'Start'],
        ['EndProcessing', 'EndTime', 'ProcessingEndTime', 'End'],
      ),
    };
  }

  private async getProcessingHistory(queueItemId: string | number, folder?: FolderContext) {
    try {
      return {
        records: asArray(
          await this.client.get(`/odata/QueueItems(${queueItemId})/UiPathODataSvc.GetItemProcessingHistory`, {
            folder,
          }),
        ),
      };
    } catch (error) {
      this.logger.debug?.(`[plugin-uipath] Processing history lookup failed: ${String(error)}`);
      return {
        records: [] as UiPathRecord[],
        error: 'Processing history is unavailable; using queue time and execution identity fallback.',
      };
    }
  }

  private async resolveJob(input: FromJobInput, limits: TraceLimits): Promise<UiPathRecord> {
    if (input.jobId) {
      const job = await this.getRecord(`/odata/Jobs(${input.jobId})`, input.folder);
      if (job) return job;
      throw new Error('Job not found');
    }
    if (!input.jobKey) throw new Error('jobId or jobKey is required for correlation');
    const jobs = await this.findJobsByKey(input.jobKey, input.folder, limits);
    if (!jobs[0]) throw new Error('Job not found');
    return jobs[0];
  }

  private async getRecord(endpoint: string, folder?: FolderContext): Promise<UiPathRecord | undefined> {
    try {
      const record = asRecord(await this.client.get(endpoint, { folder }));
      return Object.keys(record).length ? record : undefined;
    } catch (error) {
      this.logger.debug?.(`[plugin-uipath] Correlation lookup failed for ${endpoint}: ${String(error)}`);
      return undefined;
    }
  }

  private async findJobsByKey(
    jobKey: string,
    folder: FolderContext | undefined,
    limits: TraceLimits,
  ): Promise<UiPathRecord[]> {
    return this.safeList(
      '/odata/Jobs',
      {
        query: { $top: MAX_JOB_CANDIDATES, $filter: `Key eq ${odataString(jobKey)}`, $orderby: 'CreationTime desc' },
        folder,
      },
      limits.jobs,
    );
  }

  private async findJobsForWindow(params: {
    from?: string;
    to?: string;
    robotId?: number;
    folder?: FolderContext;
    limits: TraceLimits;
  }): Promise<UiPathRecord[]> {
    const overlapFilter =
      validDate(params.from) && validDate(params.to)
        ? `StartTime le ${params.to} and (EndTime ge ${params.from} or EndTime eq null)`
        : undefined;
    const robotFilter = params.robotId ? `Robot/Id eq ${params.robotId}` : undefined;
    const filter = combineODataFilters([overlapFilter, robotFilter]);
    if (!filter) return [];
    return this.safeList(
      '/odata/Jobs',
      { query: { $top: MAX_JOB_CANDIDATES, $filter: filter, $orderby: 'StartTime desc' }, folder: params.folder },
      params.limits.jobs,
    );
  }

  private async findQueueItemsForTimestamp(
    timeStamp: string,
    folder: FolderContext | undefined,
    limits: TraceLimits,
  ): Promise<UiPathRecord[]> {
    if (!validDate(timeStamp)) return [];
    return this.safeList(
      '/odata/QueueItems',
      {
        query: {
          $top: MAX_QUEUE_CANDIDATES,
          $filter: `StartProcessing le ${timeStamp} and (EndProcessing ge ${timeStamp} or EndProcessing eq null)`,
          $expand: 'Robot',
          $orderby: 'StartProcessing desc',
        },
        folder,
      },
      limits.queueItems,
    );
  }

  private async findQueueItemsByIdentity(
    queueItemId: string | number | undefined,
    queueTerms: string[],
    folder: FolderContext | undefined,
    limits: TraceLimits,
  ): Promise<UiPathRecord[]> {
    if (queueItemId !== undefined && queueItemId !== null && String(queueItemId).trim()) {
      const item = await this.getRecord(`/odata/QueueItems(${queueItemId})`, folder);
      if (item) return [item];
    }
    const identityFilter = uniqueStrings(queueTerms)
      .map((term) => `(Key eq ${odataString(term)} or Reference eq ${odataString(term)})`)
      .join(' or ');
    if (!identityFilter) return [];
    return this.safeList(
      '/odata/QueueItems',
      {
        query: { $top: MAX_QUEUE_CANDIDATES, $filter: identityFilter, $expand: 'Robot', $orderby: 'CreationTime desc' },
        folder,
      },
      limits.queueItems,
    );
  }

  private async findQueueItemsForWindow(
    from: string,
    to: string,
    queueTerms: string[],
    folder: FolderContext | undefined,
    limits: TraceLimits,
  ): Promise<UiPathRecord[]> {
    if (!validDate(from) || !validDate(to)) return [];
    const overlapFilter = `StartProcessing le ${to} and (EndProcessing ge ${from} or EndProcessing eq null)`;
    const termFilter = queueTerms.length
      ? queueTerms.map((term) => `(Key eq ${odataString(term)} or Reference eq ${odataString(term)})`).join(' or ')
      : undefined;
    return this.safeList(
      '/odata/QueueItems',
      {
        query: {
          $top: MAX_QUEUE_CANDIDATES,
          $filter: combineODataFilters([overlapFilter, termFilter ? `(${termFilter})` : undefined]),
          $expand: 'Robot',
          $orderby: 'StartProcessing desc',
        },
        folder,
      },
      limits.queueItems,
    );
  }

  private async findLogsForWindows(params: {
    jobKeys?: string[];
    queueTerms?: string[];
    windows: TimeWindow[];
    folder?: FolderContext;
    limit: number;
    limitStatus: LimitStatus;
  }): Promise<UiPathRecord[]> {
    const windows = params.windows
      .filter((window) => validDate(window.start) && validDate(window.end))
      .slice(0, MAX_ATTEMPT_WINDOWS);
    if (!windows.length) return [];
    const results = await Promise.all(
      windows.map((window) => this.findLogs({ ...params, range: window, orderby: 'TimeStamp asc' })),
    );
    const records = sortByTime(dedupeRecords(results.flat())).slice(0, params.limit);
    params.limitStatus.returned = Math.max(params.limitStatus.returned, records.length);
    params.limitStatus.truncated ||=
      results.some((result) => result.length >= params.limit) || records.length >= params.limit;
    return records;
  }

  private async findLogs(params: {
    jobKeys?: string[];
    queueTerms?: string[];
    range: TimeWindow;
    folder?: FolderContext;
    limit: number;
    limitStatus: LimitStatus;
    orderby: string;
  }): Promise<UiPathRecord[]> {
    const keyFilter = params.jobKeys?.length ? buildJobKeyFilter(params.jobKeys) : undefined;
    const messageFilter = params.queueTerms?.length
      ? params.queueTerms
          .map((term) => buildContainsFilter('Message', term))
          .filter((filter): filter is string => Boolean(filter))
          .join(' or ')
      : undefined;
    const filter = combineODataFilters([
      keyFilter || messageFilter ? combineODataFilters([keyFilter, messageFilter], 'or') : undefined,
      buildDateRangeFilter('TimeStamp', { from: params.range.start, to: params.range.end }),
    ]);
    if (!filter) return [];
    return this.safeList(
      '/odata/RobotLogs',
      { query: { $top: params.limit, $filter: filter, $orderby: params.orderby }, folder: params.folder },
      params.limitStatus,
    );
  }

  private async safeList(
    endpoint: string,
    options: Record<string, unknown>,
    status: LimitStatus,
  ): Promise<UiPathRecord[]> {
    try {
      const records = asArray(await this.client.get(endpoint, options));
      updateLimit(status, records);
      return records;
    } catch (error) {
      this.logger.warn?.(`[plugin-uipath] Correlation query failed for ${endpoint}: ${String(error)}`);
      return [];
    }
  }
}
