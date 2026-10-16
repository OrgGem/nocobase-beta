import { AdvancedStatistic } from './AdvancedStatistic';
import { GaugeChart } from './GaugeChart';
import { HeatmapChart } from './HeatmapChart';
import { ProgressKpi } from './ProgressKpi';
import { RadarChart } from './RadarChart';
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
  new HeatmapChart(),
  new RadarChart(),
];
