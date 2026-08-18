import type { Database, Model } from '@nocobase/database';
import type { CompiledHarness } from './HarnessCompiler';
import type { LoopPatternPolicy } from './LoopPatternSchema';
import type { LoopRunStateMachine } from './LoopRunStateMachine';
import type { PluginAiRuntimeAdapter } from './PluginAiRuntimeAdapter';
import { ToolLoopDetectionService, toolLoopReason } from './ToolLoopDetectionService';
import { parseVerificationVerdict } from './VerificationSchema';
import type { VerificationVerdict } from './VerificationSchema';

export type VerificationRequest = {
  runId: number;
  goal: string;
  autonomyLevel: 'L1' | 'L2' | 'L3';
  verifierUsername: string;
  leaderUsername: string;
  makerUsernames: string[];
  verifierHarness: CompiledHarness;
  policy: LoopPatternPolicy;
  makerSummary: string;
  userId?: number;
  workerId: string;
  leaseToken: string;
  loopNotices?: string[];
  signal: AbortSignal;
};

export type VerificationOutcome = {
  verdict: VerificationVerdict;
  finalStatus: 'succeeded' | 'waiting_human' | 'failed' | 'halted';
};

function read(record: Model | Record<string, unknown>, key: string) {
  const model = record as Model & { get?: (name: string) => unknown };
  return typeof model.get === 'function' ? model.get(key) : (record as Record<string, unknown>)[key];
}

