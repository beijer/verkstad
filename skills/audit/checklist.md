# Look for

In this order:

1. **Bug:** a wrong result, a crash, a missed edge case (empty, zero, the last item, rounding, time zones), callers that disagree with what a function returns, the same rule applied differently in two places.
2. **Risk:** security holes (injection, weak randomness, secrets in code, missing checks on input from users) and data loss (errors swallowed, writes in the wrong order, no transaction).
3. **Load:** fine for one user, wrong at the expected load: check-then-write races, the same work done by every process, memory or lists that only grow, a query per item, O(n²) on big input, per-process state that must be shared.
4. **Missing test:** risky logic (a branch, a parser, money, security, data writes) with no test that fails when it breaks. One good test, not coverage.
5. **Speed:** real slowdowns. Small wins (work repeated in a hot loop) only where the software counts every millisecond.
6. **Lean:** code that should not exist or should be smaller.
   - delete: dead code, unused options, flags and config, speculative features;
   - reuse: two helpers doing the same thing (keep one, name its path);
   - standard library or platform: it already does it, or a dependency does what a few lines can;
   - yagni: an interface with one implementation, a factory with one product, a wrapper that only passes calls through;
   - merge: near-copies that must change together;
   - split: one function doing several unrelated jobs, so it is hard to read or test. Split by job, never by line count, and never into helpers that exist only to make a function shorter.

# Check before you report

- Every finding has a concrete case: "this input or situation leads to this wrong result"; no case, no finding.
- Re-read the lines. Before calling code unused, grep the whole tree for it, including tests, fixtures, config, and string or dynamic references.
- A `shortcut:` (or older `ponytail:`) comment that names its limit is a decision, not a finding, unless the expected load already crosses it.
- Propose the smallest fix that works, and prefer fixes that delete code. Never add layers, frameworks or config the problem does not need.
- No style taste, no "consider", no vague worries.
