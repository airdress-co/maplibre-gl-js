#!/usr/bin/env bash
# Every patch is written so it could be offered upstream as it is, so the
# lines a patch adds carry no internal document numbers (spec, research or
# runbook ids), not even in comments, and a feature patch names no Airdress
# thing. Patch file names and the branch being built are held to the first
# rule too. Upstream's own files are never read.
#
#   airdress/scripts/doc-numbers.sh [BRANCH]
#
# Patches whose series.toml entry says `offer = "never"` (the fork's own
# infrastructure) may name Airdress; they are never offered.
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

doc_number='(^|[^[:alnum:]])(spec|rdr|rcp|rb)[-_]?[0-9]{3}([^[:alnum:]]|$)'
status=0

never_offered() {
    awk -v f="$1" '
        /^\[\[patch\]\]/ { file = ""; offer = "" }
        $1 == "file" { gsub(/"/, "", $3); file = $3 }
        $1 == "offer" { gsub(/"/, "", $3); offer = $3 }
        file == f && offer == "never" { found = 1 }
        END { exit found ? 0 : 1 }' "$PATCH_DIR/series.toml"
}

branch="${1:-}"
if [ -n "$branch" ] && echo "$branch" | grep -qiE "$doc_number"; then
    echo "doc-numbers: branch name '$branch' carries a document number" >&2
    status=1
fi

for f in "$PATCH_DIR"/*.patch; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    if echo "$name" | grep -qiE "$doc_number"; then
        echo "doc-numbers: patch file name $name carries a document number" >&2
        status=1
    fi
    # Added lines only: '+' inside a hunk, never the '+++' header.
    added="$(awk '/^diff --git /{h=0} /^@@/{h=1; next} h && /^\+/ {print FILENAME ":" FNR ": " substr($0, 2)}' "$f")"
    if hits="$(printf '%s\n' "$added" | grep -iE "$doc_number")"; then
        printf '%s\n' "$hits" | sed 's/^/doc-numbers: document number in an added line: /' >&2
        status=1
    fi
    if ! never_offered "$name"; then
        if hits="$(printf '%s\n' "$added" | grep -iE 'airdress')"; then
            printf '%s\n' "$hits" | sed 's/^/doc-numbers: an offerable patch names Airdress: /' >&2
            status=1
        fi
    fi
done

[ "$status" -eq 0 ] && echo "doc-numbers: no document numbers in the patches' added lines"
exit "$status"
