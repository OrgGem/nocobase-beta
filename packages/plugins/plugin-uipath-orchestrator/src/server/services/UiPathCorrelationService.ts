import type { FolderContext } from './types';
import {
  buildContainsFilter,
  buildDateRangeFilter,
  combineODataFilters,
  odataString,
  uniqueStrings,
} from '../utils/odata';

type UiPathClientLike = {
  get<T = Record<string, unknown>>(endpoint: string, options?: Record<string, unknown>): Promise<T>;
};

type LoggerLike = {
  warn?: (message: string) => void;
  debug?: (message: string) => void;
};

export type CorrelationConfidence = 'high' | 'medium' | 'low';

export interface CorrelatedRecord<T extends Record<string, unknown> = Record<string, unknown>> {
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
}

interface FromQueueItemInput extends CorrelationInput {
  queueItemId: string | number;
}

interface FromJobInput extends CorrelationInput {
  jobId?: string | number;
  jobKey?: string;
}

const DEFAULT_BUFFER_SECONDS = 30;
const DEFAULT_LOG_TOP = 200;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  const body = asRecord(value);
  if (Array.isArray(body.value)) {
    return body.value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
  }

  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : [];
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value ? value : undefined;
}

function numberValue(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function dateOrNow(value?: string): string {
  return value || new Date().toISOString();
}

function addSeconds(value: string, seconds: number): string {
  return new Date(new Date(value).getTime() + seconds * 1000).toISOString();
}

function buildJobKeyFilter(jobKeys: string[]): string | undefined {
  const filters = uniqueStrings(jobKeys).map((key) => `JobKey eq ${odataString(key)}`);
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
      for (const [key, nested] of Object.entries(current)) {
        visit(nested, key);
      }
    }
  };

  visit(value);
  return uniqueStrings(found);
}

function withConfidence<T extends Record<string, unknown>>(
  record: T,
  confidence: CorrelationConfidence,
  reason: string,
): CorrelatedRecord<T> {
  return { record, confidence, reason };
}

export class UiPathCorrelationService {
  constructor(
    private readonly client: UiPathClientLike,
    private readonly logger: LoggerLike = {},
  ) {}

  async fromQueueItem(input: FromQueueItemInput) {
    const bufferSeconds = input.bufferSeconds ?? DEFAULT_BUFFER_SECONDS;
    const queueItem = asRecord(
      await this.client.get(`/odata/QueueItems(${input.queueItemId})`, {
        query: { $expand: 'Robot' },
        folder: input.folder,
      }),
    );

    if (!Object.keys(queueItem).length) {
      throw new Error('Queue item not found');
    }

    const startProcessing = stringValue(queueItem, 'StartProcessing') || stringValue(queueItem, 'CreationTime');
    const endProcessing = dateOrNow(stringValue(queueItem, 'EndProcessing'));
    const queueTerms = uniqueStrings([stringValue(queueItem, 'Key'), stringValue(queueItem, 'Reference')]);
    const jobKeys = extractJobKeys(queueItem);
    const robot = asRecord(queueItem.Robot);
    const robotId = numberValue(robot, 'Id') || numberValue(queueItem, 'RobotId');

    const jobs = startProcessing
      ? await this.findJobsForWindow({
          from: startProcessing,
          to: endProcessing,
          robotId,
          jobKeys,
          folder: input.folder,
        })
      : [];
    const correlatedJobs = jobs.map((job) =>
      withConfidence(
        job,
        jobKeys.includes(stringValue(job, 'Key') || '') ? 'high' : robotId ? 'medium' : 'low',
        'Queue processing time overlaps this job.',
      ),
    );
    const primaryJobKeys = uniqueStrings([...jobKeys, ...jobs.map((job) => stringValue(job, 'Key'))]);

    const strictRange = startProcessing ? { from: startProcessing, to: endProcessing } : undefined;
    const bufferedRange = startProcessing
      ? { from: addSeconds(startProcessing, -bufferSeconds), to: addSeconds(endProcessing, bufferSeconds) }
      : undefined;

    const logs = strictRange
      ? await this.findLogs({
          jobKeys: primaryJobKeys,
          queueTerms,
          range: strictRange,
          folder: input.folder,
          orderby: 'TimeStamp asc',
        })
      : [];
    const contextLogs = bufferedRange
      ? await this.findLogs({
          jobKeys: primaryJobKeys,
          queueTerms,
          range: bufferedRange,
          folder: input.folder,
          orderby: 'TimeStamp asc',
        })
      : logs;

    return {
      queueItem,
      job: correlatedJobs[0]?.record || null,
      jobs: correlatedJobs,
      logs,
      contextLogs,
      processingWindow: startProcessing ? { start: startProcessing, end: endProcessing, bufferSeconds } : null,
    };
  }

