# The ADR: `docs/adr/`

An architectural decision record: one decision that shaped the Project, and why. Agents read the ADRs touching the area they work in, and say so when their change would contradict one. Ray's seven ADRs and verkstad's own are written in this format.

## Shape

One file per decision, `docs/adr/NNNN-slug.md`: numbered from `0001` in the order decided, the slug a few words of the decision (`0003-stream-and-upload-transports.md`). The next number is one above the highest in the directory.

```md
# <The decision, as a short statement>

<One paragraph: the situation, what was decided, and why. Name the alternatives that were
rejected and the reason for each ("We rejected …, because …").>

## Consequences

- <What follows from the decision that a reader would not guess.>
```

- The title states the decision itself ("The Rust core owns the Project", "Specs and blockers are native GitHub relations"), not the question.
- The paragraph is the record. Many ADRs are only the title and that paragraph.
- `## Consequences` is optional: a list of what the decision commits the Project to, or rules out, that is not plain from the paragraph.
- No status field or other sections.

## When to write one

Only when all three hold:

1. **Hard to reverse.** Changing course later would cost real work.
2. **Surprising without its reason.** A reader of the code would ask why it was done this way, and might "fix" it.
3. **A real trade-off.** There were other reasonable options, and one was picked for a reason.

A decision missing any of these is not recorded.

## Changing a decision

An ADR is not rewritten to say something else. A new ADR records the new decision and names the one it replaces; the old one gains a first line saying which ADR replaces it. Fixing a typo or adding a consequence that was always true is an edit.
