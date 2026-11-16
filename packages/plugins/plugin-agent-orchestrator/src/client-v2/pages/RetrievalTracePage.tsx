// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { RetrievalTraceTab } from '../components/RetrievalTraceTab';

const RetrievalTracePage: React.FC<{ embedded?: boolean }> = ({ embedded }) => (
  <div style={embedded ? undefined : { padding: '0 24px 24px' }}>
    <RetrievalTraceTab />
  </div>
);

export default RetrievalTracePage;
