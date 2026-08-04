# plugin-advance-charts

Advanced chart types for NocoBase Data visualization.

This plugin registers an `Advanced Charts` group in the v2 chart builder. It reuses the existing Data visualization query pipeline, so collection filters, data scope, ACL, and data sources continue to work through `charts:queryData`.

> Compatibility note: the v2 configuration adapter currently uses internal modules from
> `@nocobase/plugin-data-visualization`. Keep both plugins on the same NocoBase 2.x release
> and run the plugin test/build checks when upgrading NocoBase.

Included chart types:

- Advanced Statistic Card
- Progress KPI Card
- Ranked Table
- Timeline
- Sparkline Card
- Gauge
