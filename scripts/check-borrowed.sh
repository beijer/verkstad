#!/bin/sh
# The Gate's `borrowed` step (ADR 0002): only a Borrowed skill names a mattpocock-skills skill.
#
# It reads what agents read as instructions: skills/, agents/, prompts/, docs/ (except docs/adr/, whose
# decisions tell the history), CLAUDE.md and .claude/, tracked or not, ignored files left out.
# There it fails on the plugin's name, and in skills/, agents/ and prompts/ also on a counterpart skill's
# bare slash name (`/to-tickets`). A Borrowed skill is a skills/<name>/SKILL.md with the line
#   This is a Borrowed skill: follow `mattpocock-skills:<skill>`.
# It may name that one skill and nothing else of the plugin, in at most max_lines lines.
# Prints only what fails. Exits 1 when something does, 2 when the check itself could not run.
set -eu
cd "$(dirname "$0")/.."

max_lines=30
marker='^This is a Borrowed skill: follow `mattpocock-skills:[a-z0-9-]+`\.$'
plugin='mattpocock-skills|matt-pocock-skills'
# The plugin's skills, as of 1.2.3. A bare `/<name>` is how its own docs call one.
names='ask-matt|code-review|codebase-design|diagnosing-bugs|domain-modeling|grill-me|grill-with-docs|grilling|handoff|implement|improve-codebase-architecture|prototype|research|resolving-merge-conflicts|setup-matt-pocock-skills|tdd|teach|to-questionnaire|to-spec|to-tickets|triage|wait-what|wayfinder|wizard|writing-for-agents'
slash="(^|[^A-Za-z0-9_./-])/($names)([^A-Za-z0-9_/-]|$)"

broken() { echo "check-borrowed: $1" >&2; exit 2; }
fail=0

# git grep: 0 found, 1 none, anything else an error that must not read as clean.
search() {
  rc=0
  out=$(git grep --untracked -nIE "$@") || rc=$?
  [ "$rc" -le 1 ] || broken "git grep failed (exit $rc)"
  printf '%s' "$out"
}

borrowed=$(search -l "$marker" -- 'skills/*/SKILL.md')
exempt=""
for f in $borrowed; do
  exempt="$exempt :(exclude)$f"
  lines=$(wc -l < "$f") || broken "could not read $f"
  if [ "$lines" -gt "$max_lines" ]; then
    echo "$f: a Borrowed skill is at most $max_lines lines; this one has $lines"
    fail=1
  fi
  named=$(grep -oE 'mattpocock-skills:[a-z0-9-]+' "$f" | sort -u) || broken "could not read $f"
  if [ "$(printf '%s\n' "$named" | wc -l)" -ne 1 ]; then
    echo "$f: a Borrowed skill names one skill; this one names $(printf '%s' "$named" | tr '\n' ' ')"
    fail=1
  fi
done

# $exempt is split on purpose: one pathspec per Borrowed skill. Paths hold no spaces.
# shellcheck disable=SC2086
hits=$(search -i "$plugin" -- skills agents prompts docs CLAUDE.md .claude ':(exclude)docs/adr' $exempt)
# shellcheck disable=SC2086
slashes=$(search "$slash" -- skills agents prompts $exempt)
if [ -n "$hits$slashes" ]; then
  echo "Only a Borrowed skill may name a mattpocock-skills skill (ADR 0002); name the verkstad skill instead:"
  [ -z "$hits" ] || printf '%s\n' "$hits"
  [ -z "$slashes" ] || printf '%s\n' "$slashes"
  fail=1
fi

exit "$fail"
