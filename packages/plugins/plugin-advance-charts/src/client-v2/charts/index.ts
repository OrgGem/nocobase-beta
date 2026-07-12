import { AdvancedStatistic } from './AdvancedStatistic';
import { GaugeChart } from './GaugeChart';
import { ProgressKpi } from './ProgressKpi';
import { RankedTable } from './RankedTable';
import { SparklineCard } from './SparklineCard';
import { TimelineChart } from './TimelineChart';

export const createAdvancedCharts = () => [
  new AdvancedStatistic(),
  new ProgressKpi(),
  new RankedTable(),
  new TimelineChart(),
  new SparklineCard(),
  new GaugeChart(),
];
