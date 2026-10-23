# This fork of MapLibre GL JS

This repository is a fork of
[maplibre/maplibre-gl-js](https://github.com/maplibre/maplibre-gl-js). Its
`main` branch does not hold a copy of MapLibre. It holds a short series of
patches, the tooling that applies them, and the workflows that test and
release the result. The patches float: on each upstream release they are
re-applied to the new tag, and nothing here is ever rewritten.

If you came here from upstream: every patch is written as an upstream pull
request would be (one topic, its tests, upstream's conventions, nothing from
Mapbox's proprietary code), so any of them can be offered upstream as it is.
Which ones are offered, and when, is decided per patch.

## Layout

| Path | What |
|---|---|
| `patches/series` | the upstream tag the series applies to (`base v6.15.0`), then the patches in order |
| `patches/NNNN-<topic>.patch` | one patch per topic, in `git format-patch` form |
| `patches/series.toml` | one entry per patch: feature, API, upstream issue, whether it has been offered, when to drop it, its tests |
| `airdress/scripts/apply.sh` | upstream tag + series → an applied tree (`git am -3`, one commit per patch) |
| `airdress/scripts/refresh.sh` | applied tree → the patch files again, byte-identical when nothing moved |
| `airdress/scripts/series-check.mjs` | files, `series` and entries agree; the series applies; the divergence |
| `airdress/scripts/doc-numbers.sh` | the lines the patches add carry no internal document numbers |
| `airdress/scripts/reapply.sh` | the series onto a newer upstream release, for a pull request |
| `airdress/scripts/feature-tests.sh` | each patch's own tests, by name |
| `.github/workflows/fork-ci.yml` | pull requests and `main`: upstream's suites in the applied tree, Linux only |
| `.github/workflows/fork-release.yml` | a release: applied branch and tag pushed once, built twice and compared, attested |
| `.github/workflows/fork-reapply.yml` | daily: the series re-applied onto upstream's newest release, as a pull request |

Upstream's own workflows never run here: `main` has none of upstream's files,
and the series' first patch removes upstream's workflows from every applied
tree. Upstream's `release.yml` publishes to npm, and this fork never does.

## Branches and tags

- `main`: the series. It moves forward only, through reviewed pull requests.
- `airdress/v<upstream>-airdress.<n>`: the exact tree a release was built
  from, upstream's tag plus one commit per patch and a release commit. Pushed
  once by the release workflow, never moved, never deleted.
- `v<upstream>-airdress.<n>`: the release tag, at that branch's head.
- `reapply/<tag>`, `work/<tag>`: a re-apply pull request, and the partly
  applied tree when one conflicts. Deleted after merge.

## Making a change

```sh
airdress/scripts/apply.sh --repo ../applied          # base + series, one commit per patch
cd ../applied                                       # edit and test; amend the commit of the
                                                    # patch you change (git rebase -i), or add one
cd -
airdress/scripts/refresh.sh --repo ../applied        # writes patches/ back
airdress/scripts/refresh.sh --repo ../applied --add my-topic   # a new patch
node airdress/scripts/series-check.mjs --apply      # agrees, applies, divergence
```

Add the patch's entry to `patches/series.toml`, then open a pull request to
`main`. Its body carries the range-diff of the applied series before and
after (`git range-diff base..old base..new`), so a reviewer reads code rather
than a diff of diffs.

## Releases

Dispatch `fork-release` on `main` with the release number `n`. The workflow
applies the series, pushes `airdress/v<base>-airdress.<n>` and its tag (both
refused if they exist), builds `npm pack` on two runners from that tag,
fails unless the four served files and the tarball are byte for byte the
same, attests the tarball, and publishes a GitHub Release with the tarball
and `SHA256SUMS`.

A rebuild of upstream's `v6.15.0` with this method (Node 26, `npm ci
--ignore-scripts`, `npm run build-dist`, `npm pack`) gives npm's
`maplibre-gl-6.15.0.tgz` byte for byte, tarball included.

## Licence

BSD-3-Clause, as upstream. `LICENSE.txt` keeps every upstream notice
unchanged, with one line above them for this fork's changes.
