/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { SkillManager } from '../skill-hub/components/SkillManager';

const SkillDefinitionsPage: React.FC<{ embedded?: boolean }> = ({ embedded }) => (
  <div style={embedded ? undefined : { padding: '0 24px 24px' }}>
    <SkillManager />
  </div>
);

export default SkillDefinitionsPage;
