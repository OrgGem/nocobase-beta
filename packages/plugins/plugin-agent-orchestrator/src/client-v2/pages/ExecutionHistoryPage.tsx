// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { ExecutionHistory } from '../skill-hub/components/ExecutionHistory';

const ExecutionHistoryPage: React.FC<{ embedded?: boolean }> = ({ embedded }) => (
  <div style={embedded ? undefined : { padding: '0 24px 24px' }}>
    <ExecutionHistory />
  </div>
);

export default ExecutionHistoryPage;
