// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { AIEmployeesProvider } from '../components/AIEmployeesContext';
import { AgentBindingsTab } from '../components/AgentBindingsTab';

const AgentBindingsPage: React.FC<{ embedded?: boolean }> = ({ embedded }) => (
  <AIEmployeesProvider>
    <div style={embedded ? undefined : { padding: '0 24px 24px' }}>
      <AgentBindingsTab />
    </div>
  </AIEmployeesProvider>
);

export default AgentBindingsPage;
