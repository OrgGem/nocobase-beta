import { detectFormat, parseCsv, parseTree, treeToFlatRows } from '../parser';
import { COMMUNE_LEVEL, PROVINCE_LEVEL } from '../parser';

describe('vietnam region importer parser', () => {
  it('detects format from filename', () => {
    expect(detectFormat('a.json')).toBe('json');
    expect(detectFormat('a.csv')).toBe('csv');
    expect(detectFormat('a.XLSX')).toBe('xlsx');
    expect(detectFormat('a.txt')).toBeUndefined();
  });

  it('parses csv rows into a province->commune tree and flattens to 2 levels', () => {
    const csv = [
      'province,province_code,commune,commune_code',
      'Thành phố Hồ Chí Minh,79,Phường Bến Nghé,27031',
      'Thành phố Hồ Chí Minh,79,Phường Bến Thành,27034',
      'Hà Nội,01,Phường Chương Dương,00418',
    ].join('\n');

    const rows = treeToFlatRows(parseTree(csv, 'csv'));

    const provinces = rows.filter((r) => r.level === PROVINCE_LEVEL);
    const communes = rows.filter((r) => r.level === COMMUNE_LEVEL);

    expect(provinces).toHaveLength(2);
    expect(communes).toHaveLength(3);

    const hcmc = provinces.find((p) => p.code === '79');
    // verbatim display name is preserved
    expect(hcmc?.name).toBe('Thành phố Hồ Chí Minh');

    const benNghe = communes.find((c) => c.code === '27031');
    expect(benNghe?.parentCode).toBe('79');
    expect(benNghe?.name).toBe('Phường Bến Nghé');
  });

  it('generates sequential codes when input has no codes', () => {
    const csv = ['province,commune', 'Hà Nội,Phường A', 'Hà Nội,Phường B'].join('\n');
    const rows = treeToFlatRows(parseTree(csv, 'csv'));
    const province = rows.find((r) => r.level === PROVINCE_LEVEL);
    expect(province?.code).toMatch(/^VN/);
    const communes = rows.filter((r) => r.level === COMMUNE_LEVEL);
    expect(communes.every((c) => c.parentCode === province?.code)).toBe(true);
  });

  it('parses flat json rows (code/name/level/parentCode)', () => {
    const content = JSON.stringify([
      { code: '79', name: 'TP. Hồ Chí Minh', level: 1 },
      { code: '27031', name: 'Bến Nghé', level: 2, parentCode: '79' },
    ]);
    const rows = treeToFlatRows(parseTree(content, 'json'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ code: '79', level: 1 });
    expect(rows[1]).toMatchObject({ code: '27031', level: 2, parentCode: '79' });
  });

  it('parses json object map shape', () => {
    const content = JSON.stringify({ 'Hà Nội': ['Phường A', 'Xã B'] });
    const rows = treeToFlatRows(parseTree(content, 'json'));
    expect(rows.filter((r) => r.level === COMMUNE_LEVEL)).toHaveLength(2);
  });

  it('handles quoted csv fields with embedded commas', () => {
    const content = 'province,commune\n"Hanoi, capital","Phường A"';
    const parsed = parseCsv(content);
    expect(parsed[1]).toEqual(['Hanoi, capital', 'Phường A']);
  });
});
