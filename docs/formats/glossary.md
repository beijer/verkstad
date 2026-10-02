# The glossary: `CONTEXT.md`

A Project's words, one definition each, in `CONTEXT.md` at the repo root. Agents read it before they explore and use its terms in code, tests, docs, Tickets and messages. Ray's `CONTEXT.md` and verkstad's own are written in this format.

## Shape

```md
# <Project name>

<One or two sentences: what the Project is and who it is for.>

## <Group>

**<Term>**:
<What it is: one paragraph.>
_Avoid_: <word>, <word>

**<Term>**:
…
```

- The title is the Project's name, followed by one or two sentences on what it is.
- Terms sit under `##` headings that group them (verkstad: "Projects and their contract", "Work", "Proof"). A larger glossary puts its groups as `###` under one `## Language` heading (Ray: Machines, Artwork, Running, Dialling in). A small one may have a single group.
- Each term is a bold line ending in a colon, then its definition as one paragraph, then one `_Avoid_:` line listing the words not to use for it. No blank line inside an entry; one blank line between entries.

## Rules

- **One word per concept.** Where several words exist, pick one and put the others under `_Avoid_`. A word may stand for only one term.
- **Say what it is.** The definition starts with what the thing is (Ray's Sketch is "a group of Shapes that are moved, scaled and rotated together"), then gives the rules that make it that thing. It is not a spec: how the code does it, file names and APIs stay out.
- **Only this Project's concepts.** General programming ideas (a timeout, a cache) don't belong, however much the code uses them.
- **Capitalised terms.** Inside definitions and elsewhere, a glossary term is written with its capital (a Ticket, the Frontier), so a reader can tell the term from the everyday word.
- **Changed as it is settled.** When a term is pinned down or renamed, `CONTEXT.md` changes in the same commit, and the old word joins `_Avoid_`.

A Project with several separate contexts may instead have a `CONTEXT-MAP.md` at its root pointing at one `CONTEXT.md` per context; see [agent-docs.md](agent-docs.md#domainmd). Ray and verkstad each have one context.
