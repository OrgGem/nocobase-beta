# Field selection filter

This plugin adds the **Set field selection filter** setting to association columns in v2 table blocks. The setting opens the v2 data-scope filter dialog and constrains the records available from:

- Dropdown and cascade selectors.
- Table quick edit.
- Record-picker popup tables.

Example:

- A source table has `division` and `center` fields.
- `center` belongs to a division.
- Configure the `center` column with `division.id = current record division.id`.

The filter is stored in the v2 FlowEngine step parameters and propagated to the editable field model used by the table column.
