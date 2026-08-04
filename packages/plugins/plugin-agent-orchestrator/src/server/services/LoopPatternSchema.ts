import { z } from 'zod';
import { harnessSettingsSchema } from './HarnessSchema';

const finiteLimit = z.number().finite().nonnegative().nullable().default(null);
const countLimit = z.number().int().nonnegative().nullable().default(null);

export const loopPatternPolicySchema = z
  .object({
    harness: harnessSettingsSchema.default({}),
    maxConcurrency: z.number().int().positive().default(1),
    perRun: z
      .object({
        maxInvocations: countLimit,
        maxToolCalls: countLimit,
        maxDelegations: countLimit,
        maxVerifications: countLimit,
        maxTokens: countLimit,
        maxCost: finiteLimit,
      })
      .default({}),
    daily: z
      .object({
        maxInvocations: countLimit,
        maxToolCalls: countLimit,
        maxDelegations: countLimit,
        maxTokens: countLimit,
        maxCost: finiteLimit,
      })
      .default({}),
    circuit: z
      .object({
        maxAttempts: z.number().int().positive().default(3),
        maxConsecutiveFailures: z.number().int().positive().default(3),
        maxRepeatedError: z.number().int().positive().default(2),
        cooldownMs: z.number().int().positive().default(300_000),
      })
      .default({}),
    paths: z
      .object({
        maxFiles: z.number().int().positive().nullable().default(null),
        deny: z.array(z.string().min(1)).default([]),
      })
      .default({}),
    actions: z
      .object({
        autoAllowlist: z.array(z.string().min(1)).default([]),
        approvalAssigneeIds: z.array(z.number().int().positive()).default([]),
        approvalTimeoutMs: z.number().int().positive().default(86_400_000),
      })
      .default({}),
    verification: z
      .object({
        requiredChecks: z.array(z.string().min(1)).min(1).default(['goal']),
        maxAttempts: z.number().int().positive().default(2),
      })
      .default({}),
  })
  .strict();

export const loopPatternSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
    title: z.string().trim().min(1).max(240),
    description: z.string().default(''),
    goalTemplate: z.string().trim().min(1),
    enabled: z.boolean().default(false),
    autonomyLevel: z.enum(['L1', 'L2', 'L3']).default('L1'),
    triggerType: z.enum(['manual', 'cron', 'event']).default('manual'),
    cronExpression: z.string().trim().max(120).nullable().default(null),
    timezone: z.string().trim().max(80).nullable().default(null),
    eventKey: z.string().trim().max(160).nullable().default(null),
    triggerConfig: z.record(z.unknown()).default({}),
    leaderUsername: z.string().trim().min(1).max(100),
    makerUsernames: z.array(z.string().trim().min(1).max(100)).default([]),
    verifierUsername: z.string().trim().min(1).max(100),
    leaderHarnessTag: z.string().trim().min(1).max(100).default('default'),
    makerHarnessTag: z.string().trim().min(1).max(100).default('default'),
    verifierHarnessTag: z.string().trim().min(1).max(100).default('safe'),
    repositoryKey: z.string().trim().max(200).nullable().default(null),
    repositoryRoot: z.string().trim().max(1000).nullable().default(null),
    baseRef: z.string().trim().min(1).max(200).default('main'),
    actingOn: z.array(z.string().trim().min(1)).default([]),
    policy: loopPatternPolicySchema.default({}),
  })
  .superRefine((pattern, context) => {
    const makers = new Set(pattern.makerUsernames);
    if (pattern.verifierUsername === pattern.leaderUsername || makers.has(pattern.verifierUsername)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verifierUsername'],
        message: 'Verifier must be different from the leader and every maker.',
      });
    }
    if (makers.size !== pattern.makerUsernames.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['makerUsernames'],
        message: 'Maker usernames must be unique.',
      });
    }
    if (pattern.triggerType === 'cron') {
      const parts = pattern.cronExpression?.split(/\s+/).filter(Boolean) || [];
      if (parts.length !== 5 && parts.length !== 6) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cronExpression'],
          message: 'Cron patterns require a 5- or 6-field cron expression.',
        });
      }
      if (!pattern.timezone) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['timezone'],
          message: 'Cron patterns require an explicit timezone.',
        });
      } else {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: pattern.timezone });
        } catch {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['timezone'],
            message: 'Cron pattern timezone is invalid.',
          });
        }
      }
    }
    if (pattern.triggerType === 'event' && !pattern.eventKey) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['eventKey'],
        message: 'Event patterns require an event key.',
      });
    }
    if (pattern.autonomyLevel !== 'L1') {
      if (!pattern.repositoryKey || !pattern.repositoryRoot || pattern.actingOn.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['repositoryKey'],
          message: 'L2 and L3 patterns require repository identity, root, and declared actingOn paths.',
        });
      }
      if (!pattern.policy.harness.isolation.requireWorktree) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['policy', 'harness', 'isolation', 'requireWorktree'],
          message: 'L2 and L3 patterns must require a worktree.',
        });
      }
    }
  });

export type LoopPattern = z.infer<typeof loopPatternSchema>;
export type LoopPatternPolicy = z.infer<typeof loopPatternPolicySchema>;

export function parseLoopPattern(value: unknown) {
  return loopPatternSchema.parse(value);
}

export function validateLoopPattern(value: unknown) {
  return loopPatternSchema.safeParse(value);
}
