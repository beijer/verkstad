#!/bin/sh
# The Gate's `borrowed` step (ADR 0002): only a Borrowed skill names a mattpocock-skills skill.
#
# It reads what the loop reads as instructions: skills/, agents/ and docs/, except docs/adr/,
# whose decisions tell the history. A Borrowed skill is a skills/<name>/SKILL.md with the line
#   This is a Borrowed skill: follow `mattpocock-skills:<skill>`.
# It names that one skill and nothing else of the plugin, in at most 30 lines.
# Prints only what fails, and exits 1 if anything does.
set -eu
cd "$(dirname "$0")/.."

max_lines=30
fail=0

borrowed=$(grep -lE '^This is a Borrowed skill: follow `mattpocock-skills:[a-z0-9-]+`\.$' skills/*/SKILL.md 2>/dev/null || true)

for f in $borrowed; do
  lines=$(wc -l < "$f")
  if [ "$lines" -gt "$max_lines" ]; then
    echo "$f: a Borrowed skill is at most $max_lines lines; this one has $lines"
    fail=1
  fi
  named=$(grep -oE 'mattpocock-skills:[a-z0-9-]+' "$f" | sort -u)
  if [ "$(printf '%s\n' "$named" | wc -l)" -ne 1 ]; then
    echo "$f: a Borrowed skill names one skill; this one names $(printf '%s' "$named" | tr '\n' ' ')"
    fail=1
  fi
done

# Every mention of the plugin, outside docs/adr/ and the Borrowed skills.
hits=$(grep -rnIiE 'mattpocock|matt-pocock' skills agents docs 2>/dev/null \
  | awk -v skip="$borrowed" '
      BEGIN { n = split(skip, s, "\n"); for (i = 1; i <= n; i++) exempt[s[i]] = 1 }
      {
        file = $0; sub(/:.*/, "", file)
        if (file ~ /^docs\/adr\// || file in exempt) next
        print
      }' || true)
if [ -n "$hits" ]; then
  echo "Only a Borrowed skill may name a mattpocock-skills skill (ADR 0002); name the verkstad skill instead:"
  printf '%s\n' "$hits"
  fail=1
fi

exit "$fail"
