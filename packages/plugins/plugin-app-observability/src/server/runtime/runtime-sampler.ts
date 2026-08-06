import os from 'os';
import { monitorEventLoopDelay, performance } from 'perf_hooks';
import { getHeapStatistics } from 'v8';
import type { RuntimeSnapshot } from './runtime-types';

interface CpuUsage {
  user: number;
  system: number;
}
interface Elu {
  active: number;
  idle: number;
  utilization: number;
}
interface DelaySample {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}
interface DelayMonitor {
  sample(): DelaySample;
  reset(): void;
  stop(): void;
}
export interface RuntimeSamplerDependencies {
  now?: () => number;
  cpuCount?: () => number;
  cpuUsage?: () => CpuUsage;
  memoryUsage?: () => NodeJS.MemoryUsage;
  eventLoopUtilization?: () => Elu;
  eventLoopDelay?: DelayMonitor;
  uptime?: () => number;
  dbPool?: () => { active: number | null; idle: number | null; waiting: number | null };
}
export class RuntimeSampler {
  private previousCpu: CpuUsage | null = null;
  private previousElu: Elu | null = null;
  private previousTimestamp: number | null = null;
  private readonly delay: DelayMonitor;
  constructor(private readonly dependencies: RuntimeSamplerDependencies = {}) {
    this.delay = dependencies.eventLoopDelay ?? createDelayMonitor();
  }
  sample(): RuntimeSnapshot {
    const now = (this.dependencies.now ?? Date.now)();
    const cpu = (this.dependencies.cpuUsage ?? process.cpuUsage)();
    const elu = (this.dependencies.eventLoopUtilization ?? (() => performance.eventLoopUtilization()))();
    const memory = (this.dependencies.memoryUsage ?? process.memoryUsage)();
    const delay = this.delay.sample();
    const pool = this.dependencies.dbPool?.() ?? { active: null, idle: null, waiting: null };
    const elapsedMs = this.previousTimestamp === null ? null : now - this.previousTimestamp;
    const cpuCount = Math.max(1, (this.dependencies.cpuCount ?? (() => os.cpus().length))());
    const cpuPercent =
      elapsedMs && this.previousCpu
        ? round(
            ((cpu.user - this.previousCpu.user + (cpu.system - this.previousCpu.system)) /
              1000 /
              elapsedMs /
              cpuCount) *
              100,
          )
        : null;
    const activeDelta = this.previousElu ? elu.active - this.previousElu.active : 0;
    const idleDelta = this.previousElu ? elu.idle - this.previousElu.idle : 0;
    const eluDelta = this.previousElu ? Math.max(0, activeDelta) / Math.max(1, activeDelta + idleDelta) : null;
    this.previousCpu = cpu;
    this.previousElu = elu;
    this.previousTimestamp = now;
    this.delay.reset();
    return {
      rssBytes: memory.rss,
      heapTotalBytes: memory.heapTotal,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      cpuPercent,
      eventLoopUtilization: eluDelta,
      eventLoopDelayP50Ms: delay.p50,
      eventLoopDelayP95Ms: delay.p95,
      eventLoopDelayP99Ms: delay.p99,
      eventLoopDelayMaxMs: delay.max,
      uptimeSeconds: (this.dependencies.uptime ?? process.uptime)(),
      osTotalMemoryBytes: os.totalmem(),
      osFreeMemoryBytes: os.freemem(),
      effectiveMemoryLimitBytes: effectiveMemoryLimit(),
      heapLimitBytes: getHeapStatistics().heap_size_limit,
      loadAverage: os.loadavg(),
      dbPoolActive: pool.active,
      dbPoolIdle: pool.idle,
      dbPoolWaiting: pool.waiting,
    };
  }
  stop(): void {
    this.delay.stop();
  }
}
function createDelayMonitor(): DelayMonitor {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  return {
    sample: () => ({
      p50: nanosToMs(histogram.percentile(50)),
      p95: nanosToMs(histogram.percentile(95)),
      p99: nanosToMs(histogram.percentile(99)),
      max: nanosToMs(histogram.max),
    }),
    reset: () => histogram.reset(),
    stop: () => histogram.disable(),
  };
}
function nanosToMs(value: number): number {
  return Number.isFinite(value) ? value / 1_000_000 : 0;
}
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
function effectiveMemoryLimit(): number {
  const constrained = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0;
  return constrained && constrained > 0 ? constrained : os.totalmem();
}
