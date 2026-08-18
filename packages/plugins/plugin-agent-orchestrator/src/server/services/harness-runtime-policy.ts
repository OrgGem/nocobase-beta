import type { Database } from '@nocobase/database';
import { compileHarness } from './HarnessCompiler';
import type { CompiledHarness } from './HarnessCompiler';
import { HarnessProfileService } from './HarnessProfileService';
import { parseHarnessSettings } from './HarnessSchema';

export type TraceLike = {
  agentLoopRunId?: string | number;
  employeeUsername?: string;
};

function read(record: unknown, key: string) {
  const model = record as { get?: (name: string) => unknown } | null;
  return typeof model?.get === 'function' ? model.get(key) : (model as Record<string, unknown> | null)?.[key];
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// Run snapshots were compiled at enqueue time, possibly by an older schema revision. Re-parsing
// through the current schema backfills new policy fields with their defaults. `sources` is a
// compiler artifact the strict schema rejects, so it is stripped first.
function compiledFromSnapshot(snapshot: unknown): CompiledHarness | null {
  const effective = asObject(asObject(snapshot).effective);
  if (!effective.tools) return null;
  const { sources: _sources, ...settings } = effective;
  return compileHarness([{ source: 'run-snapshot', settings: parseHarnessSettings(settings) }]);
}

function snapshotForEmployee(run: Record<string, unknown>, username: string | undefined) {
  const bindings = asObject(run.roleBindingsSnapshot);
  if (!username) return null;
  if (bindings.leader === username) return run.leaderHarnessSnapshot;
  if (bindings.verifier === username) return run.verifierHarnessSnapshot;
  const makers = asObject(run.makerHarnessSnapshot);
  return makers[username] ?? null;
}

// Resolves the compiled harness of one role inside a loop run, or null when the run or the role's
// snapshot is unavailable. Loop snapshots are immutable and authoritative for everything the run
// delegates, so callers outside the run (sub-agent inheritance, skill enforcement) resolve through
// this instead of re-deriving policy.
export async function resolveRunRoleHarness(
  database: Database,
  runId: number,
  username: string | undefined,
): Promise<CompiledHarness | null> {
  if (!Number.isSafeInteger(runId) || runId <= 0 || !username) return null;
  const run = await database.getRepository('agentLoopRuns').findOne({ filterByTk: runId });
  if (!run) return null;
  const snapshot = snapshotForEmployee(asObject((run as { toJSON?: () => unknown }).toJSON?.() ?? run), username);
  return compiledFromSnapshot(snapshot);
}

// Resolves the compiled harness governing a tool call. Loop runs carry an immutable snapshot per
// role, which is authoritative; anything outside a loop run falls back to the employee's
// harness-tag profile. Returns null when no policy applies (enforcement points then keep their
// existing behavior).
export async function resolveTraceHarness(database: Database, trace: TraceLike): Promise<CompiledHarness | null> {
  const runHarness = await resolveRunRoleHarness(database, Number(trace.agentLoopRunId), trace.employeeUsername);
  if (runHarness) return runHarness;
  if (!trace.employeeUsername) return null;

  const employee = await database.getRepository('aiEmployees').findOne({
    filter: { username: trace.employeeUsername },
  });
  if (!employee) return null;
  const settings = asObject(read(employee, 'skillSettings'));
  const tag =
    typeof settings.harnessTag === 'string' && settings.harnessTag.trim() ? settings.harnessTag.trim() : 'default';

  const profiles = new HarnessProfileService(database);
  const version =
    (await profiles.getPublishedByTag(tag)) || (tag !== 'default' ? await profiles.getPublishedByTag('default') : null);
  if (!version) return null;
  return compileHarness([{ source: `profile:${tag}`, settings: version.settings }]);
}

export function harnessTimeoutMs(harness: CompiledHarness, toolName: string): number | null {
  const timeouts = harness.tools.timeouts;
  const direct = timeouts[toolName];
  if (typeof direct === 'number' && direct > 0) return direct;
  const generic = timeouts['skill_hub_execute'];
  return typeof generic === 'number' && generic > 0 ? generic : null;
}

const SECRET_KEY_PATTERN = /(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)/i;
export const REDACTED_PLACEHOLDER = '[REDACTED]';

// Key-name scrubbing for persisted telemetry: any value whose key looks secret-bearing is
// replaced wholesale. Free text is deliberately left alone — pattern-matching arbitrary output
// produces false negatives that only look like safety.
export function redactSecretsIn<T>(value: T): T {
  const scrub = (input: unknown, depth: number): unknown => {
    if (depth > 8 || input === null || input === undefined) return input;
    if (Array.isArray(input)) return input.map((item) => scrub(item, depth + 1));
    if (typeof input === 'object') {
      const source = input as Record<string, unknown>;
      const output: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(source)) {
        output[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED_PLACEHOLDER : scrub(entry, depth + 1);
      }
      return output;
    }
    return input;
  };
  return scrub(value, 0) as T;
}

// Byte-safe slice that never splits a multi-byte character: the cut point advances past any
// continuation bytes (10xxxxxx) left dangling at the boundary.
function sliceBytes(buffer: Buffer, start: number, end: number) {
  let from = Math.max(0, start);
  while (from < end && (buffer[from] & 0xc0) === 0x80) from += 1;
  return buffer.subarray(from, Math.min(buffer.length, end));
}

// Builds the model-facing replacement for an oversized output: head/tail preview plus a locator
// supplied by the caller (download URL for skill output, file path for sub-agent results).
// Returns null when the text already fits the inline budget. Mirrors the dsh spill policy.
export function spilledText(text: string, maxInlineBytes: number, locator: string): string | null {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxInlineBytes) return null;

  const headTarget = Math.floor(maxInlineBytes * 0.6);
  const tailTarget = Math.floor(maxInlineBytes * 0.2);
  let head = sliceBytes(buffer, 0, headTarget).toString('utf8');
  let tail = sliceBytes(buffer, buffer.byteLength - tailTarget, buffer.byteLength).toString('utf8');
  const notice = () =>
    `\n\n... (${
      buffer.byteLength - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8')
    } bytes omitted. Full output stored at: ${locator}) ...`;
  while (Buffer.byteLength(head + notice() + tail, 'utf8') > maxInlineBytes && head.length + tail.length > 0) {
    head = head.slice(0, Math.floor(head.length * 0.9));
    // Keep the true end of the output: shrinking from the front preserves the final lines.
    const keepTail = Math.floor(tail.length * 0.9);
    tail = keepTail > 0 ? tail.slice(-keepTail) : '';
  }
  return `${head}${notice()}${tail}`;
}
