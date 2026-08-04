import { z } from 'zod';

export const verificationVerdictSchema = z.object({
  verdict: z.enum(['pass', 'reject', 'escalate']),
  summary: z.string().min(1),
  checks: z
    .array(
      z.object({
        name: z.string().min(1),
        status: z.enum(['pass', 'fail', 'skipped']),
        evidenceArtifactIds: z.array(z.number().int().positive()).default([]),
      }),
    )
    .min(1),
  residualRisks: z.array(z.string()).default([]),
});

export type VerificationVerdict = z.infer<typeof verificationVerdictSchema>;

export function parseVerificationVerdict(value: unknown) {
  return verificationVerdictSchema.parse(value);
}

export function isPassingVerification(value: unknown) {
  const parsed = verificationVerdictSchema.safeParse(value);
  return (
    parsed.success &&
    parsed.data.verdict === 'pass' &&
    parsed.data.checks.every((check) => check.status === 'pass' && check.evidenceArtifactIds.length > 0)
  );
}
