/**
 * App Spec (v1) — the cross-engine component contract for declarative spec
 * apps (docs/PLATFORM.md, "Generic apps via a shared component library").
 *
 * A spec app is a user app whose entry is `app.spec.json` instead of `app.js`:
 * pure data rendered by a fixed engine. Because specs are content, not code,
 * the same spec runs on every device that ships a conformant engine — the
 * Mac renderer (`spec-renderer.js`, JS) and the iOS companion (native
 * SwiftUI). This file is the **single source of truth** for what a component
 * is: its type, the shape of its props, and whether it declares a storage
 * collection. Both engines must agree with it, and the shared conformance
 * corpus (`tests/spec/corpus.json`, run by `scripts/spec-conformance.js`)
 * locks that agreement — a component is "shipped" only when it validates here
 * and renders identically in both engines.
 *
 * THE CONTRACT lives in `COMPONENTS` below: one entry per component type, each
 * carrying its category, the spec version it appeared in (`since`), whether it
 * declares a collection, and a `validate()` that checks its props. Adding a
 * component = adding one entry here + a renderer in each engine + corpus cases.
 * Do not grow it casually: every engine, on every platform, must render every
 * component of the current `specVersion`.
 *
 * v1 vocabulary (see each COMPONENTS entry for the prop shape):
 *   paragraph     { text }
 *   section       { title?, components: [...] }
 *   divider       { }
 *   card          { title?, components: [...] }
 *   columns       { count?: 2..4, components: [...] }
 *   tabs          { id?, tabs: [{ label, components: [...] }] }
 *   summary_grid  { items: [{ label, value | value: {count: collection} }] }
 *   list          { items: [string], ordered? }
 *   table         { headers: [string], rows: [[string]], title? }
 *   form          { collection, title?, fields: [{ name, label?, input,
 *                   required?, options? }] }  — appends records
 *   record_list   { collection, title?, fields?: [name], empty?, allowDelete?,
 *                   sort?: { by, dir }, editFields?, detail?, statusField? }
 *   lookup        { collection, source: { url, label, fields, resultsPath? } }
 *   progress      { label?, value, max }
 *   stat          { label, value, caption? }
 *   badge         { text, tone?: neutral|success|warning|danger }
 *   key_value     { title?, items: [{ label, value }] }
 *   gauge         { label?, value, max }   — radial progress
 *   timeline      { title?, items: [{ label, time?, detail? }] }
 *   button        { label, tone?, action: <action> }  — runs one bounded verb:
 *                   navigate | open_url | add_record | set_field | increment |
 *                   clear_collection (set_field/increment hit a singleton record)
 *   chart         { chartType: bar|line|pie|area, title?, data }  — data is a
 *                   [{label, value}] array or a { collection, groupBy, agg?,
 *                   field?, where? } grouping over records
 *   sparkline     { data: [number] | { collection, field, where? } }
 *   image         { url, alt?, caption? }   — http(s) URL
 *   icon          { name, label? }          — a named icon (see ICONS)
 *
 * Bindings/logic (bounded — aggregation-vs-constant, not a general expression
 * language; the Mac-only JS track is the escape hatch for anything richer):
 *   computed value   { count|sum|avg|min|max: "<collection>", field?, where? }
 *                     usable as a summary_grid value or progress value/max
 *   showWhen         { ...computed, op: gt|gte|lt|lte|eq|ne, value: <number> }
 *                     optional on ANY component; hides it unless the condition
 *                     holds (e.g. an "all done" note when remaining eq 0)
 */

