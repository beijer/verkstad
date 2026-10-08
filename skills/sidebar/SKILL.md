---
name: sidebar
description: "Open the verkstad sidebar: the Run going and its Start, Stop and Abort buttons, what needs the owner, the Tickets up next and past Runs."
disable-model-invocation: true
---

# The verkstad sidebar

The sidebar, verkstad's hooks module, answers this command itself by opening its pane, so no agent reads this. If you are reading it, the sidebar did not load. Tell the owner so, and that it needs a Claude Code that loads a plugin's hooks modules; if it failed to load, a dim line in the transcript (or in `claude --debug`'s log) names the reason. Do nothing else.
