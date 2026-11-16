// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { AIEmployeesProvider } from '../components/AIEmployeesContext';
import { AgentRunsTab } from '../components/AgentRunsTab';

const RulesPage: React.FC<{ embedded?: boolean }> = ({ embedded }) => (
  <AIEmployeesProvider>
    <div style={embedded ? undefined : { padding: '0 24px 24px' }}>
      <AgentRunsTab />
    </div>
  </AIEmployeesProvider>
);

export default RulesPage;
