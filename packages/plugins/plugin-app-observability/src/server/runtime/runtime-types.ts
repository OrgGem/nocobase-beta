export interface RuntimeSnapshot {
  rssBytes: number;
  heapTotalBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  cpuPercent: number | null;
  eventLoopUtilization: number | null;
  eventLoopDelayP50Ms: number | null;
  eventLoopDelayP95Ms: number | null;
  eventLoopDelayP99Ms: number | null;
  eventLoopDelayMaxMs: number | null;
  uptimeSeconds: number;
  osTotalMemoryBytes: number;
  osFreeMemoryBytes: number;
  effectiveMemoryLimitBytes: number;
  heapLimitBytes: number;
  loadAverage: number[];
  dbPoolActive: number | null;
  dbPoolIdle: number | null;
  dbPoolWaiting: number | null;
}