  async fromLog(input: FromLogInput) {
    const bufferSeconds = input.bufferSeconds ?? DEFAULT_BUFFER_SECONDS;
    let log: Record<string, unknown> = {
      Id: input.logId,
      TimeStamp: input.timeStamp,
      JobKey: input.jobKey,
    };

    if (input.logId && (!input.timeStamp || !input.jobKey)) {
      log = asRecord(await this.client.get(`/odata/RobotLogs(${input.logId})`, { folder: input.folder }));
    }

    const timeStamp = stringValue(log, 'TimeStamp') || input.timeStamp;
    const jobKey = stringValue(log, 'JobKey') || input.jobKey;
    if (!timeStamp && !jobKey) {
      throw new Error('logId or jobKey/timeStamp is required for correlation');
    }

    const jobs = jobKey
      ? await this.findJobsByKey(jobKey, input.folder)
      : await this.findJobsForWindow({ from: timeStamp, to: timeStamp, folder: input.folder });
    const queueItems = timeStamp ? await this.findQueueItemsForTimestamp(timeStamp, input.folder) : [];
    const nearbyLogs = timeStamp
      ? await this.findLogs({
          jobKeys: jobKey ? [jobKey] : [],
          range: { from: addSeconds(timeStamp, -bufferSeconds), to: addSeconds(timeStamp, bufferSeconds) },
          folder: input.folder,
          orderby: 'TimeStamp asc',
        })
      : [];

    return {
      log,
      job: jobs[0] || null,
      jobs: jobs.map((job) =>
        withConfidence(job, jobKey ? 'high' : 'medium', jobKey ? 'Matched by JobKey.' : 'Matched by time overlap.'),
      ),
      queueItems: queueItems.map((item) =>
        withConfidence(item, 'medium', 'Log timestamp is inside the queue item processing window.'),
      ),
      nearbyLogs,
    };
  }

  async fromJob(input: FromJobInput) {
    const job = await this.resolveJob(input);
    const jobKey = stringValue(job, 'Key') || input.jobKey;
    const startTime = stringValue(job, 'StartTime') || stringValue(job, 'CreationTime');
    const endTime = dateOrNow(stringValue(job, 'EndTime'));
    const range = startTime ? { from: startTime, to: endTime } : undefined;

    const logs = await this.findLogs({
      jobKeys: jobKey ? [jobKey] : [],
      range,
      folder: input.folder,
      orderby: 'TimeStamp asc',
    });
    const queueTerms = uniqueStrings(logs.flatMap((row) => extractQueueTermsFromLog(row)));
    const queueItems = range ? await this.findQueueItemsForWindow(range.from, range.to, queueTerms, input.folder) : [];

    return {
      job,
      logs,
      queueItems: queueItems.map((item) =>
        withConfidence(
          item,
          queueTerms.some((term) => term === stringValue(item, 'Key') || term === stringValue(item, 'Reference'))
            ? 'high'
            : 'medium',
          'Queue item overlaps the job runtime or was referenced in job logs.',
        ),
      ),
      runtimeWindow: range ? { start: range.from, end: range.to } : null,
    };
  }

  private async resolveJob(input: FromJobInput): Promise<Record<string, unknown>> {
    if (input.jobId) {
      return asRecord(await this.client.get(`/odata/Jobs(${input.jobId})`, { folder: input.folder }));
    }

    if (!input.jobKey) {
      throw new Error('jobId or jobKey is required for correlation');
    }

    const jobs = await this.findJobsByKey(input.jobKey, input.folder);
    if (!jobs[0]) {
      throw new Error('Job not found');
    }
    return jobs[0];
  }

  private async findJobsByKey(jobKey: string, folder?: FolderContext): Promise<Array<Record<string, unknown>>> {
    return this.safeList('/odata/Jobs', {
      query: {
        $top: 10,
        $filter: `Key eq ${odataString(jobKey)}`,
        $orderby: 'CreationTime desc',
      },
      folder,
    });
  }

