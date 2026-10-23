# Shared by apply.sh, refresh.sh and reapply.sh. Sourced, not executed.

# The series directory: the root of this repository's main branch.
SERIES_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PATCH_DIR="$SERIES_ROOT/patches"
SERIES_FILE="$PATCH_DIR/series"

UPSTREAM_URL_DEFAULT="https://github.com/maplibre/maplibre-gl-js.git"

# Every commit the tooling makes carries the same committer, and its date is
# the author date, so applying the same series to the same base gives the same
# commit ids on any machine.
export GIT_COMMITTER_NAME="${SERIES_COMMITTER_NAME:-maplibre-gl-js fork series}"
export GIT_COMMITTER_EMAIL="${SERIES_COMMITTER_EMAIL:-fork-series@noreply.airdress.co}"

# Git output the patch files depend on must not depend on whoever runs it.
git_pure() {
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git "$@"
}

die() {
    echo "error: $*" >&2
    exit 1
}

# fetch_tag DIR TAG: make an upstream tag available in DIR, shallowly. A
# three-way `git am` onto a new base also needs the old base's blobs, so a
# re-apply fetches both tags.
fetch_tag() {
    local dir="$1" tag="$2"
    if ! git -C "$dir" rev-parse -q --verify "refs/tags/$tag^{commit}" >/dev/null; then
        git -C "$dir" fetch -q --no-tags --depth=1 upstream "refs/tags/$tag:refs/tags/$tag" \
            || die "cannot fetch tag $tag from $(git -C "$dir" remote get-url upstream)"
    fi
}

# series_base: the upstream tag on the `base` line.
series_base() {
    local file="${1:-$SERIES_FILE}"
    awk '$1 == "base" { print $2; found = 1; exit } END { if (!found) exit 1 }' "$file" \
        || die "$file has no 'base <tag>' line"
}

# series_names: the patch file names, in order.
series_names() {
    local file="${1:-$SERIES_FILE}"
    awk '/^[[:space:]]*(#|$)/ { next } $1 == "base" { next } { print $1 }' "$file"
}
