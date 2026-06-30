# Field selection filter

This plugin adds table-column settings for filtering selectable values in v2 table blocks.

For association fields, **Set field selection filter** opens the v2 data-scope filter dialog and constrains the records available from:

- Dropdown and cascade selectors.
- Table quick edit.
- Record-picker popup tables.

Example:

- A source table has `division` and `center` fields.
- `center` belongs to a division.
- Configure the `center` column with `division.id = current record division.id`.

The filter is stored in the v2 FlowEngine step parameters and propagated to the editable field model used by the table column.

For enum fields (`select`, `multipleSelect`, `radioGroup`, `checkboxGroup`), **Set enum option filter** filters static option lists in table quick edit and editable fields.

Example:

- A source table has enum fields `city` and `district`.
- Each `district` option includes scope metadata, for example `{ label: 'Ba Dinh', value: 'ba_dinh', city: 'hanoi' }`.
- Configure the `district` column with source field path `city` and option scope path `city`.

If `city` is an association object, use a source path such as `city.id` and match it with option metadata such as `cityId`.