  private async findJobsForWindow(params: {
    from?: string;
    to?: string;
    robotId?: number;
    jobKeys?: string[];
    folder?: FolderContext;
  }): Promise<Array<Record<string, unknown>>> {
    const overlapFilter =
      params.from && params.to
        ? `StartTime le ${params.to} and (EndTime ge ${params.from} or EndTime eq null)`
        : undefined;
    const jobKeyFilter = params.jobKeys?.length
      ? params.jobKeys.map((key) => `Key eq ${odataString(key)}`).join(' or ')
      : undefined;
    const robotFilter = params.robotId ? `Robot/Id eq ${params.robotId}` : undefined;
    const filter = combineODataFilters([jobKeyFilter ? `(${jobKeyFilter})` : undefined, overlapFilter, robotFilter]);

    if (!filter) {
      return [];
    }

    return this.safeList('/odata/Jobs', {
      query: { $top: 10, $filter: filter, $orderby: 'StartTime desc' },
      folder: params.folder,
    });
  }

  private async findQueueItemsForTimestamp(
    timeStamp: string,
    folder?: FolderContext,
  ): Promise<Array<Record<string, unknown>>> {
    return this.safeList('/odata/QueueItems', {
      query: {
        $top: 20,
        $filter: `StartProcessing le ${timeStamp} and (EndProcessing ge ${timeStamp} or EndProcessing eq null)`,
        $expand: 'Robot',
        $orderby: 'StartProcessing desc',
      },
      folder,
    });
  }

  private async findQueueItemsForWindow(
    from: string,
    to: string,
    queueTerms: string[],
    folder?: FolderContext,
  ): Promise<Array<Record<string, unknown>>> {
    const overlapFilter = `StartProcessing le ${to} and (EndProcessing ge ${from} or EndProcessing eq null)`;
    const termFilter = queueTerms.length
      ? queueTerms
          .map((term) => `Key eq ${odataString(term)} or Reference eq ${odataString(term)}`)
          .map((filter) => `(${filter})`)
          .join(' or ')
      : undefined;

    return this.safeList('/odata/QueueItems', {
      query: {
        $top: 50,
        $filter: combineODataFilters([overlapFilter, termFilter ? `(${termFilter})` : undefined]),
        $expand: 'Robot',
        $orderby: 'StartProcessing desc',
      },
      folder,
    });
  }

  private async findLogs(params: {
    jobKeys?: string[];
    queueTerms?: string[];
    range?: { from?: string; to?: string };
    folder?: FolderContext;
    orderby?: string;
  }): Promise<Array<Record<string, unknown>>> {
    const keyFilter = params.jobKeys?.length ? buildJobKeyFilter(params.jobKeys) : undefined;
    const messageFilter = params.queueTerms?.length
      ? params.queueTerms
          .map((term) => buildContainsFilter('Message', term))
          .filter((filter): filter is string => Boolean(filter))
          .join(' or ')
      : undefined;
    const filter = combineODataFilters([
      keyFilter || messageFilter ? combineODataFilters([keyFilter, messageFilter], 'or') : undefined,
      params.range ? buildDateRangeFilter('TimeStamp', params.range) : undefined,
    ]);

    if (!filter) {
      return [];
    }

    return this.safeList('/odata/RobotLogs', {
      query: {
        $top: DEFAULT_LOG_TOP,
        $filter: filter,
        $orderby: params.orderby || 'TimeStamp desc',
      },
      folder: params.folder,
    });
  }

  private async safeList(endpoint: string, options: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
    try {
      return asArray(await this.client.get(endpoint, options));
    } catch (error) {
      this.logger.warn?.(`[plugin-uipath] Correlation query failed for ${endpoint}: ${String(error)}`);
      return [];
    }
  }
}

function extractQueueTermsFromLog(log: Record<string, unknown>): string[] {
  const fields = ['QueueItemKey', 'queueItemKey', 'QueueItemId', 'queueItemId', 'Reference', 'reference'];
  const directTerms = fields.map((field) => stringValue(log, field));
  const message = stringValue(log, 'Message') || '';
  const messageTerms = Array.from(
    message.matchAll(/\b(?:QueueItemKey|QueueItemId|Reference)\s*[:=]\s*([A-Za-z0-9_.-]+)/gi),
  ).map((match) => match[1]);

  return uniqueStrings([...directTerms, ...messageTerms]);
}
