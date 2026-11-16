// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { AIEmployeesProvider } from '../components/AIEmployeesContext';
import { UsageGovernanceTab } from '../components/UsageGovernanceTab';

const UsageGovernancePage: React.FC<{ embedded?: boolean }> = ({ embedded }) => (
  <AIEmployeesProvider>
    <div style={embedded ? undefined : { padding: '0 24px 24px' }}>
      <UsageGovernanceTab />
    </div>
  </AIEmployeesProvider>
);

export default UsageGovernancePage;
