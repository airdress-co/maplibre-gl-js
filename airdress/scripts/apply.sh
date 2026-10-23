#!/usr/bin/env bash
# Builds an applied tree: the upstream tag named in patches/series, with every
# patch applied in order as one commit each (git am -3).
#
#   airdress/scripts/apply.sh [--repo DIR] [--base TAG] [--branch NAME]
#                             [--version VERSION] [--upstream URL]
#
#   --repo DIR       the git repository to apply in (default: ./applied).
#                    Created and fetched from upstream if it does not exist.
#   --base TAG       apply onto this tag instead of the series' base.
#   --branch NAME    the local branch to (re)create (default: applied/<base>).
#   --version V      a release: also commit package.json's version as V.
#   --upstream URL   where upstream's tags come from.
#
# On a conflict the `git am` is left in progress in DIR, so the patch that
# stopped can be resolved there and continued; the exit status is then 3.
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

repo="$PWD/applied"
base=""
branch=""
version=""
upstream="$UPSTREAM_URL_DEFAULT"

while [ $# -gt 0 ]; do
    case "$1" in
        --repo) repo="$2"; shift 2 ;;
        --base) base="$2"; shift 2 ;;
        --branch) branch="$2"; shift 2 ;;
        --version) version="$2"; shift 2 ;;
        --upstream) upstream="$2"; shift 2 ;;
        -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
        *) die "unknown argument: $1" ;;
    esac
done

[ -n "$base" ] || base="$(series_base)"
[ -n "$branch" ] || branch="applied/$base"
mapfile -t names < <(series_names)

for name in "${names[@]}"; do
    [ -f "$PATCH_DIR/$name" ] || die "patches/series lists $name, which does not exist"
done

mkdir -p "$repo"
repo="$(realpath "$repo")"
# The tree must be its own repository (or worktree), never a directory inside
# another one: the checkout below is forced.
if [ "$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null)" != "$repo" ]; then
    [ -z "$(ls -A "$repo")" ] || die "$repo is not empty and not a repository of its own"
    git -C "$repo" init -q
fi
[ "$repo" != "$SERIES_ROOT" ] || die "refusing to apply into the series repository itself"
am_dir="$(cd "$repo" && realpath -m "$(git rev-parse --git-path rebase-apply)")"
git -C "$repo" remote get-url upstream >/dev/null 2>&1 \
    || git -C "$repo" remote add upstream "$upstream"
fetch_tag "$repo" "$base"

if [ -d "$am_dir" ]; then
    die "$repo has a git am in progress; finish or abort it first"
fi
git -C "$repo" checkout -q -f -B "$branch" "refs/tags/$base^{commit}"

if [ "${#names[@]}" -gt 0 ]; then
    patch_paths=()
    for name in "${names[@]}"; do patch_paths+=("$PATCH_DIR/$name"); done
    if ! git_pure -C "$repo" -c user.name="$GIT_COMMITTER_NAME" -c user.email="$GIT_COMMITTER_EMAIL" \
            am -q -3 --keep-cr --committer-date-is-author-date "${patch_paths[@]}"; then
        next="$(cat "$am_dir/next" 2>/dev/null || echo 0)"
        echo "conflict: patch $next of ${#names[@]} (${names[$((next - 1))]:-?}) does not apply to $base" >&2
        echo "${names[$((next - 1))]:-?}" > "$(dirname "$am_dir")/series-stopped-at"
        echo "resolve in $repo, then 'git am --continue' and airdress/scripts/refresh.sh" >&2
        exit 3
    fi
fi

if [ -n "$version" ]; then
    case "$version" in
        *-airdress.[0-9]*) ;;
        *) die "a fork version is <upstream>-airdress.<n>, not $version" ;;
    esac
    node - "$repo" "$version" <<'EOF'
const fs = require('fs');
const [dir, version] = process.argv.slice(2);
for (const name of ['package.json', 'package-lock.json']) {
    const path = `${dir}/${name}`;
    if (!fs.existsSync(path)) continue;
    const text = fs.readFileSync(path, 'utf8');
    const json = JSON.parse(text);
    json.version = version;
    if (json.packages && json.packages['']) json.packages[''].version = version;
    const indent = text.match(/^[ \t]+/m)?.[0] ?? '  ';
    fs.writeFileSync(path, `${JSON.stringify(json, null, indent)}\n`);
}
EOF
    git -C "$repo" add package.json package-lock.json 2>/dev/null || git -C "$repo" add package.json
    head_date="$(git -C "$repo" log -1 --format=%aI)"
    GIT_AUTHOR_NAME="$GIT_COMMITTER_NAME" GIT_AUTHOR_EMAIL="$GIT_COMMITTER_EMAIL" \
        GIT_AUTHOR_DATE="$head_date" GIT_COMMITTER_DATE="$head_date" \
        git_pure -C "$repo" commit -q -m "Release $version"
fi

echo "applied ${#names[@]} patches onto $base: $(git -C "$repo" rev-parse HEAD) (branch $branch, tree $(git -C "$repo" rev-parse 'HEAD^{tree}'))"
