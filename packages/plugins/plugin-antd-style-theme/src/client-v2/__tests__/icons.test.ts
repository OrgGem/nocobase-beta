import { describe, expect, it } from 'vitest';
import { getIconGroup } from '../icons';

describe('V2 extended icon groups', () => {
  it('keeps registered Material and Bootstrap icons discoverable alongside Ant Design icons', () => {
    expect(getIconGroup('bgcolorsoutlined')).toBe('Outlined');
    expect(getIconGroup('MdDashboard')).toBe('Material');
    expect(getIconGroup('bSgRId')).toBe('Bootstrap');
    expect(getIconGroup('heartfilled')).toBe('Filled');
    expect(getIconGroup('settingtwotone')).toBe('Two tone');
    expect(getIconGroup('custom')).toBeUndefined();
  });
});
