// The series tooling against a small fake upstream: node --test airdress/test/
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const env = {...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Test Author', GIT_AUTHOR_EMAIL: 'author@example.com',
    GIT_COMMITTER_NAME: 'Test Author', GIT_COMMITTER_EMAIL: 'author@example.com',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z'};

function run(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, {encoding: 'utf8', env, ...opts});
    return {status: r.status, out: `${r.stdout}${r.stderr}`};
}
function git(dir, ...args) {
    const r = run('git', ['-C', dir, ...args]);
    assert.equal(r.status, 0, r.out);
    return r.out.trim();
}

/** A fake upstream with tag v1.0.0, and a series root holding two patches made against it. */
function fixture() {
    const tmp = mkdtempSync(join(tmpdir(), 'series-test-'));
    const upstream = join(tmp, 'upstream');
    run('git', ['init', '-q', '-b', 'main', upstream]);
    writeFileSync(join(upstream, 'package.json'), '{\n  "name": "maplibre-gl",\n  "version": "1.0.0"\n}\n');
    writeFileSync(join(upstream, 'a.txt'), 'one\ntwo\nthree\n');
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '-q', '-m', 'Initial');
    git(upstream, 'tag', 'v1.0.0');

    const root = join(tmp, 'series');
    cpSync(scripts, join(root, 'airdress', 'scripts'), {recursive: true});
    const work = join(tmp, 'work');
    run('git', ['clone', '-q', upstream, work]);
    git(work, 'checkout', '-q', '-b', 'w', 'v1.0.0');
    writeFileSync(join(work, 'a.txt'), 'one\ntwo changed\nthree\n');
    git(work, 'commit', '-q', '-am', 'Change two');
    writeFileSync(join(work, 'b.txt'), 'new\n');
    git(work, 'add', 'b.txt');
    git(work, 'commit', '-q', '-m', 'Add b');
    const patches = join(root, 'patches');
    run('mkdir', ['-p', patches]);
    writeFileSync(join(patches, 'series'), 'base v1.0.0\n');
    git(work, 'remote', 'add', 'upstream', upstream);
    const r = run(join(root, 'airdress', 'scripts', 'refresh.sh'), ['--repo', work, '--add', 'change-two', '--add', 'add-b']);
    assert.equal(r.status, 0, r.out);
    writeFileSync(join(patches, 'series.toml'), [
        '[[patch]]', 'file = "0001-change-two.patch"', 'topic = "change-two"', 'feature = "fit"', 'summary = "s"', 'offer = "undecided"  # a comment',
        '[[patch]]', 'file = "0002-add-b.patch"', 'topic = "add-b"', 'feature = "fit"', 'summary = "issue #12 stays"', 'offer = "undecided"', ''].join('\n'));
    return {tmp, upstream, root, work, patches};
}

const check = (f, ...extra) => run('node', [join(f.root, 'airdress', 'scripts', 'series-check.mjs'), '--apply', '--upstream', f.upstream, ...extra]);

test('a consistent series that applies passes, and reports its divergence', () => {
    const f = fixture();
    const r = check(f);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /0001-change-two\.patch \| 1 \|/);
    rmSync(f.tmp, {recursive: true, force: true});
});

test('a patch file not in series fails', () => {
    const f = fixture();
    writeFileSync(join(f.patches, '0003-stray.patch'), readFileSync(join(f.patches, '0002-add-b.patch')));
    const r = check(f);
    assert.equal(r.status, 1);
    assert.match(r.out, /0003-stray\.patch is not in patches\/series/);
    rmSync(f.tmp, {recursive: true, force: true});
});

test('a series line without a file, and a patch without an entry, fail', () => {
    const f = fixture();
    writeFileSync(join(f.patches, 'series'), 'base v1.0.0\n0001-change-two.patch\n0002-add-b.patch\n0003-missing.patch\n');
    writeFileSync(join(f.patches, 'series.toml'), readFileSync(join(f.patches, 'series.toml'), 'utf8').split('[[patch]]\nfile = "0002')[0]);
    const r = check(f);
    assert.equal(r.status, 1);
    assert.match(r.out, /lists 0003-missing\.patch, which does not exist/);
    assert.match(r.out, /0002-add-b\.patch has no \[\[patch\]\] entry/);
    rmSync(f.tmp, {recursive: true, force: true});
});

test('a patch that does not apply to the base fails', () => {
    const f = fixture();
    const p = join(f.patches, '0001-change-two.patch');
    writeFileSync(p, readFileSync(p, 'utf8').replace('-two\n', '-two that upstream never had\n'));
    const r = check(f);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /does not apply cleanly to v1\.0\.0/);
    rmSync(f.tmp, {recursive: true, force: true});
});

test('refresh of an unchanged applied tree rewrites no byte', () => {
    const f = fixture();
    const applied = join(f.tmp, 'applied');
    let r = run(join(f.root, 'airdress', 'scripts', 'apply.sh'), ['--repo', applied, '--upstream', f.upstream]);
    assert.equal(r.status, 0, r.out);
    const before = Object.fromEntries(readdirSync(f.patches).map((n) => [n, [readFileSync(join(f.patches, n)), statSync(join(f.patches, n)).mtimeMs]]));
    r = run(join(f.root, 'airdress', 'scripts', 'refresh.sh'), ['--repo', applied]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /unchanged: 2 patches on v1\.0\.0/);
    for (const [n, [bytes, mtime]] of Object.entries(before)) {
        assert.deepEqual(readFileSync(join(f.patches, n)), bytes, n);
        assert.equal(statSync(join(f.patches, n)).mtimeMs, mtime, n);
    }
    rmSync(f.tmp, {recursive: true, force: true});
});

