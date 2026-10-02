# Add an expense

A user records what they spent, on which account and day, and sees it in the month's list and its total at once.

## Sub-features

- `add-save`: a valid expense appears at the top of the month's list.
- `add-total`: the month's total grows by the amount.
- `add-invalid`: an amount of zero or less is refused with a message beside the field.
- `add-other-month`: an expense dated in another month shows only in that month.

## How to get to it

- The `Add expense` button in the top bar.
- The shortcut `Ctrl+E`.

## Driving it

`e2e/add-expense.spec.ts` covers `add-save`, `add-total` and `add-invalid` ("an expense appears in the month's list and its total", "a negative amount is refused"). Replay it:

- `scripts/ledger click "Add expense"`: `look` shows the fields `Amount`, `Account`, `Date`.
- `scripts/ledger fill Amount 12.50`, `scripts/ledger click Save`: `see "12.50"` passes, and `look` shows the month's total grown by it.
- `scripts/ledger fill Amount -1`, `scripts/ledger click Save`: `see "Enter an amount above zero"` passes.

No test covers `add-other-month`: add an expense dated last month, then `scripts/ledger click "Previous month"`; it shows there and not in this month.

## Gotchas

- `Ctrl+E` does nothing while a dialog is open: close it first.
- The total updates after the list does: wait for the total itself.
- Amounts are shown with two decimals; `fill Amount 12.5` shows `12.50`.
