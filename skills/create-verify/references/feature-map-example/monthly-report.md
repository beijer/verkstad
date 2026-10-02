# Monthly report

A user sees a month's spending per account and category, and exports it as CSV.

## Sub-features

- `report-sums`: one row per category with its sum, and the month's total.
- `report-csv`: `Export CSV` writes the same rows to a file.

## How to get to it

- The `Report` tab.

## Driving it

`e2e/monthly-report.spec.ts` ("the report sums each category", "the CSV holds the report's rows"). It seeds expenses with `scripts/ledger seed expenses.json` (fixtures in `e2e/fixtures/`), then:

- `scripts/ledger click Report`: `look` shows one row per category.
- `scripts/ledger click "Export CSV"`: prints the file's path; `cat` it and compare with the rows.

## Gotchas

- The CSV is written to the instance's own download directory, not the owner's: copy it into the Evidence directory.
- A month with no expenses shows `Nothing spent`, not an empty table.
