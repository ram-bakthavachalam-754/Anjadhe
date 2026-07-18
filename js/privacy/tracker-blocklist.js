/**
 * Tracker blocklist — main-process only.
 *
 * Pulls EasyPrivacy + EasyList from filterlists.com on first run, parses
 * the domain-anchor subset of Adblock Plus syntax, and caches the result
 * to userData/privacy/blocklist.json. Refreshes on a 7-day cadence
 * lazily — we don't block app startup waiting for network.
 *
 * We deliberately implement only the simplest filter form:
 *   ||example.com^...     → block requests to example.com (and subdomains)
 *   @@||example.com^...   → exception (allowlist)
 * Everything else (URL patterns, $domain= options, element-hiding rules,
 * regex filters) is skipped. This covers ~95% of real-world tracker
 * blocking with O(1) hostname lookup and zero per-request regex cost.
 *
 * The built-in fallback list seeds the Set on the very first run before
 * the network fetch returns, so the feature works offline from minute one.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const SOURCES = [
    'https://easylist.to/easylist/easyprivacy.txt',
    'https://easylist.to/easylist/easylist.txt'
];
const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_FILENAME = 'blocklist.json';
// Bump when parseList semantics change so older caches with bad entries
// (e.g. path-anchored rules that we used to mis-handle as host blocks)
// are discarded and rebuilt on next launch.
const PARSER_VERSION = 2;

// Trackers we want blocked from minute one, before any network fetch
// returns. Curated from the worst offenders in EasyPrivacy plus the
// specific user-sync pixels we've seen leak into our renderer console.
const BUILTIN_BLOCKED_HOSTS = [
    'doubleclick.net', 'googletagmanager.com', 'google-analytics.com',
    'googlesyndication.com', 'googleadservices.com', 'adservice.google.com',
    'adnxs.com', 'rubiconproject.com', 'pubmatic.com', 'adsrvr.org',
    'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com',
    'scorecardresearch.com', 'quantserve.com', 'amazon-adsystem.com',
    'connect.facebook.net', 'facebook.net', 'iqzone.com',
    'gammaplatform.com', 'casalemedia.com', 'openx.net', 'sovrn.com',
    'serving-sys.com', '2mdn.net', 'moatads.com', 'segment.com',
    'segment.io', 'mixpanel.com', 'fullstory.com', 'hotjar.com',
    'heap.io', 'mouseflow.com', 'optimizely.com', 'newrelic.com',
    'bugsnag.com', 'indexww.com', 'bidswitch.net', 'mathtag.com',
    'krxd.net', 'demdex.net', 'everesttech.net', 'adform.net',
    'smartadserver.com', 'yieldmo.com', 'liadm.com', 'bluekai.com',
    'agkn.com', 'tapad.com', 'analytics.twitter.com', 'ads-twitter.com',
    'analytics.tiktok.com', 'adsymptotic.com', 'sharethis.com',
    'addthis.com', 'go-mpulse.net', 'hs-analytics.net', 'hs-banner.com',
    'pardot.com', 'marketo.com', 'mktoresp.com'
];

const _state = {
    blockedHosts: new Set(),
    exceptionHosts: new Set(),
    fetchedAt: 0,
    sourcesLoaded: 0,
    initialized: false
};

let _userDataDir = null;

function _cachePath() {
    if (!_userDataDir) throw new Error('tracker-blocklist not initialized');
    return path.join(_userDataDir, 'privacy', CACHE_FILENAME);
}

function _readCache() {
    try {
        const raw = fs.readFileSync(_cachePath(), 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed;
    } catch { return null; }
}

function _writeCache(payload) {
    try {
        const dir = path.dirname(_cachePath());
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(_cachePath(), JSON.stringify(payload));
    } catch (e) {
        console.warn('[privacy] cache write failed:', e.message);
    }
}

// Hard cap on a single source response. EasyPrivacy + EasyList combined are
// ~5 MB raw today; 10 MB leaves headroom while preventing a hostile or
// hijacked endpoint from buffering arbitrarily large bodies into memory.
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;

function _fetch(url, redirectsLeft = MAX_REDIRECTS, originHost = null) {
    return new Promise((resolve, reject) => {
        let parsed;
        try { parsed = new URL(url); } catch { return reject(new Error('invalid URL')); }
        if (parsed.protocol !== 'https:') return reject(new Error('only https URLs accepted'));
        if (!originHost) originHost = parsed.hostname;

        const req = https.get(url, { timeout: 20000 }, (res) => {
            // Follow a bounded number of redirects, but only to the same
            // host and only over https. A compromised/MITM'd redirect
            // header would otherwise let the response come from any
            // attacker-chosen origin — and the result of that response
            // becomes a live host-blocking rule set.
            if (res.statusCode >= 300 && res.statusCode < 400) {
                res.resume();
                if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
                const loc = res.headers.location;
                if (!loc) return reject(new Error('redirect with no location'));
                let next;
                try { next = new URL(loc, url); } catch { return reject(new Error('bad redirect URL')); }
                if (next.protocol !== 'https:') return reject(new Error('redirect to non-https refused'));
                if (next.hostname !== originHost) return reject(new Error(`redirect to different host refused: ${next.hostname}`));
                return _fetch(next.toString(), redirectsLeft - 1, originHost).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`status ${res.statusCode}`));
            }
            const chunks = [];
            let total = 0;
            let aborted = false;
            res.on('data', (c) => {
                if (aborted) return;
                total += c.length;
                if (total > MAX_RESPONSE_BYTES) {
                    aborted = true;
                    res.destroy();
                    reject(new Error(`response exceeded ${MAX_RESPONSE_BYTES} bytes`));
                    return;
                }
                chunks.push(c);
            });
            res.on('end', () => {
                if (aborted) return;
                resolve(Buffer.concat(chunks).toString('utf8'));
            });
            res.on('error', (e) => { if (!aborted) reject(e); });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
    });
}

/**
 * Parse Adblock Plus filter list text. Returns Sets of hostnames to
 * block and to exempt. Only domain-anchor rules are honored.
 */
