# verkstad as a Project

The prose half of verkstad's Contract: what an agent working on verkstad itself needs to know. The scripts' half is `.claude/harness.json`; the conventions are in CLAUDE.md.

- The Gate is `npm run typecheck`, `npm test` and, where the `claude` CLI is installed, `claude plugin validate . --strict`. Until `verkstad gate` exists, run them by hand.
- verkstad has no Surfaces: its Tickets land at most `test-verified`, and their proof is the tests through the CLI seam.
- Use `claude plugin validate` to check the plugin. Installing it (`claude plugin marketplace add`, `claude plugin install`) changes the owner's Claude Code config, so leave that to the owner.
- Ray (`beijer/ray`, checked out at `$HOME/code/ray`) is the first Project. A Ticket that changes Ray does it in a Ray worktree, following Ray's CLAUDE.md, never in Ray's main checkout.
- Tests never reach GitHub; reading a real repo by hand (`verkstad frontier` against `beijer/verkstad`) is fine, changing one is not.
