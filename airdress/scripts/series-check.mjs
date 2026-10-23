#!/usr/bin/env node
// Checks that patches/, patches/series and patches/series.toml agree, and
// prints the divergence from upstream that the series amounts to.
//
//   node airdress/scripts/series-check.mjs [--apply] [--repo DIR]
//        [--upstream URL] [--budget-out FILE] [--root DIR]
//
//   --apply          also apply the series to its base (airdress/scripts/apply.sh)
//                    and fail if any patch does not apply cleanly.
//   --repo DIR       the repository to apply in (default: a temporary one).
//   --upstream URL   where the base tag is fetched from.
//   --budget-out F   write the divergence as Markdown to F (for a PR body).
//   --root DIR       the series repository (default: this script's).
//
// Exit status: 0 when everything agrees, 1 on any finding.

import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const OFFER_STATES = new Set(['never', 'undecided', 'owner-declined', 'offered', 'merged', 'superseded']);
const REQUIRED_KEYS = ['file', 'topic', 'feature', 'summary', 'offer'];
const PATCH_NAME = /^(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.patch$/;
// Changed lines in src/ outside new files above which a pull request must
// say why (a soft ceiling: reported, never failed on).
const SOFT_CEILING = 3000;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(option('--root') ?? join(here, '..', '..'));
const patchDir = join(root, 'patches');
const findings = [];
const fail = (message) => findings.push(message);

/** Reads `base <tag>` and the ordered names from patches/series. */
export function parseSeries(text) {
    let base;
    const names = [];
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const [first, second, ...rest] = line.split(/\s+/);
        if (first === 'base') {
            if (base) throw new Error('patches/series has two base lines');
            if (!second || rest.length) throw new Error(`bad base line: ${line}`);
            base = second;
        } else {
            if (second) throw new Error(`one patch name per line: ${line}`);
            names.push(first);
        }
    }
    if (!base) throw new Error('patches/series has no base line');
    return {base, names};
}

/** Enough TOML for series.toml: [[patch]] tables of string, boolean and string-array values. */
export function parseSeriesToml(text) {
    const entries = [];
    let current;
    text.split('\n').forEach((raw, index) => {
        const line = raw.trim();
        if (!line || line.startsWith('#')) return;
        if (line === '[[patch]]') {
            current = {};
            entries.push(current);
            return;
        }
        const match = line.match(/^([a-z_]+)\s*=\s*(.+)$/);
        if (!match || !current) throw new Error(`series.toml:${index + 1}: cannot read "${raw.trim()}"`);
        const [, key, value] = match;
        if (key in current) throw new Error(`series.toml:${index + 1}: ${key} given twice`);
        current[key] = parseValue(value, index + 1);
    });
    return entries;
}

function parseValue(raw, lineNo) {
    // A trailing comment may follow any value; a string's own '#' stays.
    const m = raw.match(/^("(?:[^"\\]|\\.)*"|\[[^\]]*\]|true|false)\s*(?:#.*)?$/);
    if (!m) throw new Error(`series.toml:${lineNo}: only strings, booleans and arrays of strings: ${raw}`);
    const value = m[1];
    if (value === 'true' || value === 'false') return value === 'true';
    return JSON.parse(value);
}

/** Lines added and removed per file in a git format-patch file. */
export function patchStats(text) {
    const files = [];
    let file;
    let inHunk = false;
    for (const line of text.split('\n')) {
        if (line.startsWith('diff --git ')) {
            const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
            file = {path: m ? m[2] : line, added: 0, removed: 0, created: false, deleted: false};
            files.push(file);
            inHunk = false;
            continue;
        }
        if (!file) continue;
        if (line.startsWith('new file mode')) file.created = true;
        else if (line.startsWith('deleted file mode')) file.deleted = true;
        else if (line.startsWith('@@')) inHunk = true;
        else if (inHunk && line.startsWith('+')) file.added++;
        else if (inHunk && line.startsWith('-')) file.removed++;
        else if (line === '-- ') break;
    }
    return files;
}

function divergence(names) {
    const rows = [];
    for (const name of names) {
        const path = join(patchDir, name);
        if (!existsSync(path)) continue;
        const files = patchStats(readFileSync(path, 'utf8'));
        const src = files.filter((f) => f.path.startsWith('src/'));
        rows.push({
            name,
            files: files.length,
            srcChanged: src.filter((f) => !f.created).reduce((n, f) => n + f.added + f.removed, 0),
            srcNew: src.filter((f) => f.created).reduce((n, f) => n + f.added, 0),
            shaders: src.filter((f) => f.path.startsWith('src/shaders/')).reduce((n, f) => n + f.added + f.removed, 0),
            other: files.filter((f) => !f.path.startsWith('src/')).reduce((n, f) => n + f.added + f.removed, 0),
        });
    }
    return rows;
}

