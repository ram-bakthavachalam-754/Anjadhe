/**
 * SpecRenderer — the fixed engine that renders App Spec v1 documents
 * (js/core/app-spec.js) into live DOM. The renderer plus a spec is a whole
 * app: forms append records to the app's scoped storage, record lists show
 * and delete them, summary values compute over them. Specs are validated
 * before they get here; the renderer still treats every string as untrusted
 * content (textContent, never innerHTML).
 *
 * Grown from the PDF2App component vocabulary (docs/PLATFORM.md Phase 3) —
 * this module is what the iOS shell will ship so spec apps run everywhere.
 *
 * ctx contract: { storage, rerender } — the per-app scoped storage from the
 * Anjadhe SDK and a callback that re-renders the whole view after writes.
 */

const SpecRenderer = {

    render(spec, container, ctx) {
        container.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'spec-app';
        if (spec.title) {
            const h1 = document.createElement('h1');
            h1.className = 'spec-title';
            h1.textContent = spec.title;
            root.appendChild(h1);
        }
        this._renderComponents(spec.components, root, ctx);
        container.appendChild(root);
    },

    /**
     * Compositional entry point used by Anjadhe.Spec.render — appends
     * component output into the given container without wiping it, so code
     * apps can mix Spec components with their own DOM.
     */
    mount(components, container, ctx) {
        const wrap = document.createElement('div');
        wrap.className = 'spec-app';
        this._renderComponents(components, wrap, ctx);
        container.appendChild(wrap);
    },

    _renderComponents(components, parent, ctx) {
        for (const c of components) {
            const el = this._renderComponent(c, ctx);
            if (el) parent.appendChild(el);
        }
    },

    _renderComponent(c, ctx) {
        // Universal visibility gate — any component may carry a showWhen
        // condition; when it fails, the component is simply not rendered.
        if (c.showWhen && !this._passesCondition(c.showWhen, ctx)) return null;
        switch (c.type) {
            case 'paragraph': {
                const p = document.createElement('p');
                p.className = 'spec-paragraph';
                p.textContent = c.text;
                return p;
            }
            case 'section': {
                const sec = document.createElement('section');
                sec.className = 'spec-section';
                if (c.title) {
                    const h = document.createElement('h2');
                    h.className = 'spec-section-title';
                    h.textContent = c.title;
                    sec.appendChild(h);
                }
                this._renderComponents(c.components, sec, ctx);
                return sec;
            }
            case 'divider': {
                const hr = document.createElement('hr');
                hr.className = 'spec-divider';
                return hr;
            }
            case 'card': {
                const card = document.createElement('div');
                card.className = 'spec-card';
                if (c.title) {
                    const h = document.createElement('h3');
                    h.className = 'spec-card-title';
                    h.textContent = c.title;
                    card.appendChild(h);
                }
                this._renderComponents(c.components, card, ctx);
                return card;
            }
            case 'columns': {
                const cols = document.createElement('div');
                cols.className = 'spec-columns';
                const n = Number.isInteger(c.count) ? Math.min(4, Math.max(2, c.count)) : 2;
                cols.style.setProperty('--spec-columns', String(n));
                this._renderComponents(c.components, cols, ctx);
                return cols;
            }
            case 'tabs':
                return this._renderTabs(c, ctx);
            case 'summary_grid': {
                const grid = document.createElement('div');
                grid.className = 'spec-summary-grid';
                for (const item of c.items) {
                    const card = document.createElement('div');
                    card.className = 'spec-summary-card';
                    const value = document.createElement('div');
                    value.className = 'spec-summary-value';
                    value.textContent = this._resolveValue(item.value, ctx);
                    const label = document.createElement('div');
                    label.className = 'spec-summary-label';
                    label.textContent = item.label;
                    card.append(value, label);
                    grid.appendChild(card);
                }
                return grid;
            }
            case 'list': {
                const el = document.createElement(c.ordered ? 'ol' : 'ul');
                el.className = 'spec-list';
                for (const item of c.items) {
                    const li = document.createElement('li');
                    li.textContent = item;
                    el.appendChild(li);
                }
                return el;
            }
            case 'table': {
                const wrap = document.createElement('div');
                wrap.className = 'spec-table-wrap';
                if (c.title) {
                    const h = document.createElement('h3');
                    h.className = 'spec-table-title';
                    h.textContent = c.title;
                    wrap.appendChild(h);
                }
                const table = document.createElement('table');
                table.className = 'spec-table';
                const thead = document.createElement('thead');
                const headRow = document.createElement('tr');
                for (const h of c.headers) {
                    const th = document.createElement('th');
                    th.textContent = h;
                    headRow.appendChild(th);
                }
                thead.appendChild(headRow);
                const tbody = document.createElement('tbody');
                for (const row of c.rows) {
                    const tr = document.createElement('tr');
                    for (const cell of row) {
                        const td = document.createElement('td');
                        td.textContent = String(cell ?? '');
                        tr.appendChild(td);
                    }
                    tbody.appendChild(tr);
                }
                table.append(thead, tbody);
                wrap.appendChild(table);
                return wrap;
            }
            case 'stat': {
                const box = document.createElement('div');
                box.className = 'spec-stat';
                const value = document.createElement('div');
                value.className = 'spec-stat-value';
                value.textContent = this._resolveValue(c.value, ctx);
                const label = document.createElement('div');
                label.className = 'spec-stat-label';
                label.textContent = c.label;
                box.append(value, label);
                if (c.caption) {
                    const cap = document.createElement('div');
                    cap.className = 'spec-stat-caption';
                    cap.textContent = c.caption;
                    box.appendChild(cap);
                }
                return box;
            }
            case 'badge': {
                const tone = ['neutral', 'success', 'warning', 'danger'].includes(c.tone) ? c.tone : 'neutral';
                const b = document.createElement('span');
                b.className = `spec-badge spec-badge-${tone}`;
                b.textContent = c.text;
                return b;
            }
            case 'key_value': {
                const wrap = document.createElement('div');
                wrap.className = 'spec-kv';
                if (c.title) {
                    const h = document.createElement('h3');
                    h.className = 'spec-kv-title';
                    h.textContent = c.title;
                    wrap.appendChild(h);
                }
                for (const item of c.items) {
                    const row = document.createElement('div');
                    row.className = 'spec-kv-row';
                    const l = document.createElement('span');
                    l.className = 'spec-kv-label';
                    l.textContent = item.label;
                    const v = document.createElement('span');
                    v.className = 'spec-kv-value';
                    v.textContent = this._resolveValue(item.value, ctx);
                    row.append(l, v);
                    wrap.appendChild(row);
                }
                return wrap;
            }
            case 'gauge':
                return this._renderGauge(c, ctx);
            case 'timeline': {
                const wrap = document.createElement('div');
                wrap.className = 'spec-timeline';
                if (c.title) {
                    const h = document.createElement('h3');
                    h.className = 'spec-timeline-title';
                    h.textContent = c.title;
                    wrap.appendChild(h);
                }
                const list = document.createElement('div');
                list.className = 'spec-timeline-list';
                for (const item of c.items) {
                    const ev = document.createElement('div');
                    ev.className = 'spec-timeline-item';
                    const dot = document.createElement('span');
                    dot.className = 'spec-timeline-dot';
                    const body = document.createElement('div');
                    body.className = 'spec-timeline-body';
                    const head = document.createElement('div');
                    head.className = 'spec-timeline-head';
                    const label = document.createElement('span');
                    label.className = 'spec-timeline-label';
                    label.textContent = item.label;
                    head.appendChild(label);
                    if (item.time) {
                        const t = document.createElement('span');
                        t.className = 'spec-timeline-time';
                        t.textContent = item.time;
                        head.appendChild(t);
                    }
                    body.appendChild(head);
                    if (item.detail) {
                        const d = document.createElement('div');
                        d.className = 'spec-timeline-detail';
                        d.textContent = item.detail;
                        body.appendChild(d);
                    }
                    ev.append(dot, body);
                    list.appendChild(ev);
                }
                wrap.appendChild(list);
                return wrap;
            }
            case 'button':
                return this._renderButton(c, ctx);
            case 'chart':
                return this._renderChart(c, ctx);
            case 'sparkline':
                return this._renderSparkline(c, ctx);
            case 'image': {
                const fig = document.createElement('figure');
                fig.className = 'spec-image';
                const img = document.createElement('img');
                img.src = c.url;
                img.alt = c.alt || '';
                img.loading = 'lazy';
                fig.appendChild(img);
                if (c.caption) {
                    const cap = document.createElement('figcaption');
                    cap.className = 'spec-image-caption';
                    cap.textContent = c.caption;
                    fig.appendChild(cap);
                }
                return fig;
            }
            case 'icon': {
                const wrap = document.createElement('span');
                wrap.className = 'spec-icon';
                const glyph = document.createElement('span');
                glyph.className = 'spec-icon-glyph';
                // The entity comes from our fixed ICON_GLYPHS map (never user
                // input), so innerHTML here is safe and renders the symbol.
                glyph.innerHTML = this.ICON_GLYPHS[c.name] || '';
                wrap.appendChild(glyph);
                if (c.label) {
                    const l = document.createElement('span');
                    l.className = 'spec-icon-label';
                    l.textContent = c.label;
                    wrap.appendChild(l);
                }
                return wrap;
            }
            case 'form':
                return this._renderForm(c, ctx);
            case 'record_list':
                return this._renderRecordList(c, ctx);
            case 'lookup':
                return this._renderLookup(c, ctx);
            case 'progress':
                return this._renderProgress(c, ctx);
            default:
                return null;
        }
    },

    // Fill every {field} placeholder in a URL from the record (URL-encoded), so
    // a detail.source can call an API that needs several params (e.g. weather:
    // ?latitude={latitude}&longitude={longitude}). Legacy: {key} maps to the
    // record field named by `keyField`.
    _fillUrlTemplate(url, record, keyField) {
        return String(url).replace(/\{(\w+)\}/g, (_m, name) => {
            const v = (name === 'key' && keyField != null) ? record[keyField] : record[name];
            return encodeURIComponent(String(v == null ? '' : v));
        });
    },

    // Dot/index path lookup into an object: _dig(o, 'a.0.b').
    _dig(obj, path) {
        if (path == null || path === '') return obj;
        return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    },

    /* ---- records ------------------------------------------------------ */

    _records(ctx, collection) {
        const all = ctx.storage.get(`records:${collection}`);
        return Array.isArray(all) ? all : [];
    },

    _saveRecords(ctx, collection, records) {
        ctx.storage.set(`records:${collection}`, records);
    },

    // ── Bindings / computed values (mirror of app-spec.js's contract) ────
    _AGGS: ['count', 'sum', 'avg', 'min', 'max'],

    _isComputed(v) {
        return v != null && typeof v === 'object' && this._AGGS.some(a => typeof v[a] === 'string');
    },

    /**
     * Evaluate a computed aggregation to a number:
     *   { count:'books' }                          → number of records
     *   { sum:'expenses', field:'amount' }         → Σ amount
     *   { avg|min|max:'…', field:'…' }             → over a numeric field
     * Optional `where` filters records by exact field match first, so e.g.
     * { count:'books', where:{ status:'read' } } counts only matching records.
     */
    _aggregate(v, ctx) {
        const agg = this._AGGS.find(a => typeof v[a] === 'string');
        if (!agg) return 0;
        let recs = this._records(ctx, v[agg]);
        if (v.where && typeof v.where === 'object') {
            recs = recs.filter(r => Object.entries(v.where).every(([k, val]) => r[k] === val));
        }
        if (agg === 'count') return recs.length;
        const nums = recs.map(r => Number(r[v.field])).filter(n => !Number.isNaN(n));
        if (!nums.length) return 0;
        if (agg === 'sum') return nums.reduce((a, b) => a + b, 0);
        if (agg === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length;
        if (agg === 'min') return Math.min(...nums);
        if (agg === 'max') return Math.max(...nums);
        return 0;
    },

    _resolveValue(value, ctx) {
        if (this._isComputed(value)) {
            const n = this._aggregate(value, ctx);
            return String(Number.isInteger(n) ? n : Math.round(n * 100) / 100);
        }
        return String(value);
    },

    // showWhen: an aggregation compared to a constant. Returns true when the
    // component should render. Unknown ops fail open (render) — the validator
    // already rejects them, so this only guards against a hand-edited spec.
    _passesCondition(cond, ctx) {
        const left = this._aggregate(cond, ctx);
        const right = Number(cond.value);
        switch (cond.op) {
            case 'gt': return left > right;
            case 'gte': return left >= right;
            case 'lt': return left < right;
            case 'lte': return left <= right;
            case 'eq': return left === right;
            case 'ne': return left !== right;
            default: return true;
        }
    },

    // Reserved storage-key prefix for which tab is active in a tabs component.
    // Like _DETAIL_KEY, it lives in scoped storage so the choice survives
    // ctx.rerender (the renderer is otherwise stateless). Keyed by the optional
    // `id`, else by the tab labels, so multiple tabs components stay independent.
    _TABS_KEY: '__spec_tabs:',

    _renderTabs(c, ctx) {
        const wrap = document.createElement('div');
        wrap.className = 'spec-tabs';
        const tabs = Array.isArray(c.tabs) ? c.tabs : [];
        const key = this._TABS_KEY + (c.id || tabs.map(t => t.label).join('|'));
        let active = ctx.storage.get(key);
        if (typeof active !== 'number' || active < 0 || active >= tabs.length) active = 0;

        const bar = document.createElement('div');
        bar.className = 'spec-tabs-bar';
        tabs.forEach((t, i) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'spec-tab' + (i === active ? ' spec-tab-active' : '');
            btn.textContent = t.label;
            btn.addEventListener('click', () => {
                ctx.storage.set(key, i);
                ctx.rerender();
            });
            bar.appendChild(btn);
        });
        wrap.appendChild(bar);

        const panel = document.createElement('div');
        panel.className = 'spec-tab-panel';
        this._renderComponents(tabs[active]?.components || [], panel, ctx);
        wrap.appendChild(panel);
        return wrap;
    },

    // Named-icon glyphs (mirror of app-spec.js ICONS). HTML entities here are
    // engine constants, never user input — the iOS engine maps the same names
    // to SF Symbols.
    ICON_GLYPHS: {
        star: '&#9733;', heart: '&#10084;', check: '&#10003;', x: '&#10005;',
        home: '&#8962;', calendar: '&#128197;', clock: '&#128340;', flag: '&#9873;',
        bell: '&#128276;', bolt: '&#9889;', book: '&#128214;', plus: '&#43;',
        'arrow-up': '&#8593;', 'arrow-down': '&#8595;'
    },

    _svgEl(tag, attrs) {
        const el = document.createElementNS
            ? document.createElementNS('http://www.w3.org/2000/svg', tag)
            : document.createElement(tag);
        if (attrs) for (const k in attrs) el.setAttribute(k, String(attrs[k]));
        return el;
    },

    // Resolve chart.data to [{label, value}]: either a static array or a
    // grouping that buckets a collection's records by a field and aggregates.
    _resolveChartData(d, ctx) {
        if (Array.isArray(d)) return d.map(p => ({ label: String(p.label), value: Number(p.value) || 0 }));
        if (d && typeof d === 'object' && d.collection) {
            let recs = this._records(ctx, d.collection);
            if (d.where && typeof d.where === 'object') {
                recs = recs.filter(r => Object.entries(d.where).every(([k, v]) => r[k] === v));
            }
            const groups = new Map();
            for (const r of recs) {
                const key = String(r[d.groupBy] ?? '—');
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(r);
            }
            const agg = d.agg || 'count';
            const out = [];
            for (const [label, rs] of groups) {
                let value;
                if (agg === 'count') {
                    value = rs.length;
                } else {
                    const nums = rs.map(r => Number(r[d.field])).filter(n => !Number.isNaN(n));
                    value = !nums.length ? 0
                        : agg === 'sum' ? nums.reduce((a, b) => a + b, 0)
                        : agg === 'avg' ? nums.reduce((a, b) => a + b, 0) / nums.length
                        : agg === 'min' ? Math.min(...nums)
                        : agg === 'max' ? Math.max(...nums) : 0;
                }
                out.push({ label, value });
            }
            return out;
        }
        return [];
    },

    // chart — bar/line/area/pie drawn as theme-colored SVG (no external lib, so
    // it ports cleanly to a SwiftUI Shape on the native engine).
    _renderChart(c, ctx) {
        const wrap = document.createElement('div');
        wrap.className = 'spec-chart';
        if (c.title) {
            const h = document.createElement('h3');
            h.className = 'spec-chart-title';
            h.textContent = c.title;
            wrap.appendChild(h);
        }
        const points = this._resolveChartData(c.data, ctx);
        const W = 320, H = 180, pad = 24;
        const svg = this._svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'spec-chart-svg', role: 'img' });

        if (!points.length) {
            const empty = document.createElement('p');
            empty.className = 'spec-records-empty';
            empty.textContent = 'No data yet.';
            wrap.appendChild(empty);
            return wrap;
        }

        const maxV = Math.max(...points.map(p => p.value), 0) || 1;

        if (c.chartType === 'pie') {
            const total = points.reduce((a, p) => a + Math.max(0, p.value), 0) || 1;
            const cx = W / 2, cy = H / 2, r = Math.min(W, H) / 2 - pad;
            let a0 = -Math.PI / 2;
            points.forEach((p, i) => {
                const frac = Math.max(0, p.value) / total;
                const a1 = a0 + frac * 2 * Math.PI;
                const large = frac > 0.5 ? 1 : 0;
                const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
                const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
                const path = this._svgEl('path', {
                    d: `M ${cx} ${cy} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`,
                    class: `spec-chart-slice spec-chart-series-${i % 6}`
                });
                svg.appendChild(path);
                a0 = a1;
            });
        } else if (c.chartType === 'bar') {
            const plotW = W - pad * 2, plotH = H - pad * 2;
            const bw = plotW / points.length;
            points.forEach((p, i) => {
                const h = (Math.max(0, p.value) / maxV) * plotH;
                const x = pad + i * bw + bw * 0.15;
                const rect = this._svgEl('rect', {
                    x: x.toFixed(2), y: (pad + plotH - h).toFixed(2),
                    width: (bw * 0.7).toFixed(2), height: h.toFixed(2),
                    class: 'spec-chart-bar'
                });
                svg.appendChild(rect);
            });
        } else { // line or area
            const plotW = W - pad * 2, plotH = H - pad * 2;
            const stepX = points.length > 1 ? plotW / (points.length - 1) : 0;
            const coords = points.map((p, i) => [
                pad + i * stepX,
                pad + plotH - (Math.max(0, p.value) / maxV) * plotH
            ]);
            if (c.chartType === 'area') {
                const d = `M ${pad} ${pad + plotH} ` +
                    coords.map(([x, y]) => `L ${x.toFixed(2)} ${y.toFixed(2)}`).join(' ') +
                    ` L ${(pad + (points.length - 1) * stepX).toFixed(2)} ${pad + plotH} Z`;
                svg.appendChild(this._svgEl('path', { d, class: 'spec-chart-area' }));
            }
            const line = this._svgEl('polyline', {
                points: coords.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' '),
                class: 'spec-chart-line'
            });
            svg.appendChild(line);
        }
        wrap.appendChild(svg);

        // Legend / axis labels (shared across types) — escaped via textContent.
        const legend = document.createElement('div');
        legend.className = 'spec-chart-legend';
        points.forEach((p, i) => {
            const item = document.createElement('span');
            item.className = `spec-chart-legend-item spec-chart-series-${i % 6}`;
            item.textContent = `${p.label}: ${Number.isInteger(p.value) ? p.value : Math.round(p.value * 100) / 100}`;
            legend.appendChild(item);
        });
        wrap.appendChild(legend);
        return wrap;
    },

    _renderSparkline(c, ctx) {
        const wrap = document.createElement('span');
        wrap.className = 'spec-sparkline';
        let values;
        if (Array.isArray(c.data)) {
            values = c.data.map(Number).filter(n => !Number.isNaN(n));
        } else {
            const d = c.data || {};
            let recs = this._records(ctx, d.collection);
            if (d.where && typeof d.where === 'object') {
                recs = recs.filter(r => Object.entries(d.where).every(([k, v]) => r[k] === v));
            }
            values = recs.map(r => Number(r[d.field])).filter(n => !Number.isNaN(n));
        }
        if (values.length < 2) return wrap;
        const W = 80, H = 20;
        const min = Math.min(...values), max = Math.max(...values);
        const span = max - min || 1;
        const stepX = W / (values.length - 1);
        const pts = values.map((v, i) => `${(i * stepX).toFixed(1)},${(H - ((v - min) / span) * H).toFixed(1)}`).join(' ');
        const svg = this._svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'spec-sparkline-svg' });
        svg.appendChild(this._svgEl('polyline', { points: pts, class: 'spec-chart-line' }));
        wrap.appendChild(svg);
        return wrap;
    },

    // button — runs one bounded action verb (see app-spec.js ACTION_VERBS).
    // Mutating verbs save then rerender; navigate/open_url leave the view.
    _renderButton(c, ctx) {
        const tone = ['neutral', 'success', 'warning', 'danger'].includes(c.tone) ? c.tone : 'neutral';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `spec-button spec-button-${tone}`;
        btn.textContent = c.label;
        btn.addEventListener('click', () => this._runAction(c.action, ctx));
        return btn;
    },

    // The first record of a collection, creating one if the collection is empty.
    // set_field/increment use this so a counter/toggle is a single record the
    // user never has to "add" first. Returns { all, record } — mutate record
    // then save all.
    _singleton(ctx, collection) {
        const all = this._records(ctx, collection);
        if (!all.length) {
            all.push({ id: `r_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`, createdAt: new Date().toISOString() });
        }
        return { all, record: all[0] };
    },

    _runAction(a, ctx) {
        if (!a || typeof a !== 'object') return;
        switch (a.verb) {
            case 'navigate':
                if (typeof Anjadhe !== 'undefined' && Anjadhe.navigate) Anjadhe.navigate(a.app);
                else if (typeof AppManager !== 'undefined' && AppManager.openApp) AppManager.openApp(a.app);
                return; // navigation leaves this view — no rerender
            case 'open_url':
                try { window.open(a.url, '_blank', 'noopener'); } catch { /* blocked — ignore */ }
                return;
            case 'add_record': {
                const recs = this._records(ctx, a.collection);
                recs.push({
                    id: `r_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
                    createdAt: new Date().toISOString(),
                    ...(a.values || {})
                });
                this._saveRecords(ctx, a.collection, recs);
                break;
            }
            case 'clear_collection':
                this._saveRecords(ctx, a.collection, []);
                break;
            case 'set_field': {
                const s = this._singleton(ctx, a.collection);
                s.record[a.field] = a.value;
                this._saveRecords(ctx, a.collection, s.all);
                break;
            }
            case 'increment': {
                const s = this._singleton(ctx, a.collection);
                const cur = Number(s.record[a.field]) || 0;
                s.record[a.field] = cur + (typeof a.by === 'number' ? a.by : 1);
                this._saveRecords(ctx, a.collection, s.all);
                break;
            }
            default:
                return;
        }
        ctx.rerender();
    },

    _renderForm(c, ctx) {
        const form = document.createElement('form');
        form.className = 'spec-form';
        if (c.title) {
            const h = document.createElement('h3');
            h.className = 'spec-form-title';
            h.textContent = c.title;
            form.appendChild(h);
        }
        const inputs = {};
        for (const f of c.fields) {
            const { wrap, input } = this._buildField(f);
            inputs[f.name] = input;
            form.appendChild(wrap);
        }
        const submit = document.createElement('button');
        submit.type = 'submit';
        submit.className = 'spec-form-submit';
        submit.textContent = c.submitLabel || 'Add';
        form.appendChild(submit);

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const record = { id: `r_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`, createdAt: new Date().toISOString() };
            for (const f of c.fields) {
                record[f.name] = this._readField(f, inputs[f.name]);
            }
            const records = this._records(ctx, c.collection);
            records.push(record);
            this._saveRecords(ctx, c.collection, records);
            ctx.rerender();
        });
        return form;
    },

    _buildField(f, currentValue) {
        const kind = f.input || 'text'; // omitted input means plain text
        const wrap = document.createElement('label');
        wrap.className = `spec-field spec-field-${kind}`;
        const caption = document.createElement('span');
        caption.className = 'spec-field-label';
        caption.textContent = f.label || f.name;
        let input;
        if (kind === 'textarea') {
            input = document.createElement('textarea');
            input.rows = 3;
        } else if (kind === 'select') {
            input = document.createElement('select');
            for (const opt of f.options) {
                const o = document.createElement('option');
                o.value = o.textContent = String(opt);
                input.appendChild(o);
            }
        } else {
            input = document.createElement('input');
            input.type = kind === 'checkbox' ? 'checkbox'
                : kind === 'number' ? 'number'
                : kind === 'date' ? 'date' : 'text';
        }
        if (f.required && kind !== 'checkbox') input.required = true;
        if (currentValue !== undefined && currentValue !== null) {
            if (kind === 'checkbox') input.checked = currentValue === true;
            else input.value = String(currentValue);
        }
        if (kind === 'checkbox') {
            wrap.append(input, caption); // checkbox reads better label-after
        } else {
            wrap.append(caption, input);
        }
        return { wrap, input };
    },

    _readField(f, input) {
        const kind = f.input || 'text';
        return kind === 'checkbox' ? input.checked
            : kind === 'number' ? (input.value === '' ? null : Number(input.value))
            : input.value;
    },

    // Reserved storage key holding which record (if any) is open in a detail
    // view: { collection, id }. Lives in the app's scoped storage so it
    // survives ctx.rerender (the renderer is otherwise stateless).
    _DETAIL_KEY: '__spec_detail',

    _renderRecordList(c, ctx) {
        // If this list has a detail view defined and one of its records is
        // open, render the detail instead of the list.
        if (c.detail) {
            const nav = ctx.storage.get(this._DETAIL_KEY);
            if (nav && nav.collection === c.collection && nav.id) {
                return this._renderDetail(c, nav.id, ctx);
            }
        }

        const wrap = document.createElement('div');
        wrap.className = 'spec-records';
        if (c.title) {
            const h = document.createElement('h3');
            h.className = 'spec-records-title';
            h.textContent = c.title;
            wrap.appendChild(h);
        }
        let records = [...this._records(ctx, c.collection)];
        if (c.sort?.by) {
            const dir = c.sort.dir === 'asc' ? 1 : -1;
            records.sort((a, b) => (a[c.sort.by] > b[c.sort.by] ? dir : a[c.sort.by] < b[c.sort.by] ? -dir : 0));
        }
        if (!records.length) {
            const empty = document.createElement('p');
            empty.className = 'spec-records-empty';
            empty.textContent = c.empty || 'Nothing here yet.';
            wrap.appendChild(empty);
            return wrap;
        }
        for (const record of records) {
            const row = document.createElement('div');
            row.className = 'spec-record-row';
            const main = document.createElement('div');
            main.className = 'spec-record-main';
            // With a detail view defined, the row body opens it. Action
            // buttons (status/edit/delete) stopPropagation so they don't.
            if (c.detail) {
                main.classList.add('spec-record-openable');
                main.setAttribute('role', 'button');
                main.addEventListener('click', () => {
                    ctx.storage.set(this._DETAIL_KEY, { collection: c.collection, id: record.id });
                    ctx.rerender();
                });
            }
            const fields = c.fields || Object.keys(record).filter(k => k !== 'id' && k !== 'createdAt');
            const statusName = c.statusField?.name;
            const statusOpts = Array.isArray(c.statusField?.options) ? c.statusField.options : null;
            fields.forEach((name, i) => {
                // A statusField renders as a one-click chip that cycles through
                // its options (e.g. wish → read) — no edit dialog needed.
                if (statusName && statusOpts && name === statusName) {
                    const chip = document.createElement('button');
                    chip.type = 'button';
                    chip.className = 'spec-record-status';
                    const cur = record[name];
                    chip.textContent = (cur != null && cur !== '') ? String(cur) : String(statusOpts[0]);
                    chip.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const idx = statusOpts.indexOf(record[name]);
                        const next = statusOpts[(idx + 1) % statusOpts.length];
                        const recs = this._records(ctx, c.collection);
                        const t = recs.find(r => r.id === record.id);
                        if (t) { t[name] = next; this._saveRecords(ctx, c.collection, recs); ctx.rerender(); }
                    });
                    main.appendChild(chip);
                    return;
                }
                const span = document.createElement('span');
                span.className = i === 0 ? 'spec-record-primary' : 'spec-record-secondary';
                const v = record[name];
                span.textContent = v === true ? '✓' : v === false ? '' : String(v ?? '');
                main.appendChild(span);
            });
            row.appendChild(main);
            const actions = document.createElement('span');
            actions.className = 'spec-record-actions';
            if (Array.isArray(c.editFields) && c.editFields.length) {
                const edit = document.createElement('button');
                edit.type = 'button';
                edit.className = 'spec-record-edit';
                edit.title = 'Edit';
                edit.innerHTML = '&#9998;';
                edit.addEventListener('click', () => {
                    row.replaceWith(this._buildInlineEditor(c, record, ctx));
                });
                actions.appendChild(edit);
            }
            if (c.allowDelete !== false) {
                const del = document.createElement('button');
                del.type = 'button';
                del.className = 'spec-record-delete';
                del.title = 'Remove';
                del.innerHTML = '&times;';
                del.addEventListener('click', () => {
                    this._saveRecords(ctx, c.collection,
                        this._records(ctx, c.collection).filter(r => r.id !== record.id));
                    ctx.rerender();
                });
                actions.appendChild(del);
            }
            if (actions.children.length) row.appendChild(actions);
            wrap.appendChild(row);
        }
        return wrap;
    },

    /**
     * Inline record editor — the row swaps to a prefilled mini-form built
     * from the record_list's editFields. Save updates the record in place;
     * Cancel rerenders (cheap, and guaranteed consistent).
     */
    _buildInlineEditor(c, record, ctx) {
        const form = document.createElement('form');
        form.className = 'spec-record-editor';
        const inputs = {};
        for (const f of c.editFields) {
            const { wrap, input } = this._buildField(f, record[f.name]);
            inputs[f.name] = input;
            form.appendChild(wrap);
        }
        const actions = document.createElement('div');
        actions.className = 'spec-record-editor-actions';
        const save = document.createElement('button');
        save.type = 'submit';
        save.className = 'spec-form-submit';
        save.textContent = 'Save';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'spec-record-editor-cancel';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => ctx.rerender());
        actions.append(save, cancel);
        form.appendChild(actions);

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const records = this._records(ctx, c.collection);
            const target = records.find(r => r.id === record.id);
            if (target) {
                for (const f of c.editFields) {
                    target[f.name] = this._readField(f, inputs[f.name]);
                }
                this._saveRecords(ctx, c.collection, records);
            }
            ctx.rerender();
        });
        return form;
    },

    /**
     * lookup — a search box that autocompletes against a public web API and
     * appends the chosen result to a collection. Reuses the SDK's autocomplete
     * + fetchJson so the declarative spec can express "type a name, pick a
     * match, save it" without any code. Shape:
     *   { type:'lookup', collection, title?, placeholder?,
     *     source: { url:'…{query}…', resultsPath:'docs', label:'title',
     *               fields:{ <recordField>:'<result.path>' } },
     *     defaults?: { status:'wish' } }
     */
    _renderLookup(c, ctx) {
        const wrap = document.createElement('div');
        wrap.className = 'spec-lookup';
        if (c.title) {
            const h = document.createElement('h3');
            h.className = 'spec-lookup-title';
            h.textContent = c.title;
            wrap.appendChild(h);
        }
        const field = document.createElement('div');
        field.className = 'spec-lookup-field';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'spec-lookup-input';
        input.placeholder = c.placeholder || 'Search…';
        field.appendChild(input);
        wrap.appendChild(field);

        const src = c.source || {};
        const hasUi = (typeof Anjadhe !== 'undefined' && Anjadhe.ui && Anjadhe.ui.autocomplete);
        if (hasUi && src.url) {
            Anjadhe.ui.autocomplete(input, {
                search: async (q) => {
                    const url = String(src.url).replace('{query}', encodeURIComponent(q));
                    const data = await Anjadhe.ui.fetchJson(url);
                    const arr = this._dig(data, src.resultsPath);
                    return Array.isArray(arr) ? arr : [];
                },
                renderItem: (it) => String(this._dig(it, src.label) ?? ''),
                onSelect: (it) => {
                    const record = {
                        id: `r_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
                        createdAt: new Date().toISOString()
                    };
                    for (const [target, path] of Object.entries(src.fields || {})) {
                        record[target] = this._dig(it, path);
                    }
                    if (c.defaults && typeof c.defaults === 'object') Object.assign(record, c.defaults);
                    const records = this._records(ctx, c.collection);
                    records.push(record);
                    this._saveRecords(ctx, c.collection, records);
                    ctx.rerender();
                }
            });
        }
        return wrap;
    },

    // progress — a labeled bar. value/max are numbers or { count: collection }
    // (optionally filtered with `where`), so "12 / 30 read" stays declarative.
    _renderProgress(c, ctx) {
        const wrap = document.createElement('div');
        wrap.className = 'spec-progress';
        if (c.label) {
            const l = document.createElement('div');
            l.className = 'spec-progress-label';
            l.textContent = c.label;
            wrap.appendChild(l);
        }
        const val = Number(this._resolveValue(c.value, ctx)) || 0;
        const max = Number(this._resolveValue(c.max, ctx)) || 0;
        const pct = max > 0 ? Math.min(100, Math.round((val / max) * 100)) : 0;
        const bar = document.createElement('div');
        bar.className = 'spec-progress-bar';
        const fill = document.createElement('div');
        fill.className = 'spec-progress-fill';
        fill.style.width = pct + '%';
        bar.appendChild(fill);
        const txt = document.createElement('div');
        txt.className = 'spec-progress-text';
        txt.textContent = `${val} / ${max}`;
        wrap.append(bar, txt);
        return wrap;
    },

    // gauge — a radial version of progress. value/max are numbers or computed
    // aggregations; the dial is a conic-gradient ring (trivially portable to a
    // SwiftUI Circle trim on the native engine).
    _renderGauge(c, ctx) {
        const wrap = document.createElement('div');
        wrap.className = 'spec-gauge';
        const val = Number(this._resolveValue(c.value, ctx)) || 0;
        const max = Number(this._resolveValue(c.max, ctx)) || 0;
        const pct = max > 0 ? Math.min(100, Math.max(0, Math.round((val / max) * 100))) : 0;
        const dial = document.createElement('div');
        dial.className = 'spec-gauge-dial';
        dial.style.setProperty('--spec-gauge-pct', String(pct));
        const center = document.createElement('div');
        center.className = 'spec-gauge-center';
        const v = document.createElement('span');
        v.className = 'spec-gauge-value';
        v.textContent = pct + '%';
        center.appendChild(v);
        dial.appendChild(center);
        wrap.appendChild(dial);
        if (c.label) {
            const l = document.createElement('div');
            l.className = 'spec-gauge-label';
            l.textContent = c.label;
            wrap.appendChild(l);
        }
        return wrap;
    },

    // Detail view for one record of a record_list that defines `detail`.
    // Renders a back button, a heading, and the record's fields as label/value
    // rows. With detail.source it enriches the record from a web API on first
    // open (fetch once, merge mapped fields, mark _detailLoaded), then renders.
    _renderDetail(c, id, ctx) {
        const wrap = document.createElement('div');
        wrap.className = 'spec-detail';

        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'spec-detail-back';
        back.textContent = '← Back';
        back.addEventListener('click', () => {
            ctx.storage.delete(this._DETAIL_KEY);
            ctx.rerender();
        });
        wrap.appendChild(back);

        const record = this._records(ctx, c.collection).find(r => r.id === id);
        if (!record) {
            const p = document.createElement('p');
            p.className = 'spec-records-empty';
            p.textContent = 'This item is no longer here.';
            wrap.appendChild(p);
            return wrap;
        }

        const d = c.detail || {};
        const src = d.source;
        const titleField = d.title || (Array.isArray(d.fields) && d.fields[0]) || (c.fields && c.fields[0]) || 'title';

        const h = document.createElement('h2');
        h.className = 'spec-detail-title';
        h.textContent = String(record[titleField] ?? 'Details');
        wrap.appendChild(h);

        // One-time enrichment from a web API on first open.
        const canFetch = src && typeof Anjadhe !== 'undefined' && Anjadhe.ui && Anjadhe.ui.fetchJson;
        if (canFetch && !record._detailLoaded) {
            const loading = document.createElement('p');
            loading.className = 'spec-detail-loading';
            loading.textContent = 'Loading details…';
            wrap.appendChild(loading);
            const url = this._fillUrlTemplate(src.url, record, src.key);
            const finish = (apply) => {
                const recs = this._records(ctx, c.collection);
                const t = recs.find(r => r.id === id);
                if (!t) return;
                if (apply) apply(t);
                t._detailLoaded = true; // never refetch / loop, even on error
                this._saveRecords(ctx, c.collection, recs);
                ctx.rerender();
            };
            Anjadhe.ui.fetchJson(url).then(data => {
                const obj = src.resultPath ? this._dig(data, src.resultPath) : data;
                finish(t => {
                    for (const [field, path] of Object.entries(src.map || {})) {
                        const v = this._dig(obj, path);
                        if (v !== undefined) t[field] = v;
                    }
                });
            }).catch(() => finish(null));
            return wrap; // the rest fills in after fetch + rerender
        }

        const fields = (Array.isArray(d.fields) && d.fields.length)
            ? d.fields
            : Object.keys(record).filter(k => !['id', 'createdAt', '_detailLoaded'].includes(k));
        const list = document.createElement('div');
        list.className = 'spec-detail-fields';
        for (const name of fields) {
            if (name === titleField) continue;
            const v = record[name];
            if (v == null || v === '') continue;
            const rowEl = document.createElement('div');
            rowEl.className = 'spec-detail-row';
            const label = document.createElement('span');
            label.className = 'spec-detail-label';
            label.textContent = this._prettyLabel(name);
            const val = document.createElement('span');
            val.className = 'spec-detail-value';
            val.textContent = v === true ? 'Yes' : v === false ? 'No' : Array.isArray(v) ? v.join(', ') : String(v);
            rowEl.append(label, val);
            list.appendChild(rowEl);
        }
        wrap.appendChild(list);
        return wrap;
    },

    // "first_publish_year" → "First publish year"
    _prettyLabel(name) {
        return String(name).replace(/[_-]+/g, ' ').replace(/^\w/, ch => ch.toUpperCase());
    }
};

// Loadable as a browser global (index.html <script>) and as a Node module (the
// render smoke harness). Guarded so the browser path is untouched.
if (typeof module !== 'undefined' && module.exports) module.exports = SpecRenderer;