function parseList(text) {
    const blocked = new Set();
    const exceptions = new Set();
    if (!text) return { blocked, exceptions };

    const lines = text.split(/\r?\n/);
    for (let raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('!') || line.startsWith('[')) continue;
        // Element-hiding / scriptlet rules — out of scope.
        if (line.includes('##') || line.includes('#@#') || line.includes('#?#') || line.includes('#$#')) continue;

        let body = line;
        let isException = false;
        if (body.startsWith('@@')) {
            isException = true;
            body = body.slice(2);
        }

        // Only domain-anchor rules: ||host[^|/$...]
        if (!body.startsWith('||')) continue;
        const rest = body.slice(2);

        // Accept ONLY host-anchored rules — the host must be followed by
        // `^` (separator placeholder), `$` (start of options), or end of
        // line. Path- and pattern-anchored rules (||host/path, ||host*)
        // need per-URL matching we don't model; treating their bare host
        // as a wholesale block would catch unrelated paths on the same
        // host (e.g. ||bbci.co.uk/plugins/dfpAdsHTML/ would otherwise
        // block every image on bbci.co.uk).
        const hostMatch = rest.match(/^([a-z0-9.\-]+)([\^$]|$)/i);
        if (!hostMatch) continue;
        const host = hostMatch[1].toLowerCase();
        if (host.length < 4 || !host.includes('.')) continue;
        if (host.startsWith('.') || host.endsWith('.')) continue;

        // After `^`, only an `$opts` block or end-of-rule is allowed —
        // anything else means there's still path/pattern content
        // (e.g. ||bbc.co.uk^*/adverts.js, ||host^/api). Skip those so
        // we don't claim a whole host on the strength of one path rule.
        if (hostMatch[2] === '^') {
            const after = rest.slice(hostMatch[0].length);
            if (after && !after.startsWith('$')) continue;
        }

        // Skip rules with a $domain= modifier — those scope the block to
        // specific embedding sites and we don't model that. Blocking
        // unconditionally would be too aggressive.
        const optsIdx = rest.indexOf('$');
        if (optsIdx >= 0) {
            const opts = rest.slice(optsIdx + 1);
            if (/(^|,)domain=/i.test(opts)) continue;
            // Also skip rules scoped to specific resource types we can't
            // reliably classify (subdocument-only rules etc.).
            if (/(^|,)~third-party(,|$)/i.test(opts)) continue;
        }

        (isException ? exceptions : blocked).add(host);
    }
    return { blocked, exceptions };
}

function _hostMatches(host, set) {
    if (!host || !set.size) return false;
    let h = host;
    while (true) {
        if (set.has(h)) return true;
        const dot = h.indexOf('.');
        if (dot < 0) return false;
        h = h.slice(dot + 1);
        if (!h.includes('.')) {
            return set.has(h);
        }
    }
}