test('applying twice gives the same commit, and a release commit sets the version', () => {
    const f = fixture();
    const a1 = join(f.tmp, 'a1');
    const a2 = join(f.tmp, 'a2');
    const out1 = run(join(f.root, 'airdress', 'scripts', 'apply.sh'), ['--repo', a1, '--upstream', f.upstream, '--version', '1.0.0-airdress.1']);
    const out2 = run(join(f.root, 'airdress', 'scripts', 'apply.sh'), ['--repo', a2, '--upstream', f.upstream, '--version', '1.0.0-airdress.1']);
    assert.equal(out1.status, 0, out1.out);
    assert.equal(git(a1, 'rev-parse', 'HEAD'), git(a2, 'rev-parse', 'HEAD'));
    assert.equal(JSON.parse(readFileSync(join(a1, 'package.json'), 'utf8')).version, '1.0.0-airdress.1');
    const r = run(join(f.root, 'airdress', 'scripts', 'refresh.sh'), ['--repo', a1]);
    assert.equal(r.status, 1);
    assert.match(r.out, /release commit/);
    rmSync(f.tmp, {recursive: true, force: true});
});

test('doc-numbers refuses a document number in an added line and Airdress in an offerable patch', () => {
    const f = fixture();
    const dn = join(f.root, 'airdress', 'scripts', 'doc-numbers.sh');
    assert.equal(run(dn, []).status, 0);
    const p = join(f.patches, '0002-add-b.patch');
    const clean = readFileSync(p, 'utf8');
    writeFileSync(p, clean.replace('+new\n', '+new // see SPEC-170\n'));
    let r = run(dn, []);
    assert.equal(r.status, 1);
    assert.match(r.out, /0002-add-b\.patch: document number: added line/);
    writeFileSync(p, clean.replace('+new\n', '+new // for airdress\n'));
    r = run(dn, []);
    assert.equal(r.status, 1);
    assert.match(r.out, /offerable patch names Airdress/);
    writeFileSync(p, clean);
    assert.equal(run(dn, ['feature/rdr-078-thing']).status, 1);
    rmSync(f.tmp, {recursive: true, force: true});
});

function release(f, tag, edit) {
    git(f.upstream, 'checkout', '-q', 'main');
    edit();
    git(f.upstream, 'add', '-A');
    git(f.upstream, 'commit', '-q', '-m', `Release ${tag}`);
    git(f.upstream, 'tag', tag);
}

test('re-apply onto a newer release drops a patch upstream absorbed and renumbers the rest', () => {
    const f = fixture();
    release(f, 'v1.1.0', () => writeFileSync(join(f.upstream, 'a.txt'), 'zero\none\ntwo changed\nthree\n'));
    const report = join(f.tmp, 'report.md');
    const ghOut = join(f.tmp, 'gh-output');
    const r = run(join(f.root, 'airdress', 'scripts', 'reapply.sh'), ['--repo', join(f.tmp, 'reapply'), '--upstream', f.upstream, '--report', report, '--github-output', ghOut]);
    assert.equal(r.status, 0, r.out);
    assert.equal(readFileSync(join(f.patches, 'series'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).join(' '), 'base v1.1.0 0001-add-b.patch');
    assert.deepEqual(readdirSync(f.patches).filter((n) => n.endsWith('.patch')), ['0001-add-b.patch']);
    assert.match(readFileSync(join(f.patches, 'series.toml'), 'utf8'), /file = "0001-add-b\.patch"/);
    assert.doesNotMatch(readFileSync(join(f.patches, 'series.toml'), 'utf8'), /change-two/);
    assert.match(readFileSync(report, 'utf8'), /`0001-change-two\.patch`: upstream now contains it/);
    assert.match(readFileSync(ghOut, 'utf8'), /^tag=v1\.1\.0$/m);
    assert.equal(check(f).status, 0);
    rmSync(f.tmp, {recursive: true, force: true});
});

test('a conflicting re-apply stops, names the patch and leaves the series untouched', () => {
    const f = fixture();
    release(f, 'v1.1.0', () => writeFileSync(join(f.upstream, 'a.txt'), 'one\ntwo rewritten upstream\nthree\n'));
    const before = readFileSync(join(f.patches, 'series'), 'utf8');
    const ghOut = join(f.tmp, 'gh-output');
    const r = run(join(f.root, 'airdress', 'scripts', 'reapply.sh'), ['--repo', join(f.tmp, 'reapply'), '--upstream', f.upstream, '--github-output', ghOut]);
    assert.equal(r.status, 3, r.out);
    assert.match(readFileSync(ghOut, 'utf8'), /^stopped=0001-change-two\.patch$/m);
    assert.equal(readFileSync(join(f.patches, 'series'), 'utf8'), before);
    rmSync(f.tmp, {recursive: true, force: true});
});

test('nothing newer upstream is a no-op', () => {
    const f = fixture();
    const r = run(join(f.root, 'airdress', 'scripts', 'reapply.sh'), ['--repo', join(f.tmp, 'reapply'), '--upstream', f.upstream]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /up to date/);
    rmSync(f.tmp, {recursive: true, force: true});
});
