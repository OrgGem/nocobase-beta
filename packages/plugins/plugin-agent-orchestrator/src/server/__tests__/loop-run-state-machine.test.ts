import { describe, expect, it } from 'vitest';
import { assertRunTransition } from '../services/LoopRunStateMachine';

const passingEvidence = {
  verdict: 'pass',
  summary: 'All required checks passed.',
  checks: [{ name: 'tests', status: 'pass', evidenceArtifactIds: [1] }],
  residualRisks: [],
};

describe('LoopRunStateMachine transition guard', () => {
  it('accepts the normal queued-to-verification lifecycle', () => {
    expect(() =>
      assertRunTransition({ from: 'queued', to: 'preparing', runtimeVersion: 'control-plane-v2' }),
    ).not.toThrow();
    expect(() =>
      assertRunTransition({ from: 'preparing', to: 'running', runtimeVersion: 'control-plane-v2' }),
    ).not.toThrow();
    expect(() =>
      assertRunTransition({ from: 'running', to: 'verifying', runtimeVersion: 'control-plane-v2' }),
    ).not.toThrow();
    expect(() =>
      assertRunTransition({
        from: 'verifying',
        to: 'succeeded',
        runtimeVersion: 'control-plane-v2',
        verifierEvidence: passingEvidence,
      }),
    ).not.toThrow();
  });

  it('rejects illegal transitions and mutations of historical runs', () => {
    expect(() => assertRunTransition({ from: 'queued', to: 'succeeded', verifierEvidence: passingEvidence })).toThrow(
      'Illegal',
    );
    expect(() => assertRunTransition({ from: 'running', to: 'verifying', runtimeVersion: 'legacy-plan-v1' })).toThrow(
      'read-only',
    );
  });

  it('cannot succeed without a structured passing verifier verdict', () => {
    expect(() => assertRunTransition({ from: 'verifying', to: 'succeeded' })).toThrow('verifier verdict');
    expect(() =>
      assertRunTransition({
        from: 'verifying',
        to: 'succeeded',
        verifierEvidence: {
          ...passingEvidence,
          verdict: 'reject',
          checks: [{ name: 'tests', status: 'fail', evidenceArtifactIds: [1] }],
        },
      }),
    ).toThrow('verifier verdict');
    expect(() =>
      assertRunTransition({
        from: 'verifying',
        to: 'succeeded',
        verifierEvidence: { verdict: 'pass', summary: 'Missing checks', checks: [], residualRisks: [] },
      }),
    ).toThrow('verifier verdict');
  });

  it('accepts a pause from every active execution status', () => {
    // The resource transitions to `paused` before it aborts the run. A missing edge here does not
    // just reject the pause: `abortRunEverywhere()` is never reached, so the in-flight verifier
    // keeps calling tools after the operator pressed Pause.
    for (const from of ['preparing', 'running', 'verifying'] as const) {
      expect(() => assertRunTransition({ from, to: 'paused', runtimeVersion: 'control-plane-v2' })).not.toThrow();
      expect(() => assertRunTransition({ from: 'paused', to: from, runtimeVersion: 'control-plane-v2' })).not.toThrow();
    }
  });

  it('requires explicit human acceptance after the human review gate', () => {
    expect(() =>
      assertRunTransition({
        from: 'waiting_human',
        to: 'succeeded',
        verifierEvidence: passingEvidence,
      }),
    ).toThrow('Human acceptance');
    expect(() =>
      assertRunTransition({
        from: 'waiting_human',
        to: 'succeeded',
        verifierEvidence: passingEvidence,
        humanAccepted: true,
      }),
    ).not.toThrow();
  });

  it('allows a behavioral guard to escalate straight from the active statuses', () => {
    // Tool loop detection escalates an in-flight run to a human; routing it through `blocked`
    // first would mislabel the run as mechanically retryable.
    for (const from of ['running', 'verifying'] as const) {
      expect(() =>
        assertRunTransition({ from, to: 'waiting_human', runtimeVersion: 'control-plane-v2' }),
      ).not.toThrow();
      expect(() => assertRunTransition({ from, to: 'blocked', runtimeVersion: 'control-plane-v2' })).not.toThrow();
    }
  });
});
