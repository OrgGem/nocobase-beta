import { AdvancedStatistic } from '../AdvancedStatistic';
import { ProgressKpi } from '../ProgressKpi';
import { RankedTable } from '../RankedTable';
import { TimelineChart } from '../TimelineChart';

const fieldProps = {
  name: { label: 'Name' },
  count: { label: 'Count' },
  total: { label: 'Total' },
  createdAt: { label: 'Created at' },
};

describe('advanced charts', () => {
  it('maps the first row metric for statistic cards', () => {
    const chart = new AdvancedStatistic();
    const props = chart.getProps({
      data: [{ count: 12 }],
      general: { field: 'count', precision: 0 },
      advanced: {},
      fieldProps,
    });

    expect(props.value).toBe(12);
    expect(props.title).toBe('Count');
  });

  it('calculates progress percent from value and target fields', () => {
    const chart = new ProgressKpi();
    const props = chart.getProps({
      data: [{ count: 25, total: 50 }],
      general: { valueField: 'count', targetField: 'total' },
      advanced: {},
      fieldProps,
    });

    expect(props.percent).toBe(50);
    expect(props.value).toBe(25);
    expect(props.target).toBe(50);
  });

  it('sorts ranked table rows and limits top records', () => {
    const chart = new RankedTable();
    const props = chart.getProps({
      data: [
        { name: 'B', count: 5 },
        { name: 'A', count: 9 },
        { name: 'C', count: 1 },
      ],
      general: { labelField: 'name', valueField: 'count', limit: 2, sortOrder: 'descend', showRank: true },
      advanced: {},
      fieldProps,
    });

    expect(props.rows.map((row) => row.name)).toEqual(['A', 'B']);
    expect(props.rows.map((row) => row.__rank)).toEqual([1, 2]);
  });

  it('sorts timeline items by date', () => {
    const chart = new TimelineChart();
    const props = chart.getProps({
      data: [
        { createdAt: '2026-01-01 00:00:00', name: 'Old' },
        { createdAt: '2026-02-01 00:00:00', name: 'New' },
      ],
      general: { timeField: 'createdAt', titleField: 'name', sortOrder: 'descend' },
      advanced: {},
      fieldProps,
    });

    expect(props.items[0].label).toBe('2026-02-01 00:00');
  });
});
