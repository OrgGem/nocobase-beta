import { AdvancedStatistic } from '../AdvancedStatistic';
import { GaugeChart } from '../GaugeChart';
import { HeatmapChart } from '../HeatmapChart';
import { ProgressKpi } from '../ProgressKpi';
import { RadarChart } from '../RadarChart';
import { RankedTable } from '../RankedTable';
import { SparklineCard } from '../SparklineCard';
import { TimelineChart } from '../TimelineChart';
import { formatNumber } from '../utils';

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

  it('leaves the statistic title empty on init so the field label wins', () => {
    const fields = [{ value: 'count', label: 'Count', key: 'count' }];
    const chart = new AdvancedStatistic();
    const params = chart.init(fields, { measures: [{ field: 'count' }] });

    expect(params.general.field).toBe('count');
    expect(params.general.title).toBe('');
  });

  it('formats numbers with thousands separators and compact notation', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatNumber(1234567, 0, true)).toBe('1M');
    expect(formatNumber(1234567, undefined, true)).toBe('1.23M');
    expect(formatNumber(1234.567, 2)).toBe('1,234.57');
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

  it('keeps the progress stroke unset unless a valid color is configured', () => {
    const chart = new ProgressKpi();
    const invalid = chart.getProps({
      data: [{ count: 25 }],
      general: { valueField: 'count', maxValue: 100, strokeColor: 'javascript:alert(1)' },
      advanced: {},
      fieldProps,
    });
    const valid = chart.getProps({
      data: [{ count: 25 }],
      general: { valueField: 'count', maxValue: 100, strokeColor: '#1677ff' },
      advanced: {},
      fieldProps,
    });

    expect(invalid.strokeColor).toBeUndefined();
    expect(valid.strokeColor).toBe('#1677ff');
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

  it('sorts timeline items by date and keeps a string label', () => {
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
    expect(typeof props.items[0].label).toBe('string');
  });

  it('formats timeline labels with the configured pattern and hides invalid dates', () => {
    const chart = new TimelineChart();
    const props = chart.getProps({
      data: [
        { createdAt: 'not-a-date', name: 'Broken' },
        { createdAt: '2026-02-01 12:30:00', name: 'Valid' },
      ],
      general: { timeField: 'createdAt', titleField: 'name', sortOrder: 'descend', labelFormat: 'YYYY-MM-DD' },
      advanced: {},
      fieldProps,
    });

    // Unparseable dates are always pushed to the end, whichever way the timeline is sorted.
    expect(props.items[0].label).toBe('2026-02-01');
    expect(props.items[1].label).toBeUndefined();
  });

  it('falls back to a placeholder when the timeline title field is empty', () => {
    const chart = new TimelineChart();
    const props = chart.getProps({
      data: [{ createdAt: '2026-02-01 00:00:00' }],
      general: { timeField: 'createdAt', sortOrder: 'descend' },
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

    expect(props.plotConfig.data).toEqual([{ y: 10 }, { y: 20 }]);
    expect(props.plotConfig.yField).toBe('y');
    expect(props.value).toBe(20);
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

    expect(props.plotConfig.data).toEqual([{ y: 10 }, { y: 20 }, { y: 99 }]);
  });

  it('switches the sparkline to a ratio when the ring type is selected', () => {
    const chart = new SparklineCard();
    const props = chart.getProps({
      data: [
        { createdAt: '2026-01-01', count: 25 },
        { createdAt: '2026-02-01', count: 50 },
      ],
      general: { xField: 'createdAt', yField: 'count', shape: 'Tiny.Ring' },
      advanced: {},
      fieldProps,
    });

    expect(props.plotType).toBe('Tiny.Ring');
    expect(props.plotConfig.percent).toBe(50);
    expect(props.plotConfig.data).toBeUndefined();
  });

  it('clamps gauge values and handles a zero maximum', () => {
    const chart = new GaugeChart();
    const props = chart.getProps({
      data: [{ count: 10 }],
      general: { valueField: 'count', maxValue: 0 },
      advanced: {},
      fieldProps,
    });

    expect(props.config.data).toBe(0);
    expect(props.percent).toBe(0);
    expect(props.displayValue).toBe(10);
  });

  it('feeds the gauge with the plots v2 percentage contract', () => {
    const chart = new GaugeChart();
    const props = chart.getProps({
      data: [{ count: 25 }],
      general: { valueField: 'count', maxValue: 50, color: '#1677ff' },
      advanced: {},
      fieldProps,
    });

    expect(props.config.data).toBe(0.5);
    expect(props.config.scale.color.range).toEqual(['#1677ff', '#e8e8e8']);
    expect(props.config.style.text.content).toBe('50%');
  });

  it('maps heatmap rows to the plots v2 x/y/color contract', () => {
    const chart = new HeatmapChart();
    const props = chart.getProps({
      data: [
        { name: 'A', createdAt: '2026-01-01', count: 3 },
        { name: 'B', createdAt: '2026-01-02', count: 7 },
      ],
      general: { xField: 'createdAt', yField: 'name', valueField: 'count' },
      advanced: {},
      fieldProps,
    });

    expect(props.config.data).toEqual([
      { x: '2026-01-01', y: 'A', value: 3 },
      { x: '2026-01-02', y: 'B', value: 7 },
    ]);
    expect(props.config.colorField).toBe('value');
    expect(props.title).toBe('Count');
  });

  it('maps radar rows to the plots v2 category/value contract', () => {
    const chart = new RadarChart();
    const props = chart.getProps({
      data: [
        { name: 'Speed', count: 5 },
        { name: 'Cost', count: 9 },
      ],
      general: { xField: 'name', yField: 'count', coordinateType: 'radar' },
      advanced: {},
      fieldProps,
    });

    expect(props.config.data).toEqual([
      { category: 'Speed', value: 5 },
      { category: 'Cost', value: 9 },
    ]);
    expect(props.config.coordinateType).toBe('radar');
  });
});
