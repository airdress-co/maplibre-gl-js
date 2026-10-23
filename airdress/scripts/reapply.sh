#!/usr/bin/env bash
# Re-applies the series onto the newest upstream release and regenerates the
# patch files, for a pull request to main. Nothing is pushed here: the
# workflow pushes the branch and opens the pull request.
#
#   airdress/scripts/reapply.sh --repo DIR [--to TAG] [--upstream URL]
#                               [--advisories FILE] [--report FILE]
#                               [--github-output FILE]
#
#   --repo DIR          scratch repository for the applied trees.
#   --to TAG            re-apply onto TAG instead of the newest release.
#   --advisories FILE   upstream's published security advisories (the JSON of
#                       GET /repos/maplibre/maplibre-gl-js/security-advisories).
#   --report FILE       the pull request body, in Markdown.
#   --github-output F   key=value lines: tag, conflict, stopped, urgent, dropped.
#
# Exit status: 0 re-applied (or nothing newer), 3 a patch conflicts (the
# partial tree is left on branch work/<tag> in DIR), 1 anything else.
#
# A patch upstream already contains applies empty; it is dropped from the
# series and named in the report. The fork-ci patch is regenerated rather than
# applied, so a workflow upstream adds after the old base is removed as well.
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

repo=""
to=""
upstream="$UPSTREAM_URL_DEFAULT"
advisories=""
report="/dev/null"
gh_output="/dev/null"

while [ $# -gt 0 ]; do
    case "$1" in
        --repo) repo="$2"; shift 2 ;;
        --to) to="$2"; shift 2 ;;
        --upstream) upstream="$2"; shift 2 ;;
        --advisories) advisories="$2"; shift 2 ;;
        --report) report="$2"; shift 2 ;;
        --github-output) gh_output="$2"; shift 2 ;;
        -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
        *) die "unknown argument: $1" ;;
    esac
done
[ -n "$repo" ] || die "--repo is required"
mkdir -p "$repo"
repo="$(realpath "$repo")"

old_base="$(series_base)"
mapfile -t names < <(series_names)

out() { echo "$1" >> "$gh_output"; }

# Newest release tag: vX.Y.Z only, no pre-releases.
if [ -z "$to" ]; then
    to="$(git ls-remote --tags --refs "$upstream" 'v*' \
        | sed -n 's#.*refs/tags/\(v[0-9]*\.[0-9]*\.[0-9]*\)$#\1#p' \
        | sort -V | tail -1)"
    [ -n "$to" ] || die "no release tags at $upstream"
fi
if [ "$(printf '%s\n%s\n' "$old_base" "$to" | sort -V | tail -1)" = "$old_base" ]; then
    echo "up to date: the series is on $old_base, the newest release is $to"
    out "tag="
    exit 0
fi
echo "re-applying the series from $old_base onto $to"
out "tag=$to"

# The old applied tree, for the range-diff.
"$(dirname "$0")/apply.sh" --repo "$repo" --upstream "$upstream" --branch "series/$old_base" >/dev/null
fetch_tag "$repo" "$to"

git -C "$repo" checkout -q -f -B "work/$to" "refs/tags/$to^{commit}"
am_dir="$(cd "$repo" && realpath -m "$(git rev-parse --git-path rebase-apply)")"

kept=()
dropped=()
stopped=""
for name in "${names[@]}"; do
    patch="$PATCH_DIR/$name"
    topic="${name#[0-9][0-9][0-9][0-9]-}"; topic="${topic%.patch}"
    if [ "$topic" = "fork-ci" ]; then
        # Regenerated: delete whatever workflows and dependabot file this tag has.
        info="$(mktemp)"; msg="$(mktemp)"
        git mailinfo "$msg" /dev/null < "$patch" > "$info"
        git -C "$repo" rm -q -r --ignore-unmatch .github/workflows .github/dependabot.yml
        GIT_AUTHOR_NAME="$(sed -n 's/^Author: //p' "$info")" \
        GIT_AUTHOR_EMAIL="$(sed -n 's/^Email: //p' "$info")" \
        GIT_AUTHOR_DATE="$(sed -n 's/^Date: //p' "$info")" \
        GIT_COMMITTER_DATE="$(sed -n 's/^Date: //p' "$info")" \
            git_pure -C "$repo" commit -q --allow-empty -F <( { sed -n 's/^Subject: //p' "$info"; echo; cat "$msg"; } )
        rm -f "$info" "$msg"
        kept+=("$name")
        continue
    fi
    before="$(git -C "$repo" rev-parse HEAD)"
    if git_pure -C "$repo" -c user.name="$GIT_COMMITTER_NAME" -c user.email="$GIT_COMMITTER_EMAIL" \
            am -q -3 --keep-cr --committer-date-is-author-date "$patch" >/dev/null 2>&1; then
        # A patch whose change upstream already made applies as no commit, or
        # as an empty one.
        if [ "$(git -C "$repo" rev-parse HEAD)" = "$before" ]; then
            dropped+=("$name")
        elif git -C "$repo" diff --quiet "$before" HEAD; then
            git -C "$repo" reset -q --hard "$before"
            dropped+=("$name")
        else
            kept+=("$name")
        fi
        continue
    fi
    if git -C "$repo" diff --quiet && git -C "$repo" diff --cached --quiet; then
        # Nothing left to apply: upstream contains it.
        git -C "$repo" am --skip >/dev/null 2>&1 || true
        [ ! -d "$am_dir" ] || git -C "$repo" am --abort
        dropped+=("$name")
        continue
    fi
    stopped="$name"
    break
