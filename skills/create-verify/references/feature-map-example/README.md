# Ledger's Feature map

One file per feature a user of Ledger meets. Find the feature here, then follow its Driving it.

## Features

- [Add an expense](add-expense.md): the form, its validation, and the total that follows.
- [Monthly report](monthly-report.md): the report page and its CSV export.

## Baseline

`scripts/ledger start` gives a fresh instance: an empty database, one account `Household`, today's month selected, and a fake bank feed with no transactions. `scripts/ledger reset` returns to it between Walks.

## Conventions

- Find things by what a user reads: a button's text, a field's label, a heading. `scripts/ledger look` prints them.
- Wait for what a step changes (`scripts/ledger see <text>`) before the next step reads it.
- Prove a stored change from a second view (reload the page, or open the report), not only from the form that made it.
