#!/usr/bin/env node
/**
 * Spec conformance runner — locks the App Spec contract (js/core/app-spec.js)
 * against the shared corpus (tests/spec/corpus.json).
 *
 * This is the Mac/JS half of the cross-engine conformance gate described in
 * docs/PLATFORM.md: every case in the corpus must validate the same way here
 * and (later) in the native iOS engine. The corpus is language-neutral JSON on
 * purpose so the iOS engine can run the identical cases. Add a case to the
 * corpus whenever you add or change a component; do not change behavior here.
 *
 * Usage: npm test   (or: node scripts/spec-conformance.js)
 * Exits non-zero on any failure so it can gate CI / pre-release.
 */
'use strict';

const path = require('path');
const fs = require('fs');

const AppSpec = require(path.join(__dirname, '..', 'js', 'core', 'app-spec.js'));
const corpusPath = path.join(__dirname, '..', 'tests', 'spec', 'corpus.json');
const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));

const cases = Array.isArray(corpus.cases) ? corpus.cases : [];
let passed = 0;
const failures = [];

for (const tc of cases) {
    const result = AppSpec.validate(tc.spec);
    const want = tc.expect || {};
    const problems = [];

    if (typeof want.valid === 'boolean' && result.ok !== want.valid) {
        problems.push(`expected valid=${want.valid}, got valid=${result.ok}` +
            (result.errors.length ? ` (errors: ${result.errors.join(' | ')})` : ''));
    }
    for (const sub of want.errorIncludes || []) {
        if (!result.errors.some(e => e.includes(sub))) {
            problems.push(`expected an error containing "${sub}", got: ${result.errors.join(' | ') || '(none)'}`);
        }
    }

    if (problems.length) failures.push({ name: tc.name, problems });
    else passed++;
}

// Sanity: the catalog must describe every component the validator knows about,
// so docs/portability/iOS-negotiation can trust it as the contract surface.
const catalog = AppSpec.catalog();
const catalogTypes = new Set(catalog.components.map(c => c.type));
const registryTypes = Object.keys(AppSpec.COMPONENTS);
const missingFromCatalog = registryTypes.filter(t => !catalogTypes.has(t));
if (missingFromCatalog.length) {
    failures.push({ name: 'catalog() covers every component', problems: [`missing: ${missingFromCatalog.join(', ')}`] });
}

// The committed catalog snapshot (tests/spec/catalog.json, what the iOS engine
// reads) must match the live catalog — catch drift, don't let it slip silently.
const snapPath = path.join(__dirname, '..', 'tests', 'spec', 'catalog.json');
try {
    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    if (JSON.stringify(snap) !== JSON.stringify(catalog)) {
        failures.push({ name: 'catalog.json snapshot is current', problems: ['stale — run `npm run catalog:export`'] });
    }
} catch {
    failures.push({ name: 'catalog.json snapshot exists', problems: ['missing — run `npm run catalog:export`'] });
}

console.log(`\nSpec conformance: ${passed}/${cases.length} cases passed` +
    `, ${catalog.components.length} components in catalog (specVersion ${catalog.specVersion}).`);

if (failures.length) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) {
        console.error(`  ✗ ${f.name}`);
        for (const p of f.problems) console.error(`      ${p}`);
    }
    console.error('');
    process.exit(1);
}
console.log('All conformance cases passed.\n');
