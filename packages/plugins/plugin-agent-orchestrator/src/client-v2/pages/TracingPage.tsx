// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { AIEmployeesProvider } from '../components/AIEmployeesContext';
import { TracingTab } from '../components/TracingTab';

const TracingPage: React.FC<{ embedded?: boolean }> = ({ embedded }) => (
  <AIEmployeesProvider>
    <div style={embedded ? undefined : { padding: '0 24px 24px' }}>
      <TracingTab />
    </div>
  </AIEmployeesProvider>
);

export default TracingPage;