const AppSpec = {
    VERSION: 1,
    MAX_COMPONENTS: 100,
    MAX_DEPTH: 4,

    FIELD_INPUTS: new Set(['text', 'textarea', 'number', 'date', 'checkbox', 'select']),
    NAME_RE: /^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/,

    // Bindings/logic vocabulary (deliberately bounded — aggregation-vs-constant,
    // never a general expression language, so it stays reliably generatable and
    // cheap to reimplement identically in the native iOS engine).
    AGGS: ['count', 'sum', 'avg', 'min', 'max'],
    COMPARE_OPS: new Set(['gt', 'gte', 'lt', 'lte', 'eq', 'ne']),

    // ── The component contract ───────────────────────────────────────────
    // Each entry: { category, since, declaresCollection?, validate(c, errors,
    // where, ctx, depth, spec) }. `validate` receives `spec` (this object) so
    // it can reach shared helpers (NAME_RE, _validateFields, recursion) without
    // depending on `this`. Keep prop-validation logic here and nowhere else.
    COMPONENTS: {
        paragraph: {
            category: 'text', since: 1,
            validate(c, errors, where) {
                if (typeof c.text !== 'string') errors.push(`${where}: text must be a string`);
            }
        },

        section: {
            category: 'layout', since: 1,
            validate(c, errors, where, ctx, depth, spec) {
                if (!Array.isArray(c.components)) errors.push(`${where}: components must be an array`);
                else spec._validateComponents(c.components, errors, depth + 1, ctx);
            }
        },

        divider: {
            category: 'layout', since: 1,
            validate() { /* no props */ }
        },

        card: {
            category: 'layout', since: 1,
            validate(c, errors, where, ctx, depth, spec) {
                if (c.title != null && typeof c.title !== 'string') errors.push(`${where}: title must be a string`);
                if (!Array.isArray(c.components)) errors.push(`${where}: components must be an array`);
                else spec._validateComponents(c.components, errors, depth + 1, ctx);
            }
        },

        columns: {
            category: 'layout', since: 1,
            validate(c, errors, where, ctx, depth, spec) {
                if (c.count != null && (!Number.isInteger(c.count) || c.count < 2 || c.count > 4)) {
                    errors.push(`${where}: count must be an integer from 2 to 4`);
                }
                if (!Array.isArray(c.components) || !c.components.length) {
                    errors.push(`${where}: components must be a non-empty array`);
                } else {
                    spec._validateComponents(c.components, errors, depth + 1, ctx);
                }
            }
        },

        tabs: {
            category: 'layout', since: 1,
            validate(c, errors, where, ctx, depth, spec) {
                if (c.id != null && !spec.NAME_RE.test(c.id)) errors.push(`${where}: id must be a short identifier`);
                if (!Array.isArray(c.tabs) || !c.tabs.length) {
                    errors.push(`${where}: tabs must be a non-empty array`);
                    return;
                }
                for (const t of c.tabs) {
                    if (!t || typeof t.label !== 'string') { errors.push(`${where}: each tab needs a label`); continue; }
                    if (!Array.isArray(t.components)) errors.push(`${where}: tab "${t.label}" needs a components array`);
                    else spec._validateComponents(t.components, errors, depth + 1, ctx);
                }
            }
        },

        summary_grid: {
            category: 'data-display', since: 1,
            validate(c, errors, where, ctx, depth, spec) {
                if (!Array.isArray(c.items) || !c.items.length) {
                    errors.push(`${where}: items must be a non-empty array`);
                    return;
                }
                for (const item of c.items) {
                    if (!item || typeof item.label !== 'string') { errors.push(`${where}: each item needs a label`); continue; }
                    const v = item.value;
                    if (v && typeof v === 'object') {
                        spec._validateComputed(v, errors, where, ctx, 'value');
                    } else if (typeof v !== 'string' && typeof v !== 'number') {
                        errors.push(`${where}: item value must be a string, number, or a computed aggregation`);
                    }
                }
            }
        },

        list: {
            category: 'data-display', since: 1,
            validate(c, errors, where) {
                if (!Array.isArray(c.items) || c.items.some(i => typeof i !== 'string')) {
                    errors.push(`${where}: items must be an array of strings`);
                }
            }
        },

        table: {
            category: 'data-display', since: 1,
            validate(c, errors, where) {
                if (!Array.isArray(c.headers) || c.headers.some(h => typeof h !== 'string')) {
                    errors.push(`${where}: headers must be an array of strings`);
                }
                if (!Array.isArray(c.rows) || c.rows.some(r => !Array.isArray(r))) {
                    errors.push(`${where}: rows must be an array of arrays`);
                }
            }
        },

        form: {
            category: 'data-entry', since: 1, declaresCollection: true,
            validate(c, errors, where, ctx, depth, spec) {
                spec._validateCollection(c, errors, where, ctx);
                if (!Array.isArray(c.fields) || !c.fields.length) {
                    errors.push(`${where}: fields must be a non-empty array`);
                    return;
                }
                spec._validateFields(c.fields, errors, where);
            }
        },

        record_list: {
            category: 'data-display', since: 1, declaresCollection: true,
            validate(c, errors, where, ctx, depth, spec) {
                spec._validateCollection(c, errors, where, ctx);
                if (c.fields != null && (!Array.isArray(c.fields) || c.fields.some(f => typeof f !== 'string'))) {
                    errors.push(`${where}: fields must be an array of field names`);
                }
                if (c.sort != null && (typeof c.sort !== 'object' || typeof c.sort.by !== 'string')) {
                    errors.push(`${where}: sort must be { by, dir? }`);
                }
                // editFields enables inline editing — same shape as form fields
                // so the engine knows what inputs to render.
                if (c.editFields != null) {
                    if (!Array.isArray(c.editFields) || !c.editFields.length) {
                        errors.push(`${where}: editFields must be a non-empty array of field definitions`);
                    } else {
                        spec._validateFields(c.editFields, errors, where);
                    }
                }
                // detail: clicking a row opens a detail view of the record;
                // optional source enriches it from a web API on first open.
                if (c.detail != null) {
                    const d = c.detail;
                    if (typeof d !== 'object' || Array.isArray(d)) {
                        errors.push(`${where}: detail must be an object`);
                    } else {
                        if (d.fields != null && (!Array.isArray(d.fields) || d.fields.some(f => typeof f !== 'string'))) {
                            errors.push(`${where}: detail.fields must be an array of field names`);
                        }
                        if (d.title != null && typeof d.title !== 'string') {
                            errors.push(`${where}: detail.title must be a field name`);
                        }
                        if (d.source != null) {
                            const s = d.source;
                            if (typeof s !== 'object' || Array.isArray(s)) {
                                errors.push(`${where}: detail.source must be an object`);
                            } else {
                                // url may use one or more {field} placeholders,
                                // each filled from the opened record (e.g. a
                                // weather call needing {latitude}&{longitude}).
                                // {key} is the legacy single-field form.
                                const phs = (typeof s.url === 'string') ? [...s.url.matchAll(/\{(\w+)\}/g)].map(m => m[1]) : [];
                                if (typeof s.url !== 'string' || !/^https?:\/\//.test(s.url) || !phs.length) {
                                    errors.push(`${where}: detail.source.url must be an http(s) URL with at least one {field} placeholder (e.g. {key} or {latitude})`);
                                }
                                if (phs.includes('key') && !spec.NAME_RE.test(s.key || '')) {
                                    errors.push(`${where}: detail.source.key must name the record field that fills {key}`);
                                }
                                if (!s.map || typeof s.map !== 'object' || !Object.keys(s.map).length) {
                                    errors.push(`${where}: detail.source.map must map record fields to result paths`);
                                }
                            }
                        }
                    }
                }
                // statusField: one field rendered as a click-to-cycle chip.
                if (c.statusField != null) {
                    const sf = c.statusField;
                    if (!sf || !spec.NAME_RE.test(sf.name || '')) {
                        errors.push(`${where}: statusField.name must be a short identifier`);
                    }
                    if (!Array.isArray(sf?.options) || sf.options.length < 2 || sf.options.some(o => typeof o !== 'string')) {
                        errors.push(`${where}: statusField.options must be 2+ strings`);
                    }
                }
            }
        },

        lookup: {
            category: 'integration', since: 1, declaresCollection: true,
            validate(c, errors, where, ctx, depth, spec) {
                spec._validateCollection(c, errors, where, ctx);
                if (!c.source || typeof c.source !== 'object') {
                    errors.push(`${where}: source must be an object { url, resultsPath?, label, fields }`);
                    return;
                }
                if (typeof c.source.url !== 'string' || !/^https?:\/\//.test(c.source.url)) {
                    errors.push(`${where}: source.url must be an http(s) URL containing {query}`);
                } else if (!c.source.url.includes('{query}')) {
                    errors.push(`${where}: source.url must include the {query} placeholder`);
                }
                if (typeof c.source.label !== 'string') {
                    errors.push(`${where}: source.label must be the result field to show (a string path)`);
                }
                if (!c.source.fields || typeof c.source.fields !== 'object' || !Object.keys(c.source.fields).length) {
                    errors.push(`${where}: source.fields must map record fields to result paths`);
                }
                if (c.defaults != null && (typeof c.defaults !== 'object' || Array.isArray(c.defaults))) {
                    errors.push(`${where}: defaults must be an object of fixed field values`);
                }
            }
        },

        progress: {
            category: 'data-display', since: 1,
            validate(c, errors, where, ctx, depth, spec) {
                spec._validateValueMax(c, errors, where, ctx);
            }
        },

        stat: {
            category: 'data-display', since: 1,
            validate(c, errors, where, ctx, depth, spec) {
                if (typeof c.label !== 'string') errors.push(`${where}: label must be a string`);
                spec._validateScalar(c.value, errors, where, ctx);
                if (c.caption != null && typeof c.caption !== 'string') errors.push(`${where}: caption must be a string`);
            }
        },

        badge: {
            category: 'data-display', since: 1,
            validate(c, errors, where) {
                if (typeof c.text !== 'string') errors.push(`${where}: text must be a string`);
                if (c.tone != null && !AppSpec.TONES.includes(c.tone)) {
                    errors.push(`${where}: tone must be ${AppSpec.TONES.join(', ')}`);
                }
            }
        },

        key_value: {
            category: 'data-display', since: 1,
            validate(c, errors, where, ctx, depth, spec) {
                if (c.title != null && typeof c.title !== 'string') errors.push(`${where}: title must be a string`);
                if (!Array.isArray(c.items) || !c.items.length) {
                    errors.push(`${where}: items must be a non-empty array`);
                    return;
                }
                for (const item of c.items) {
                    if (!item || typeof item.label !== 'string') { errors.push(`${where}: each item needs a label`); continue; }
                    spec._validateScalar(item.value, errors, where, ctx);
                }
            }
        },

        gauge: {
            category: 'data-display', since: 1,
            validate(c, errors, where, ctx, depth, spec) {
                spec._validateValueMax(c, errors, where, ctx);
                if (c.label != null && typeof c.label !== 'string') errors.push(`${where}: label must be a string`);
            }
        },

        timeline: {
            category: 'data-display', since: 1,
            validate(c, errors, where) {
                if (c.title != null && typeof c.title !== 'string') errors.push(`${where}: title must be a string`);
                if (!Array.isArray(c.items) || !c.items.length) {
                    errors.push(`${where}: items must be a non-empty array`);
                    return;
                }
                for (const item of c.items) {
                    if (!item || typeof item.label !== 'string') { errors.push(`${where}: each timeline item needs a label`); continue; }
                    if (item.time != null && typeof item.time !== 'string') errors.push(`${where}: timeline item time must be a string`);
                    if (item.detail != null && typeof item.detail !== 'string') errors.push(`${where}: timeline item detail must be a string`);
                }
            }
        },

        button: {
            category: 'interaction', since: 1,
            validate(c, errors, where, ctx, depth, spec) {
                if (typeof c.label !== 'string') errors.push(`${where}: label must be a string`);
                if (c.action == null) errors.push(`${where}: button needs an action`);
                else spec._validateAction(c.action, errors, where, ctx);
                if (c.tone != null && !AppSpec.TONES.includes(c.tone)) {
                    errors.push(`${where}: tone must be ${AppSpec.TONES.join(', ')}`);
                }
            }
        },

        chart: {
            category: 'visualization', since: 1,
            validate(c, errors, where, ctx, depth, spec) {
                if (!AppSpec.CHART_TYPES.includes(c.chartType)) {
                    errors.push(`${where}: chartType must be ${AppSpec.CHART_TYPES.join(', ')}`);
                }
                if (c.title != null && typeof c.title !== 'string') errors.push(`${where}: title must be a string`);
                spec._validateChartData(c.data, errors, where, ctx);
            }
        },

        sparkline: {
            category: 'visualization', since: 1,
            validate(c, errors, where, ctx, depth, spec) {
                const d = c.data;
                if (Array.isArray(d)) {
                    if (!d.length || d.some(n => typeof n !== 'number')) errors.push(`${where}: data must be a non-empty array of numbers`);
                } else if (d && typeof d === 'object') {
                    if (!spec.NAME_RE.test(d.collection || '')) errors.push(`${where}: data.collection must be a collection name`);
                    else if (ctx) ctx.countRefs.push(d.collection);
                    if (!spec.NAME_RE.test(d.field || '')) errors.push(`${where}: data.field must be a numeric field name`);
                    if (d.where != null && (typeof d.where !== 'object' || Array.isArray(d.where))) errors.push(`${where}: data.where must be an object`);
                } else {
                    errors.push(`${where}: data must be an array of numbers or a {collection, field} series`);
                }
            }
        },

        image: {
            category: 'media', since: 1,
            validate(c, errors, where) {
                if (typeof c.url !== 'string' || !/^https?:\/\//.test(c.url)) errors.push(`${where}: url must be an http(s) URL`);
                if (c.alt != null && typeof c.alt !== 'string') errors.push(`${where}: alt must be a string`);
                if (c.caption != null && typeof c.caption !== 'string') errors.push(`${where}: caption must be a string`);
            }
        },

        icon: {
            category: 'media', since: 1,
            validate(c, errors, where) {
                if (!AppSpec.ICONS.includes(c.name)) errors.push(`${where}: name must be one of ${AppSpec.ICONS.join(', ')}`);
                if (c.label != null && typeof c.label !== 'string') errors.push(`${where}: label must be a string`);
            }
        }
    },

    // Allowed badge tones (semantic colors per the design system).
    TONES: ['neutral', 'success', 'warning', 'danger'],

    // The bounded action verbs a button may run (decided 2026-06-17). Anything
    // outside this set is the Mac-only JS escape hatch. Verbs that name a
    // collection also declare it for the cross-check (a counter app needs no
    // form). set_field/increment target a single auto-created record.
    ACTION_VERBS: ['navigate', 'open_url', 'add_record', 'set_field', 'increment', 'clear_collection'],

    CHART_TYPES: ['bar', 'line', 'pie', 'area'],

    // A bounded named-icon set — maps to an HTML entity on Mac and an SF Symbol
    // on iOS. Named (not arbitrary markup) so it's safe and portable.
    ICONS: ['star', 'heart', 'check', 'x', 'home', 'calendar', 'clock', 'flag', 'bell', 'bolt', 'book', 'plus', 'arrow-up', 'arrow-down'],

    // chart.data is either a static [{label, value:number}] array or a computed
    // grouping { collection, groupBy, agg?, field?, where? } that buckets records
    // by a field and aggregates each bucket. The grouping references a collection
    // (must be declared elsewhere), the same cross-check as summary_grid counts.
    _validateChartData(d, errors, where, ctx) {
        if (Array.isArray(d)) {
            if (!d.length) { errors.push(`${where}: data array must be non-empty`); return; }
            for (const p of d) {
                if (!p || typeof p.label !== 'string') errors.push(`${where}: each data point needs a label`);
                else if (typeof p.value !== 'number') errors.push(`${where}: data point "${p.label}" value must be a number`);
            }
        } else if (d && typeof d === 'object') {
            if (!this.NAME_RE.test(d.collection || '')) errors.push(`${where}: data.collection must be a collection name`);
            else if (ctx) ctx.countRefs.push(d.collection);
            if (!this.NAME_RE.test(d.groupBy || '')) errors.push(`${where}: data.groupBy must be a field name`);
            if (d.agg != null && !this.AGGS.includes(d.agg)) errors.push(`${where}: data.agg must be one of ${this.AGGS.join('/')}`);
            if (d.agg && d.agg !== 'count' && !this.NAME_RE.test(d.field || '')) errors.push(`${where}: data.agg ${d.agg} needs a numeric "field"`);
            if (d.where != null && (typeof d.where !== 'object' || Array.isArray(d.where))) errors.push(`${where}: data.where must be an object`);
        } else {
            errors.push(`${where}: data must be an array of {label,value} or a {collection,groupBy} grouping`);
        }
    },

    /**
     * The component catalog — a language-neutral description of the contract,
     * for builder docs, portability classification, and iOS catalog-version
     * negotiation (an engine declares the max specVersion it supports; the
     * loader degrades any component newer than that to a placeholder).
     */
    catalog() {
        return {
            specVersion: this.VERSION,
            components: Object.keys(this.COMPONENTS).map(type => {
                const d = this.COMPONENTS[type];
                return {
                    type,
                    category: d.category,
                    since: d.since || 1,
                    declaresCollection: !!d.declaresCollection
                };
            })
        };
    },

    validate(raw) {
        const errors = [];
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return { ok: false, errors: ['spec must be a JSON object'] };
        }
        if (raw.specVersion !== this.VERSION) {
            errors.push(`specVersion must be ${this.VERSION}`);
        }
        if (raw.title != null && typeof raw.title !== 'string') {
            errors.push('title must be a string');
        }
        if (!Array.isArray(raw.components) || raw.components.length === 0) {
            errors.push('components must be a non-empty array');
        } else {
            const ctx = { n: 0, collections: new Set(), countRefs: [] };
            this._validateComponents(raw.components, errors, 1, ctx);
            if (ctx.n > this.MAX_COMPONENTS) {
                errors.push(`too many components (${ctx.n} > ${this.MAX_COMPONENTS})`);
            }
            // Cross-check every computed aggregation (summary_grid values,
            // progress value/max, showWhen conditions) against declared
            // collections — an aggregation over a collection no form/record_list
            // uses renders a forever-zero card or a never-shown component (live
            // failure mode: a generated app counted "entries.content", a dotted
            // path, not a collection).
            for (const ref of ctx.countRefs) {
                if (!ctx.collections.has(ref)) {
                    errors.push(`computed aggregation "${ref}" must exactly match a collection used by a form or record_list (${[...ctx.collections].join(', ') || 'none declared'})`);
                }
            }
        }
        return { ok: errors.length === 0, errors };
    },

    _validateComponents(components, errors, depth, ctx) {
        if (depth > this.MAX_DEPTH) {
            errors.push(`sections nested deeper than ${this.MAX_DEPTH}`);
            return;
        }
        for (const c of components) {
            ctx.n++;
            if (!c || typeof c !== 'object') { errors.push('component must be an object'); continue; }
            const where = `${c.type || '?'}`;
            const def = this.COMPONENTS[c.type];
            if (!def) { errors.push(`unknown component type "${c.type}"`); continue; }
            def.validate(c, errors, where, ctx, depth, this);
            // showWhen is universal — any component may carry a visibility
            // condition, validated and cross-checked the same way everywhere.
            if (c.showWhen != null) this._validateShowWhen(c.showWhen, errors, where, ctx);
        }
    },

    /**
     * A computed aggregation: { <agg>: "<collection>", field?, where? } where
     * <agg> is one of count/sum/avg/min/max. count needs no field; the others
     * aggregate a numeric record field. `where` filters records by exact field
     * match. `label` names the slot in error messages (e.g. "value", "max",
     * "showWhen"). Registers the collection for the cross-check. Returns the
     * aggregation name, or null if the shape is invalid.
     */
    _validateComputed(v, errors, where, ctx, label) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
            errors.push(`${where}: ${label} must be a computed aggregation object`);
            return null;
        }
        const present = this.AGGS.filter(a => v[a] !== undefined);
        if (present.length !== 1) {
            errors.push(`${where}: ${label} must have exactly one of ${this.AGGS.join('/')}`);
            return null;
        }
        const agg = present[0];
        const collection = v[agg];
        if (typeof collection !== 'string' || !this.NAME_RE.test(collection)) {
            errors.push(`${where}: ${label} ${agg} must be a bare collection name (no dots or paths), got "${collection}"`);
            return null;
        }
        if (ctx) ctx.countRefs.push(collection);
        if (agg !== 'count' && !this.NAME_RE.test(v.field || '')) {
            errors.push(`${where}: ${label} ${agg} needs a numeric "field" to aggregate`);
        }
        if (v.where != null && (typeof v.where !== 'object' || Array.isArray(v.where))) {
            errors.push(`${where}: ${label} where must be an object of field:value filters`);
        }
        return agg;
    },

    // A button action: one bounded verb (see ACTION_VERBS). Verbs that name a
    // collection register it as declared, so a counter/toggle app needs no
    // form or record_list to satisfy the cross-check.
    _validateAction(a, errors, where, ctx) {
        if (!a || typeof a !== 'object' || Array.isArray(a)) {
            errors.push(`${where}: action must be an object`);
            return;
        }
        if (!this.ACTION_VERBS.includes(a.verb)) {
            errors.push(`${where}: action.verb must be one of ${this.ACTION_VERBS.join(', ')}`);
            return;
        }
        const declareCollection = () => {
            if (!this.NAME_RE.test(a.collection || '')) {
                errors.push(`${where}: ${a.verb} action needs a "collection" name`);
            } else if (ctx) {
                ctx.collections.add(a.collection);
            }
        };
        switch (a.verb) {
            case 'navigate':
                if (typeof a.app !== 'string' || !a.app) errors.push(`${where}: navigate action needs an "app" id`);
                break;
            case 'open_url':
                if (typeof a.url !== 'string' || !/^https?:\/\//.test(a.url)) errors.push(`${where}: open_url action needs an http(s) "url"`);
                break;
            case 'add_record':
                declareCollection();
                if (!a.values || typeof a.values !== 'object' || Array.isArray(a.values)) errors.push(`${where}: add_record action needs a "values" object`);
                break;
            case 'clear_collection':
                declareCollection();
                break;
            case 'set_field':
                declareCollection();
                if (!this.NAME_RE.test(a.field || '')) errors.push(`${where}: set_field action needs a "field"`);
                if (!('value' in a)) errors.push(`${where}: set_field action needs a "value"`);
                break;
            case 'increment':
                declareCollection();
                if (!this.NAME_RE.test(a.field || '')) errors.push(`${where}: increment action needs a "field"`);
                if (a.by != null && typeof a.by !== 'number') errors.push(`${where}: increment action "by" must be a number`);
                break;
        }
    },

    // A scalar display value: a string, a number, or a computed aggregation.
    // Shared by stat and key_value (and the same shape summary_grid items use).
    _validateScalar(v, errors, where, ctx) {
        if (v && typeof v === 'object') {
            this._validateComputed(v, errors, where, ctx, 'value');
        } else if (typeof v !== 'string' && typeof v !== 'number') {
            errors.push(`${where}: value must be a string, number, or a computed aggregation`);
        }
    },

    // Shared value/max contract for progress and gauge: each is a number or a
    // computed aggregation; a missing one is an error.
    _validateValueMax(c, errors, where, ctx) {
        for (const key of ['value', 'max']) {
            const v = c[key];
            if (v == null) {
                errors.push(`${where}: needs value and max (numbers or a computed aggregation)`);
            } else if (typeof v === 'object') {
                this._validateComputed(v, errors, where, ctx, key);
            } else if (typeof v !== 'number') {
                errors.push(`${where}: ${key} must be a number or a computed aggregation`);
            }
        }
    },

    /**
     * showWhen: an aggregation compared to a constant. Bounded on purpose —
     * aggregation-vs-constant only, no arbitrary expressions — so it generates
     * reliably and ports cleanly to the native engine.
     */
    _validateShowWhen(sw, errors, where, ctx) {
        const agg = this._validateComputed(sw, errors, where, ctx, 'showWhen');
        if (agg == null) return;
        if (!this.COMPARE_OPS.has(sw.op)) {
            errors.push(`${where}: showWhen.op must be one of ${[...this.COMPARE_OPS].join(', ')}`);
        }
        if (typeof sw.value !== 'number') {
            errors.push(`${where}: showWhen.value must be a number`);
        }
    },

    _validateFields(fields, errors, where) {
        for (const f of fields) {
            if (!f || !this.NAME_RE.test(f.name || '')) errors.push(`${where}: field name must match ${this.NAME_RE}`);
            // input is optional — omitted means a plain text field. Models
            // drop it constantly; defaulting beats a retry round.
            const input = f?.input == null ? 'text' : f.input;
            if (!this.FIELD_INPUTS.has(input)) errors.push(`${where}: field input must be one of ${[...this.FIELD_INPUTS].join(', ')}`);
            if (input === 'select' && (!Array.isArray(f.options) || !f.options.length)) {
                errors.push(`${where}: select field needs options`);
            }
        }
    },

    _validateCollection(c, errors, where, ctx) {
        if (!this.NAME_RE.test(c.collection || '')) {
            errors.push(`${where}: collection must be a short identifier`);
        } else if (ctx) {
            ctx.collections.add(c.collection);
        }
    }
};

// Loadable both as a browser global (index.html <script>) and as a Node module
// (the conformance runner). Guarded so the browser path is untouched.
if (typeof module !== 'undefined' && module.exports) module.exports = AppSpec;