// The verifier answers in prose around its JSON verdict, so the object is located rather than
// assumed to be the whole response.
function extractVerdictObject(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : content;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('The verifier did not return a structured verdict object.');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function verifierPrompt(input: VerificationRequest, artifacts: Array<Record<string, unknown>>) {
  const catalogue = artifacts.length
    ? artifacts.map((artifact) => `- id=${artifact.id} kind=${artifact.kind} title=${artifact.title || ''}`).join('\n')
    : '- (none)';
  return [
    'You are the independent verifier for an autonomous run. You did not produce this work.',
    `Goal: ${input.goal}`,
    '',
    'Reported result:',
    input.makerSummary || '(the maker produced no textual summary)',
    '',
    'Evidence artifacts recorded for this run:',
    catalogue,
    '',
    `Required checks: ${input.policy.verification.requiredChecks.join(', ')}`,
    '',
    ...(input.loopNotices ?? []),
    'Reply with a single JSON object and nothing else:',
    '{"verdict":"pass|reject|escalate","summary":"...","checks":[{"name":"...","status":"pass|fail|skipped",',
    '"evidenceArtifactIds":[<artifact ids from the list above>]}],"residualRisks":["..."]}',
    'Every check you mark "pass" must cite at least one artifact id from the list above.',
    'If the evidence does not support the goal, answer "reject". Never invent artifact ids.',
  ].join('\n');
}

export class VerificationService {
  private readonly loopGuard: ToolLoopDetectionService;

  constructor(
    private readonly database: Database,
    private readonly runtime: PluginAiRuntimeAdapter,
    private readonly stateMachine: LoopRunStateMachine,
  ) {
    this.loopGuard = new ToolLoopDetectionService(database);
  }

  async verifyAndFinalize(input: VerificationRequest): Promise<VerificationOutcome> {
    this.assertIndependentVerifier(input);
    const artifacts = await this.runArtifacts(input.runId);
    const verdict = await this.collectVerdict(input, artifacts);

    // The guard also sees the verifier's own tool calls: a verifier retrying the same evidence
    // lookup over and over is the same behavioral failure as a maker looping on its tools.
    const guard = await this.enforceToolLoopGuard(input);
    if (guard === 'halt') {
      return { verdict, finalStatus: 'halted' };
    }

    await this.assertEvidenceBelongsToRun(verdict, artifacts, input.verifierUsername);

    const finalStatus = this.finalStatusFor(verdict, input.autonomyLevel);
    await this.stateMachine.transition({
      runId: input.runId,
      to: finalStatus,
      actorType: 'worker',
      actorIdentity: input.workerId,
      leaseToken: input.leaseToken,
      eventType: 'run_verified',
      title: `Verifier returned ${verdict.verdict}`,
      content: verdict.summary,
      correlationKey: `verified:${input.runId}:${verdict.verdict}`,
      values: {
        verifierVerdict: verdict.verdict,
        verifierEvidence: verdict,
        summary: verdict.summary,
      },
    });
    return { verdict, finalStatus };
  }

  private assertIndependentVerifier(input: VerificationRequest) {
    const verifier = input.verifierUsername.trim();
    if (!verifier) throw new Error('The run snapshot does not name a verifier.');
    if (verifier === input.leaderUsername || input.makerUsernames.includes(verifier)) {
      throw new Error('The verifier must be a different employee from the leader and every maker.');
    }
  }

  private async enforceToolLoopGuard(input: VerificationRequest): Promise<'continue' | 'halt'> {
    const finding = await this.loopGuard.scanRun(input.runId, input.policy);
    if (!finding) return 'continue';

    await this.loopGuard.recordFinding(
      {
        runId: input.runId,
        role: 'verifier',
        username: input.verifierUsername,
        runStatus: 'verifying',
        actorType: 'worker',
        actorIdentity: input.workerId,
      },
      finding,
    );
    if (finding.level === 'warn') return 'continue';

    const reason = toolLoopReason(finding);
    await this.stateMachine.transition({
      runId: input.runId,
      to: finding.level === 'block' ? 'blocked' : 'waiting_human',
      actorType: 'worker',
      actorIdentity: input.workerId,
      leaseToken: input.leaseToken,
      eventType: finding.level === 'block' ? 'run_blocked' : 'run_escalated',
      title: finding.level === 'block' ? 'Run blocked by tool loop detection' : 'Run escalated by tool loop detection',
      content: reason,
      correlationKey: `tool-loop-${finding.level}:${input.runId}:${finding.signature}`,
      values: finding.level === 'block' ? { blockedReason: reason } : { escalationReason: reason },
    });
    return 'halt';
  }

  private async nextSequence(runId: number) {
    const steps = await this.database.getRepository('agentLoopSteps').find({ filter: { runId } });
    return steps.length;
  }

  private async collectVerdict(input: VerificationRequest, artifacts: Array<Record<string, unknown>>) {
    const sessionId = await this.runtime.createConversation({
      username: input.verifierUsername,
      userId: input.userId,
      runId: input.runId,
      title: `Verification of run ${input.runId}`,
    });
    // Recording the session on a step row is what lets the tool loop guard include the verifier's
    // own tool calls in its run-level scan.
    const step = await this.database.getRepository('agentLoopSteps').create({
      values: {
        runId: input.runId,
        runtimeVersion: 'control-plane-v2',
        sequence: await this.nextSequence(input.runId),
        role: 'verifier',
        kind: 'invocation',
        type: 'verification',
        employeeUsername: input.verifierUsername,
        sessionId,
        title: 'verifier invocation',
        status: 'running',
        startedAt: new Date(),
        createdAt: new Date(),
      },
    });
    const outcome = await this.runtime.invoke({
      username: input.verifierUsername,
      sessionId,
      userId: input.userId,
      systemMessage:
        'You verify completed work against its stated goal using only recorded evidence. You never modify anything.',
      harness: input.verifierHarness,
      prompt: verifierPrompt(input, artifacts),
      signal: input.signal,
    });
    await this.database.getRepository('agentLoopSteps').update({
      filterByTk: read(step, 'id'),
      values: {
        status: 'succeeded',
        output: { content: outcome.content },
        endedAt: new Date(),
      },
    });
    // A verifier that stops to ask for approval cannot produce a trustworthy verdict, and its
    // interrupted tool call would otherwise be silently dropped.
    if (outcome.interrupted.length) {
      throw new Error('The verifier requested an approval-gated tool; verification cannot complete.');
    }
    const verdict = parseVerificationVerdict(extractVerdictObject(outcome.content));
    const required = new Set(input.policy.verification.requiredChecks);
    for (const check of verdict.checks) required.delete(check.name);
    if (required.size) {
      throw new Error(`The verifier omitted required checks: ${Array.from(required).join(', ')}.`);
    }
    return verdict;
  }

  private async assertEvidenceBelongsToRun(
    verdict: VerificationVerdict,
    artifacts: Array<Record<string, unknown>>,
    verifierUsername: string,
  ) {
    const owned = new Map(artifacts.map((artifact) => [Number(artifact.id), artifact]));
    for (const check of verdict.checks) {
      for (const artifactId of check.evidenceArtifactIds) {
        const artifact = owned.get(artifactId);
        if (!artifact) {
          throw new Error(`Evidence artifact ${artifactId} does not belong to this run.`);
        }
        if (String(artifact.producerUsername || '') === verifierUsername) {
          throw new Error(`Evidence artifact ${artifactId} was produced by the verifier itself.`);
        }
      }
    }
  }

  private finalStatusFor(verdict: VerificationVerdict, autonomyLevel: 'L1' | 'L2' | 'L3') {
    if (verdict.verdict !== 'pass') {
      return verdict.verdict === 'escalate' ? ('waiting_human' as const) : ('failed' as const);
    }
    const passesEveryCheck = verdict.checks.every(
      (check) => check.status === 'pass' && check.evidenceArtifactIds.length > 0,
    );
    if (!passesEveryCheck) return 'failed' as const;
    // L1 only ever reports, so a passing verdict is final. Anything that touched a repository
    // still needs a human to accept the change.
    return autonomyLevel === 'L1' ? ('succeeded' as const) : ('waiting_human' as const);
  }

  private async runArtifacts(runId: number) {
    const rows = await this.database.getRepository('agentLoopArtifacts').find({ filter: { runId } });
    return rows.map((row) => ({
      id: Number(read(row, 'id')),
      kind: String(read(row, 'kind') || ''),
      title: String(read(row, 'title') || ''),
      producerUsername: String(read(row, 'producerUsername') || ''),
    }));
  }
}