done

{
    echo "Re-applies the series from \`$old_base\` onto \`$to\`."
    echo
} > "$report"

if [ -n "$stopped" ]; then
    out "conflict=true"
    out "stopped=$stopped"
    {
        echo "**Draft: \`$stopped\` does not apply to \`$to\`.** The partly applied tree is on \`work/$to\`;"
        echo "resolve it there, \`git am --continue\`, apply the rest, run \`airdress/scripts/refresh.sh --base $to\`"
        echo "and push to this branch."
        echo
    } >> "$report"
    echo "conflict: $stopped does not apply to $to (tree left on work/$to)" >&2
    git -C "$repo" am --show-current-patch=diff > /dev/null 2>&1 || true
    exit 3
fi
out "conflict=false"
out "dropped=${dropped[*]:-}"

# Renumber what is kept, rewrite series and series.toml, then refresh.
new_names=()
declare -A renamed=()
for i in "${!kept[@]}"; do
    old="${kept[$i]}"
    new="$(printf '%04d' $((i + 1)))-${old#[0-9][0-9][0-9][0-9]-}"
    new_names+=("$new")
    renamed["$old"]="$new"
done
{
    echo "# The upstream tag the series applies to, then the patches in order."
    echo "# Maintained by airdress/scripts/refresh.sh; see airdress/README.md."
    echo "base $to"
    printf '%s\n' "${new_names[@]}"
} > "$SERIES_FILE"
node - "$PATCH_DIR/series.toml" "$(declare -p renamed)" "${dropped[@]}" <<'EOF'
const fs = require('fs');
const [path, renamedDecl, ...dropped] = process.argv.slice(2);
const renamed = Object.fromEntries([...renamedDecl.matchAll(/\[([^\]]+)\]="([^"]+)"/g)].map((m) => [m[1], m[2]]));
const blocks = fs.readFileSync(path, 'utf8').split(/(?=^\[\[patch\]\]$)/m);
const kept = blocks.filter((b) => {
    const file = b.match(/^file = "([^"]+)"/m)?.[1];
    return !file || !dropped.includes(file);
}).map((b) => b.replace(/^file = "([^"]+)"/m, (all, f) => (renamed[f] ? `file = "${renamed[f]}"` : all)));
fs.writeFileSync(path, kept.join(''));
EOF
for f in "${dropped[@]}"; do rm -f "$PATCH_DIR/$f"; done
for old in "${!renamed[@]}"; do
    [ "$old" = "${renamed[$old]}" ] || mv "$PATCH_DIR/$old" "$PATCH_DIR/${renamed[$old]}"
done
"$(dirname "$0")/refresh.sh" --repo "$repo" --base "$to"

# The pull request body.
urgent=false
changelog="$(git -C "$repo" show "refs/tags/$to:CHANGELOG.md" 2>/dev/null \
    | awk -v v="${to#v}" '$0 ~ "^## " v "([^0-9.]|$)" {on = 1; print; next} on && /^## / {exit} on {print}' || true)"
if printf '%s' "$changelog" | grep -qiE 'security|GHSA-|CVE-|XSS|sanitiz'; then urgent=true; fi
advisory_lines=""
if [ -n "$advisories" ] && [ -s "$advisories" ]; then
    advisory_lines="$(node - "$advisories" "${old_base#v}" "${to#v}" <<'EOF'
const fs = require('fs');
const [path] = process.argv.slice(2);
const list = JSON.parse(fs.readFileSync(path, 'utf8'));
const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
for (const a of list) {
    if (!a.published_at || Date.parse(a.published_at) < cutoff) continue;
    const ranges = (a.vulnerabilities ?? []).map((v) => `${v.vulnerable_version_range} fixed in ${v.patched_versions}`).join('; ');
    console.log(`- ${a.ghsa_id} (${a.severity}, published ${a.published_at.slice(0, 10)}): ${a.summary} [${ranges}]`);
}
EOF
)"
    [ -z "$advisory_lines" ] || urgent=true
fi
out "urgent=$urgent"

{
    if [ "$urgent" = true ]; then
        echo "**Security: upstream names a security fix in this range.** Fork release and page pin within 48 h for"
        echo "critical and high, 7 days otherwise."
        echo
    fi
    if [ -n "$advisory_lines" ]; then
        echo "### Upstream advisories published in the last 30 days"
        echo
        echo "$advisory_lines"
        echo
    fi
    echo "### Dropped or emptied patches"
    echo
    if [ "${#dropped[@]}" -gt 0 ]; then
        printf -- '- `%s`: upstream now contains it\n' "${dropped[@]}"
    else
        echo "None."
    fi
    echo
    echo "### Divergence"
    echo
    node "$(dirname "$0")/series-check.mjs" 2>/dev/null
    echo
    echo "### Range-diff (\`$old_base\` + series against \`$to\` + series)"
    echo
    echo '```'
    git -C "$repo" range-diff --no-color "refs/tags/$old_base..series/$old_base" "refs/tags/$to..work/$to" || true
    echo '```'
    echo
    echo "### Upstream changelog for $to"
    echo
    if [ -n "$changelog" ]; then echo "$changelog"; else echo "(no section for ${to#v} in CHANGELOG.md)"; fi
} >> "$report"

echo "re-applied ${#new_names[@]} patches onto $to (${#dropped[@]} dropped); urgent=$urgent"
