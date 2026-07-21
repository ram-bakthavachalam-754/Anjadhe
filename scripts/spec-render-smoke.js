#!/usr/bin/env node
/**
 * Spec render smoke test — exercises the actual rendering + behavior of
 * SpecRenderer (js/core/spec-renderer.js), complementing the validation-only
 * conformance runner. It uses a tiny dependency-free DOM shim (the renderer
 * touches a small, known DOM surface) so it runs under plain `node` with no
 * build step or jsdom.
 *
 * It checks three things the validator can't:
 *   1. every "valid" corpus spec renders without throwing and produces output;
 *   2. computed aggregations + showWhen evaluate correctly against records;
 *   3. button action verbs mutate scoped storage as specified.
 *
 * Usage: node scripts/spec-render-smoke.js   (also run by `npm test`)
 */
'use strict';

const path = require('path');
const fs = require('fs');

// ── Minimal DOM shim ────────────────────────────────────────────────────
function makeEl(tag) {
    const el = {
        tagName: String(tag).toUpperCase(),
        children: [],
        _attrs: {},
        _listeners: {},
        _text: null,
        _className: '',
        style: { setProperty(k, v) { this[k] = v; } },
        classList: {
            _set: new Set(),
            add(...c) { c.forEach(x => this._set.add(x)); },
            remove(...c) { c.forEach(x => this._set.delete(x)); },
            contains(x) { return this._set.has(x); }
        },
        set className(v) { this._className = v; },
        get className() { return this._className; },
        set textContent(v) { this._text = String(v); this.children = []; },
        get textContent() {
            if (this._text != null) return this._text;
            return this.children.map(c => (c && c.textContent) || '').join('');
        },
        set innerHTML(v) { if (v === '') this.children = []; else this._html = v; },
        get innerHTML() { return this._html || ''; },
        setAttribute(k, v) { this._attrs[k] = String(v); },
        getAttribute(k) { return this._attrs[k]; },
        appendChild(c) { this.children.push(c); c.parent = this; return c; },
        append(...cs) { cs.forEach(c => this.appendChild(c)); },
        prepend(c) { this.children.unshift(c); c.parent = this; return c; },
        replaceWith(n) {
            const p = this.parent;
            if (!p) return;
            const i = p.children.indexOf(this);
            if (i >= 0) p.children[i] = n;
            n.parent = p;
        },
        addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
        click() { (this._listeners.click || []).forEach(fn => fn({ stopPropagation() {}, preventDefault() {} })); }
    };
    return el;
}
global.document = {
    createElement: (t) => makeEl(t),
    createElementNS: (_ns, t) => makeEl(t)
};
global.window = { open() {} };

const SpecRenderer = require(path.join(__dirname, '..', 'js', 'core', 'spec-renderer.js'));

function makeStorage(seed) {
    const m = new Map(Object.entries(seed || {}));
    return {
        get(k) { return m.has(k) ? m.get(k) : undefined; },
        set(k, v) { m.set(k, v); },
        delete(k) { m.delete(k); },
        _map: m
    };
}

function walk(node, fn) {
    fn(node);
    for (const c of node.children || []) walk(c, fn);
}

function findByText(root, text) {
    let hit = null;
    walk(root, n => { if (!hit && n._text === text) hit = n; });
    return hit;
}

// ── Tests ───────────────────────────────────────────────────────────────
const failures = [];
let passed = 0;
function check(name, cond, detail) {
    if (cond) passed++;
    else failures.push({ name, detail: detail || '' });
}

// 1. Every valid corpus spec renders without throwing and produces output.
const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tests', 'spec', 'corpus.json'), 'utf8'));
for (const tc of corpus.cases) {
    if (!tc.expect || tc.expect.valid !== true) continue;
    const container = makeEl('div');
    const ctx = { storage: makeStorage(), rerender() {} };
    try {
        SpecRenderer.render(tc.spec, container, ctx);
        check(`renders: ${tc.name}`, container.children.length > 0, 'no output produced');
    } catch (e) {
        check(`renders: ${tc.name}`, false, e.stack || e.message);
    }
}

