# verkstad as a Project

The prose half of verkstad's Contract: what an agent working on verkstad itself needs to know. The scripts' half is `.claude/harness.json`; the conventions are in CLAUDE.md.

- Run the Gate with `bin/verkstad gate` from your worktree (its steps are in `.claude/harness.json`). It prints a line per step, or the failing step's output and the full log's path.
- verkstad has no Surfaces: its Tickets land at most `test-verified`, and their proof is the tests through the CLI seam.
- `.claude-plugin/plugin.json` has no `version`, on purpose: Projects track main, and a version string would keep every installed copy until someone bumped it. So the Gate's `plugin` step runs `claude plugin validate .` without `--strict`, which passes with that one warning.
- Installing the plugin (`claude plugin marketplace add`, `claude plugin install`) changes the owner's Claude Code config, so leave that to the owner.
- Ray (`beijer/ray`, checked out at `$HOME/code/ray`) is the first Project. A Ticket that changes Ray does it in a Ray worktree, following Ray's CLAUDE.md, never in Ray's main checkout.
- Tests never reach GitHub; reading a real repo by hand (`verkstad frontier` against `beijer/verkstad`) is fine, changing one is not.