function report(base, rows) {
    const total = rows.reduce((t, r) => ({
        srcChanged: t.srcChanged + r.srcChanged, srcNew: t.srcNew + r.srcNew,
        shaders: t.shaders + r.shaders, other: t.other + r.other,
    }), {srcChanged: 0, srcNew: 0, shaders: 0, other: 0});
    const lines = [
        `Divergence from upstream ${base}: ${rows.length} patches.`,
        '',
        '| Patch | Files | src/ changed (existing files) | src/ new files | of which shaders | outside src/ |',
        '|---|---:|---:|---:|---:|---:|',
        ...rows.map((r) => `| ${r.name} | ${r.files} | ${r.srcChanged} | ${r.srcNew} | ${r.shaders} | ${r.other} |`),
        `| **total** | | **${total.srcChanged}** | **${total.srcNew}** | **${total.shaders}** | **${total.other}** |`,
        '',
        total.srcChanged > SOFT_CEILING
            ? `**Over the soft ceiling of ${SOFT_CEILING} changed lines in src/ outside new files: this pull request must say why.**`
            : `Within the soft ceiling of ${SOFT_CEILING} changed lines in src/ outside new files.`,
    ];
    return lines.join('\n');
}

function main() {
    let series;
    let entries = [];
    try {
        series = parseSeries(readFileSync(join(patchDir, 'series'), 'utf8'));
    } catch (e) {
        fail(`patches/series: ${e.message}`);
    }
    try {
        entries = parseSeriesToml(readFileSync(join(patchDir, 'series.toml'), 'utf8'));
    } catch (e) {
        fail(e.message);
    }
    if (!series) return finish();

    const listed = new Set(series.names);
    if (listed.size !== series.names.length) fail('patches/series lists a patch twice');
    const onDisk = readdirSync(patchDir).filter((f) => f.endsWith('.patch'));
    for (const f of onDisk) if (!listed.has(f)) fail(`patches/${f} is not in patches/series`);

    series.names.forEach((name, i) => {
        const m = name.match(PATCH_NAME);
        if (!m) fail(`patches/series: ${name} is not NNNN-topic.patch`);
        else if (Number(m[1]) !== i + 1) fail(`patches/series: ${name} is at position ${i + 1}`);
        if (!existsSync(join(patchDir, name))) fail(`patches/series lists ${name}, which does not exist`);
        const entry = entries.filter((e) => e.file === name);
        if (entry.length === 0) fail(`${name} has no [[patch]] entry in series.toml`);
        if (entry.length > 1) fail(`${name} has ${entry.length} entries in series.toml`);
    });
    for (const e of entries) {
        for (const key of REQUIRED_KEYS) if (typeof e[key] !== 'string' || !e[key]) fail(`series.toml entry ${e.file ?? '?'}: ${key} is required`);
        if (e.file && !listed.has(e.file)) fail(`series.toml has an entry for ${e.file}, which is not in patches/series`);
        if (e.offer && !OFFER_STATES.has(e.offer)) fail(`series.toml entry ${e.file}: offer "${e.offer}" is not one of ${[...OFFER_STATES].join(', ')}`);
        const m = e.file?.match(PATCH_NAME);
        if (m && e.topic && m[2] !== e.topic) fail(`series.toml entry ${e.file}: topic "${e.topic}" does not match the file name`);
        if ((e.offer === 'offered' || e.offer === 'merged') && !e.pr) fail(`series.toml entry ${e.file}: offer "${e.offer}" needs pr`);
    }

    if (flag('--apply')) {
        const repo = option('--repo') ?? mkdtempSync(join(tmpdir(), 'series-apply-'));
        const applyArgs = ['--repo', repo, '--branch', 'series-check'];
        if (option('--upstream')) applyArgs.push('--upstream', option('--upstream'));
        try {
            execFileSync(join(root, 'airdress', 'scripts', 'apply.sh'), applyArgs, {stdio: ['ignore', 'inherit', 'inherit']});
        } catch {
            fail(`the series does not apply cleanly to ${series.base}`);
            try { execFileSync('git', ['-C', repo, 'am', '--abort'], {stdio: 'ignore'}); } catch { /* no am in progress */ }
        }
        if (!option('--repo')) rmSync(repo, {recursive: true, force: true});
    }

    const text = report(series.base, divergence(series.names));
    console.log(text);
    if (option('--budget-out')) writeFileSync(option('--budget-out'), `${text}\n`);
    return finish();
}

function finish() {
    for (const f of findings) console.error(`series-check: ${f}`);
    if (findings.length) {
        console.error(`series-check: ${findings.length} finding(s)`);
        process.exitCode = 1;
    } else {
        console.error('series-check: files, series and entries agree');
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
