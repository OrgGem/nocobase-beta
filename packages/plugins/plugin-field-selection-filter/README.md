# Field selection filter

This plugin adds a table column settings item for association fields. It reuses the NocoBase data-scope filter UI, but stores the filter on the field schema so edit and quick-edit selectors use the same constrained selectable records.

Example:

- Source table has `division` and `center`.
- `center` belongs to a division.
- Configure the `center` column with a data-scope condition like `division.id = current record division.id`.

The filter is saved to `x-component-props.service.params.filter` on the field schema.
