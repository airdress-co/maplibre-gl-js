#!/usr/bin/env bash
# Runs the tests series.toml names for each patch, by name, so a failure says
# which feature broke.
#
#   airdress/scripts/feature-tests.sh --tree DIR [--from APPLIED] [--report FILE]
#
#   --tree DIR       the tree to run in (npm ci and build-dist already done
#                    when a render test is listed).
#   --from APPLIED   first copy each listed test from APPLIED into DIR: with
#                    DIR a plain upstream checkout, a pass means upstream may
#                    now do what the patch does.
#   --report FILE    append "<patch> <test> pass|fail" lines to FILE.
#
# A test is "unit:<path>.test.ts" (vitest, unit config) or "render:<id>" (a
# directory under test/integration/render/tests/). Without --from, any failure
# fails the run; with it, failures are expected and only reported.
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

tree=""
from=""
report=""
while [ $# -gt 0 ]; do
    case "$1" in
        --tree) tree="$2"; shift 2 ;;
        --from) from="$2"; shift 2 ;;
        --report) report="$2"; shift 2 ;;
        -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
        *) die "unknown argument: $1" ;;
    esac
done
[ -n "$tree" ] || die "--tree is required"

mapfile -t rows < <(node -e '
const fs = require("fs");
const text = fs.readFileSync(process.argv[1], "utf8");
for (const block of text.split(/^\[\[patch\]\]$/m).slice(1)) {
    const file = block.match(/^file = "([^"]+)"/m)?.[1];
    const tests = block.match(/^tests = (\[[^\]]*\])/m)?.[1];
    if (file && tests) for (const t of JSON.parse(tests)) console.log(`${file} ${t}`);
}' "$PATCH_DIR/series.toml")

if [ "${#rows[@]}" -eq 0 ]; then
    echo "feature-tests: no patch names a test"
    exit 0
fi

failed=0
for row in "${rows[@]}"; do
    patch="${row%% *}"
    t="${row#* }"
    kind="${t%%:*}"
    target="${t#*:}"
    if [ -n "$from" ]; then
        case "$kind" in
            unit) mkdir -p "$tree/$(dirname "$target")"; cp "$from/$target" "$tree/$target" ;;
            render) rm -rf "$tree/test/integration/render/tests/$target"
                    mkdir -p "$tree/test/integration/render/tests/$(dirname "$target")"
                    cp -r "$from/test/integration/render/tests/$target" "$tree/test/integration/render/tests/$target" ;;
        esac
    fi
    case "$kind" in
        unit) cmd=(npx vitest run --config vitest.config.unit.ts "$target") ;;
        render) cmd=(npx vitest run test/integration/render/render.test.ts -t "$target") ;;
        *) die "$patch: test '$t' is neither unit: nor render:" ;;
    esac
    echo "::group::$patch $t"
    if (cd "$tree" && "${cmd[@]}"); then result=pass; else result=fail; failed=1; fi
    echo "::endgroup::"
    echo "$patch $t $result"
    [ -z "$report" ] || echo "$patch $t $result" >> "$report"
done

if [ -z "$from" ] && [ "$failed" -ne 0 ]; then
    echo "feature-tests: a feature's tests fail" >&2
    exit 1
fi
exit 0
