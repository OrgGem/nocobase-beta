/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export type NativeHarnessScope = 'chat' | 'api' | 'workflow' | 'sub-agent';
export type HarnessCapabilityStatus = 'enforced' | 'observe-only' | 'unsupported';

export type NativeHarnessCapability = {
  id: string;
  labelKey: string;
  settings: string[];
  byScope: Record<NativeHarnessScope, { status: HarnessCapabilityStatus; reasonKey: string }>;
};

export type ScopedHarnessCapability = {
  id: string;
  labelKey: string;
  settings: string[];
  status: HarnessCapabilityStatus;
  scopeKey: string;
  detailKey: string;
};

const scopes: NativeHarnessScope[] = ['chat', 'api', 'workflow', 'sub-agent'];

const unsupportedForEveryScope = (reasonKey: string) =>
  Object.fromEntries(scopes.map((scope) => [scope, { status: 'unsupported', reasonKey }])) as Record<
    NativeHarnessScope,
    { status: HarnessCapabilityStatus; reasonKey: string }
  >;

export function getHarnessCapabilities() {
  const nativeCapabilities: NativeHarnessCapability[] = [
    {
      id: 'tool-access',
      labelKey: 'Native tool access and approval',
      settings: ['tools.allow', 'tools.ask', 'tools.deny', 'tools.escalate'],
      byScope: unsupportedForEveryScope('Harness capability: no native tool gate'),
    },
    {
      id: 'runtime-limits',
      labelKey: 'Native runtime limits',
      settings: ['tools.timeouts', 'limits.*'],
      byScope: unsupportedForEveryScope('Harness capability: no native runtime limit gate'),
    },
    {
      id: 'delegation',
      labelKey: 'Native delegation controls',
      settings: ['delegation.*'],
      byScope: unsupportedForEveryScope('Harness capability: core owns delegation'),
    },
    {
      id: 'memory-context',
      labelKey: 'Native memory and context controls',
      settings: ['memory.*', 'context.*'],
      byScope: unsupportedForEveryScope('Harness capability: no native context extension'),
    },
    {
      id: 'isolation',
      labelKey: 'Native worktree and network isolation',
      settings: ['isolation.*'],
      byScope: unsupportedForEveryScope('Harness capability: native isolation unsupported'),
    },
    {
      id: 'flow-monitoring',
      labelKey: 'Native execution flow monitoring',
      settings: ['observability.enabled'],
      byScope: {
        chat: { status: 'observe-only', reasonKey: 'Harness capability: chat monitoring scope' },
        api: { status: 'observe-only', reasonKey: 'Harness capability: API monitoring scope' },
        workflow: { status: 'observe-only', reasonKey: 'Harness capability: workflow monitoring scope' },
        'sub-agent': { status: 'observe-only', reasonKey: 'Harness capability: sub-agent monitoring scope' },
      },
    },
  ];

  const scopedCapabilities: ScopedHarnessCapability[] = [
    {
      id: 'skill-hub-timeout',
      labelKey: 'Skill Hub sandbox timeout cap',
      settings: ['tools.timeouts[skill tool]', 'tools.timeouts.skill_hub_execute'],
      status: 'enforced',
      scopeKey: 'Skill Hub sandbox execution',
      detailKey: 'Harness capability: Skill Hub timeout behavior',
    },
    {
      id: 'skill-hub-output-spill',
      labelKey: 'Skill Hub inline output spill',
      settings: ['context.spill.maxInlineBytes'],
      status: 'observe-only',
      scopeKey: 'Skill Hub sandbox execution',
      detailKey: 'Harness capability: Skill Hub output spill behavior',
    },
  ];

  return {
    version: 1,
    scopes,
    nativeCapabilities,
    scopedCapabilities,
    telemetrySettings: {
      settings: [
        'observability.enabled',
        'observability.captureInputs',
        'observability.captureOutputs',
        'observability.redactSecrets',
        'observability.sharing',
        'observability.tracingRetentionDays',
      ],
      noteKey: 'Harness capability: telemetry settings scope',
    },
    noteKey: 'Harness capability: native enforcement boundary',
  };
}
