import { AdvancedStatistic } from '../AdvancedStatistic';
import { GaugeChart } from '../GaugeChart';
import { ProgressKpi } from '../ProgressKpi';
import { RankedTable } from '../RankedTable';
import { SparklineCard } from '../SparklineCard';
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

  it('sorts sparkline values by the configured date field', () => {
    const chart = new SparklineCard();
    const props = chart.getProps({
      data: [
        { createdAt: '2026-02-01', count: 20 },
        { createdAt: '2026-01-01', count: 10 },
      ],
      general: { xField: 'createdAt', yField: 'count' },
      advanced: {},
      fieldProps,
    });

    expect(props.plotConfig.data).toEqual([10, 20]);
    expect(props.value).toBe(20);
  });

  it('preserves an explicit zero limit for ranked tables', () => {
    const chart = new RankedTable();
    const props = chart.getProps({
      data: [{ name: 'A', count: 9 }],
      general: { labelField: 'name', valueField: 'count', limit: 0 },
      advanced: {},
      fieldProps,
    });

    expect(props.rows).toEqual([]);
  });

  it('clamps gauge values and handles a zero maximum', () => {
    const chart = new GaugeChart();
    const props = chart.getProps({
      data: [{ count: 10 }],
      general: { valueField: 'count', maxValue: 0 },
      advanced: {},
      fieldProps,
    });

    expect(props.config.percent).toBe(0);
    expect(props.displayValue).toBe(10);
  });

  it('only flags target display for progress cards when a target field is set', () => {
    const chart = new ProgressKpi();
    const withTarget = chart.getProps({
      data: [{ count: 25, total: 50 }],
      general: { valueField: 'count', targetField: 'total' },
      advanced: {},
      fieldProps,
    });
    const withoutTarget = chart.getProps({
      data: [{ count: 25 }],
      general: { valueField: 'count', maxValue: 100 },
      advanced: {},
      fieldProps,
    });

    expect(withTarget.showTarget).toBe(true);
    expect(withoutTarget.showTarget).toBe(false);
  });

  it('pushes rows with unparseable dates to the end of the sparkline', () => {
    const chart = new SparklineCard();
    const props = chart.getProps({
      data: [
        { createdAt: 'not-a-date', count: 99 },
        { createdAt: '2026-02-01', count: 20 },
        { createdAt: '2026-01-01', count: 10 },
      ],
      general: { xField: 'createdAt', yField: 'count' },
      advanced: {},
      fieldProps,
    });

    expect(props.plotConfig.data).toEqual([10, 20, 99]);
  });
});
