/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { ExecutionHistory, LoopSettings, SkillManager, SkillMetrics } from './skill-hub';

type SettingsPageProps = { embedded?: boolean };

const PageContent: React.FC<React.PropsWithChildren<SettingsPageProps>> = ({ embedded, children }) => (
  <div style={embedded ? undefined : { padding: '0 24px 24px' }}>{children}</div>
);

export const SkillDefinitionsPage: React.FC<SettingsPageProps> = (props) => (
  <PageContent {...props}>
    <SkillManager />
  </PageContent>
);

export const ExecutionHistoryPage: React.FC<SettingsPageProps> = (props) => (
  <PageContent {...props}>
    <ExecutionHistory />
  </PageContent>
);

export const LoopSettingsPage: React.FC<SettingsPageProps> = (props) => (
  <PageContent {...props}>
    <LoopSettings />
  </PageContent>
);

export const SkillMetricsPage: React.FC<SettingsPageProps> = (props) => (
  <PageContent {...props}>
    <SkillMetrics />
  </PageContent>
);
