/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { isValidatedCoreVersion, VALIDATED_CORE_VERSION } from '../compatibility';

describe('Startup Guardian automatic recovery compatibility', () => {
  it('permits only the exact PostgreSQL adapter baseline and rejects unknown versions', () => {
    expect(isValidatedCoreVersion(VALIDATED_CORE_VERSION)).toBe(true);
    expect(isValidatedCoreVersion('2.2.41')).toBe(false);
    expect(isValidatedCoreVersion('2.3.0')).toBe(false);
    expect(isValidatedCoreVersion(null)).toBe(false);
  });
});