// 2a. Computed aggregations resolve against records.
{
    const spec = { specVersion: 1, components: [
        { type: 'form', collection: 'expenses', fields: [{ name: 'amount', input: 'number' }] },
        { type: 'stat', label: 'Total', value: { sum: 'expenses', field: 'amount' } }
    ] };
    const container = makeEl('div');
    const ctx = { storage: makeStorage({ 'records:expenses': [{ amount: 10 }, { amount: 5 }, { amount: 20 }] }), rerender() {} };
    SpecRenderer.render(spec, container, ctx);
    check('aggregation: sum renders 35', container.textContent.includes('35'), `got: ${container.textContent}`);
}

// 2b. showWhen hides a component until its condition holds.
{
    const spec = { specVersion: 1, components: [
        { type: 'form', collection: 'tasks', fields: [{ name: 'title' }] },
        { type: 'paragraph', text: 'OPEN_TASKS_MARKER', showWhen: { count: 'tasks', where: { done: false }, op: 'gt', value: 0 } }
    ] };
    const empty = makeEl('div');
    SpecRenderer.render(spec, empty, { storage: makeStorage(), rerender() {} });
    check('showWhen: hidden when count is 0', !empty.textContent.includes('OPEN_TASKS_MARKER'), 'marker showed with no records');

    const filled = makeEl('div');
    SpecRenderer.render(spec, filled, { storage: makeStorage({ 'records:tasks': [{ done: false }] }), rerender() {} });
    check('showWhen: shown when count > 0', filled.textContent.includes('OPEN_TASKS_MARKER'), 'marker hidden despite a matching record');
}

// 3. Button action verbs mutate scoped storage.
{
    const spec = { specVersion: 1, components: [
        { type: 'button', label: 'PLUS', action: { verb: 'increment', collection: 'counter', field: 'count' } },
        { type: 'button', label: 'RESET', action: { verb: 'clear_collection', collection: 'counter' } }
    ] };
    const container = makeEl('div');
    const storage = makeStorage();
    const ctx = { storage, rerender() { SpecRenderer.render(spec, container, ctx); } };
    SpecRenderer.render(spec, container, ctx);

    findByText(container, 'PLUS').click();
    findByText(container, 'PLUS').click();
    let recs = storage.get('records:counter');
    check('action: increment creates + bumps a singleton', Array.isArray(recs) && recs.length === 1 && recs[0].count === 2, `got: ${JSON.stringify(recs)}`);

    findByText(container, 'RESET').click();
    recs = storage.get('records:counter');
    check('action: clear_collection empties it', Array.isArray(recs) && recs.length === 0, `got: ${JSON.stringify(recs)}`);
}

// 3b. add_record appends with the preset values.
{
    const spec = { specVersion: 1, components: [
        { type: 'button', label: 'ADD', action: { verb: 'add_record', collection: 'logs', values: { note: 'hi' } } }
    ] };
    const container = makeEl('div');
    const storage = makeStorage();
    const ctx = { storage, rerender() {} };
    SpecRenderer.render(spec, container, ctx);
    findByText(container, 'ADD').click();
    const recs = storage.get('records:logs');
    check('action: add_record appends preset values', Array.isArray(recs) && recs.length === 1 && recs[0].note === 'hi' && recs[0].id, `got: ${JSON.stringify(recs)}`);
}

// 4. Chart grouping buckets records and aggregates each bucket.
{
    const spec = { specVersion: 1, components: [
        { type: 'form', collection: 'expenses', fields: [{ name: 'category' }, { name: 'amount', input: 'number' }] },
        { type: 'chart', chartType: 'bar', data: { collection: 'expenses', groupBy: 'category', agg: 'sum', field: 'amount' } }
    ] };
    const container = makeEl('div');
    const ctx = { storage: makeStorage({ 'records:expenses': [
        { category: 'food', amount: 10 }, { category: 'food', amount: 5 }, { category: 'rent', amount: 100 }
    ] }), rerender() {} };
    SpecRenderer.render(spec, container, ctx);
    const text = container.textContent;
    check('chart: grouping sums food=15', text.includes('food: 15'), `legend: ${text}`);
    check('chart: grouping sums rent=100', text.includes('rent: 100'), `legend: ${text}`);
}

// ── Report ──────────────────────────────────────────────────────────────
const total = passed + failures.length;
console.log(`\nSpec render smoke: ${passed}/${total} checks passed.`);
if (failures.length) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) {
        console.error(`  ✗ ${f.name}`);
        if (f.detail) console.error(`      ${f.detail}`);
    }
    console.error('');
    process.exit(1);
}
console.log('All render smoke checks passed.\n');
