#!/usr/bin/env bash
# Writes the patch files back from an applied tree: one patch per commit
# between the base tag and HEAD, in order, named after patches/series.
#
#   airdress/scripts/refresh.sh [--repo DIR] [--base TAG] [--add TOPIC]...
#
#   --repo DIR     the applied tree (default: ./applied).
#   --base TAG     the tag the tree was applied onto (default: the series'
#                  base). A re-apply passes the new tag; series is rewritten
#                  to name it.
#   --add TOPIC    a commit past the last listed patch is a new patch,
#                  named NNNN-TOPIC.patch. One --add per new commit, in order.
#
# A file is rewritten only when its bytes change, so a refresh of an
# unchanged tree touches nothing. Patch files no longer in the series are
# removed.
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

repo="$PWD/applied"
base=""
adds=()

while [ $# -gt 0 ]; do
    case "$1" in
        --repo) repo="$2"; shift 2 ;;
        --base) base="$2"; shift 2 ;;
        --add) adds+=("$2"); shift 2 ;;
        -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
        *) die "unknown argument: $1" ;;
    esac
done

[ -n "$base" ] || base="$(series_base)"
mapfile -t names < <(series_names)
git -C "$repo" rev-parse -q --verify "refs/tags/$base^{commit}" >/dev/null \
    || die "$repo has no tag $base"
mapfile -t commits < <(git -C "$repo" rev-list --reverse "refs/tags/$base..HEAD")

for c in "${commits[@]}"; do
    subject="$(git -C "$repo" log -1 --format=%s "$c")"
    case "$subject" in
        "Release "*-airdress.*) die "HEAD includes a release commit ($subject); refresh a working tree, not a release" ;;
    esac
done

for topic in "${adds[@]}"; do
    [[ "$topic" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || die "a topic is lowercase words joined by '-': $topic"
    names+=("$(printf '%04d' $(( ${#names[@]} + 1 )))-$topic.patch")
done

if [ "${#commits[@]}" -ne "${#names[@]}" ]; then
    die "$repo has ${#commits[@]} commits on $base, the series names ${#names[@]} patches (use --add TOPIC for a new one, or remove a dropped one from patches/series first)"
fi

write_if_changed() {
    local target="$1" tmp="$2"
    if [ -f "$target" ] && cmp -s "$tmp" "$target"; then
        rm -f "$tmp"
        return 1
    fi
    chmod 644 "$tmp"
    mv "$tmp" "$target"
    return 0
}

changed=0
for i in "${!commits[@]}"; do
    tmp="$(mktemp "$PATCH_DIR/.refresh.XXXXXX")"
    git_pure -C "$repo" -c core.abbrev=12 -c diff.renames=true -c diff.algorithm=myers \
        format-patch -1 --stdout --no-signature --zero-commit --no-numbered --full-index --binary \
        "${commits[$i]}" > "$tmp"
    if write_if_changed "$PATCH_DIR/${names[$i]}" "$tmp"; then
        echo "wrote patches/${names[$i]}"
        changed=1
    fi
done

tmp="$(mktemp "$PATCH_DIR/.refresh.XXXXXX")"
{
    echo "# The upstream tag the series applies to, then the patches in order."
    echo "# Maintained by airdress/scripts/refresh.sh; see airdress/README.md."
    echo "base $base"
    printf '%s\n' "${names[@]}"
} > "$tmp"
if write_if_changed "$SERIES_FILE" "$tmp"; then
    echo "wrote patches/series"
    changed=1
fi

for f in "$PATCH_DIR"/*.patch; do
    [ -e "$f" ] || continue
    keep=0
    for name in "${names[@]}"; do [ "$(basename "$f")" = "$name" ] && keep=1; done
    if [ "$keep" -eq 0 ]; then
        rm -f "$f"
        echo "removed patches/$(basename "$f")"
        changed=1
    fi
done

[ "$changed" -eq 1 ] || echo "unchanged: ${#names[@]} patches on $base"