/**
 * @returns {boolean} true if the URL's host is on the blocklist (and not
 *   on the exception list).
 */
function isBlocked(url) {
    try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        const host = u.hostname.toLowerCase();
        if (_hostMatches(host, _state.exceptionHosts)) return false;
        return _hostMatches(host, _state.blockedHosts);
    } catch { return false; }
}

async function _refresh() {
    const merged = { blocked: new Set(), exceptions: new Set() };
    let sourcesLoaded = 0;
    for (const url of SOURCES) {
        try {
            const text = await _fetch(url);
            const { blocked, exceptions } = parseList(text);
            for (const h of blocked) merged.blocked.add(h);
            for (const h of exceptions) merged.exceptions.add(h);
            sourcesLoaded++;
        } catch (e) {
            console.warn(`[privacy] fetch failed for ${url}:`, e.message);
        }
    }
    // Sanity floor. EasyPrivacy alone produces several thousand host
    // rules after parsing; a successful run that yields fewer than this
    // means the response was truncated, malformed, or replaced by a
    // mostly-empty body. Refuse to overwrite the cache (and the live
    // _state) with a degenerate list — the existing cache stays valid
    // for up to 7 days and a failed refresh is preferable to silently
    // weakened protection.
    const MIN_PARSED_RULES = 1000;
    if (merged.blocked.size < MIN_PARSED_RULES) {
        throw new Error(`too few rules parsed (${merged.blocked.size} < ${MIN_PARSED_RULES})`);
    }

    // Always keep the built-ins merged in — they're the safety net for
    // user-sync pixels EasyPrivacy occasionally misses.
    for (const h of BUILTIN_BLOCKED_HOSTS) merged.blocked.add(h);

    _state.blockedHosts = merged.blocked;
    _state.exceptionHosts = merged.exceptions;
    _state.fetchedAt = Date.now();
    _state.sourcesLoaded = sourcesLoaded;

    _writeCache({
        parserVersion: PARSER_VERSION,
        fetchedAt: _state.fetchedAt,
        sourcesLoaded: _state.sourcesLoaded,
        blocked: Array.from(merged.blocked),
        exceptions: Array.from(merged.exceptions)
    });
    console.log(`[privacy] refreshed blocklist: ${merged.blocked.size} blocked / ${merged.exceptions.size} exceptions from ${sourcesLoaded}/${SOURCES.length} sources`);
}

/**
 * Initialize the blocklist. Reads cache synchronously so blocking is
 * effective on the very first request, then kicks off a background
 * refresh if the cache is stale (or absent).
 */
function init(userDataDir) {
    if (_state.initialized) return;
    _userDataDir = userDataDir;

    const cache = _readCache();
    const cacheUsable = cache
        && Array.isArray(cache.blocked)
        && cache.blocked.length
        && Number(cache.parserVersion) === PARSER_VERSION;
    if (cacheUsable) {
        _state.blockedHosts = new Set(cache.blocked);
        _state.exceptionHosts = new Set(cache.exceptions || []);
        _state.fetchedAt = Number(cache.fetchedAt) || 0;
        _state.sourcesLoaded = Number(cache.sourcesLoaded) || 0;
        const ageH = Math.round((Date.now() - _state.fetchedAt) / 3600000);
        console.log(`[privacy] loaded cached blocklist: ${_state.blockedHosts.size} hosts (age ${ageH}h)`);
    } else {
        for (const h of BUILTIN_BLOCKED_HOSTS) _state.blockedHosts.add(h);
        if (cache && Number(cache.parserVersion) !== PARSER_VERSION) {
            console.log(`[privacy] cache parser version mismatch (cached=${cache.parserVersion}, current=${PARSER_VERSION}); rebuilding from sources`);
        } else {
            console.log(`[privacy] no cache; seeded ${_state.blockedHosts.size} built-in hosts`);
        }
    }

    _state.initialized = true;

    const stale = !cacheUsable || (Date.now() - _state.fetchedAt) > REFRESH_INTERVAL_MS;
    if (stale) {
        _refresh().catch((e) => console.warn('[privacy] refresh failed:', e.message));
    }
}

function stats() {
    return {
        blockedHosts: _state.blockedHosts.size,
        exceptionHosts: _state.exceptionHosts.size,
        fetchedAt: _state.fetchedAt,
        sourcesLoaded: _state.sourcesLoaded
    };
}

module.exports = { init, isBlocked, parseList, stats };
