import type { Database, Model } from '@nocobase/database';
import type { CompiledHarness } from './HarnessCompiler';
import type { LoopPatternPolicy } from './LoopPatternSchema';
import type { LoopRunStateMachine } from './LoopRunStateMachine';
import type { PluginAiRuntimeAdapter } from './PluginAiRuntimeAdapter';
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
  signal: AbortSignal;
};

export type VerificationOutcome = {
  verdict: VerificationVerdict;
  finalStatus: 'succeeded' | 'waiting_human' | 'failed';
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
    'Reply with a single JSON object and nothing else:',
    '{"verdict":"pass|reject|escalate","summary":"...","checks":[{"name":"...","status":"pass|fail|skipped",',
    '"evidenceArtifactIds":[<artifact ids from the list above>]}],"residualRisks":["..."]}',
    'Every check you mark "pass" must cite at least one artifact id from the list above.',
    'If the evidence does not support the goal, answer "reject". Never invent artifact ids.',
  ].join('\n');
}

export class VerificationService {
  constructor(
    private readonly database: Database,
    private readonly runtime: PluginAiRuntimeAdapter,
    private readonly stateMachine: LoopRunStateMachine,
  ) {}

  async verifyAndFinalize(input: VerificationRequest): Promise<VerificationOutcome> {
    this.assertIndependentVerifier(input);
    const artifacts = await this.runArtifacts(input.runId);
    const verdict = await this.collectVerdict(input, artifacts);
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

  private async collectVerdict(input: VerificationRequest, artifacts: Array<Record<string, unknown>>) {
    const sessionId = await this.runtime.createConversation({
      username: input.verifierUsername,
      userId: input.userId,
      runId: input.runId,
      title: `Verification of run ${input.runId}`,
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
