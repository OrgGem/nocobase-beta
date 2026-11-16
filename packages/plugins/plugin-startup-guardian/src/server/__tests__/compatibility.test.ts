// SPDX-License-Identifier: Apache-2.0

import { isValidatedCoreVersion, VALIDATED_CORE_VERSION } from '../compatibility';

describe('Startup Guardian automatic recovery compatibility', () => {
  it('permits only the exact PostgreSQL adapter baseline and rejects unknown versions', () => {
    expect(isValidatedCoreVersion(VALIDATED_CORE_VERSION)).toBe(true);
    expect(isValidatedCoreVersion('2.2.41')).toBe(false);
    expect(isValidatedCoreVersion('2.3.0')).toBe(false);
    expect(isValidatedCoreVersion(null)).toBe(false);
  });
});
