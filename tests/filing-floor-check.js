#!/usr/bin/env node
/**
 * 12B-floor spot check for the Actions assistant-filing prompt
 * (docs/POSITIONING.md release gate: core AI features must work on a
 * >=12B open-weight model — reference gemma4:12b).
 *
 * Sends the EXACT prompt shape ActionsApp._fileActions uses to a local
 * OpenAI-compatible server (llama-server) and validates: response parses as
 * JSON, the two obvious task->goal mappings land, and the no-signal task
 * maps to "none".
 *
 * Start a server first, e.g.:
 *   llama-server -m ~/.anjadhe_llamacpp/models/<model>.gguf --port 8080 --jinja
 * then:
 *   node tests/filing-floor-check.js            # uses gemma4:12b-it-qat (the shipped default)
 *   FILING_MODEL=llama4-13b FILING_PORT=8080 node tests/filing-floor-check.js
 */

const http = require('http');

const MODEL = process.env.FILING_MODEL || 'gemma4:12b-it-qat';
const PORT = Number(process.env.FILING_PORT) || 8080;
const TODAY = new Date().toISOString().slice(0, 10);

const SYSTEM = `You are a personal task-filing assistant. Today is ${TODAY}.

The user's open goals:
G1: Learn piano — practice daily
G2: File 2025 taxes

For each numbered task below, decide:
- "goal": the goal id (G1, G2, ...) the task CLEARLY serves, or "none". Most everyday tasks serve no listed goal — when unsure, use "none".
- "date": only for tasks marked (no date), and ONLY when the task text clearly implies a timeframe — a specific day, event, or deadline. Format YYYY-MM-DD. Omit "date" otherwise.

Respond ONLY with a JSON object mapping each task number to its verdict, e.g. {"1":{"goal":"G2"},"2":{"goal":"none","date":"${TODAY}"}}.`;

const USER = `1. Book piano lesson (no date)
2. Gather W2 and 1099 forms (no date)
3. Buy stamps (scheduled ${TODAY})`;

const body = JSON.stringify({
    model: MODEL,
    stream: false,
    messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: USER },
    ],
});

const req = http.request(
    { host: '127.0.0.1', port: PORT, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    (res) => {
        let d = '';
        res.on('data', (c) => d += c);
        res.on('end', () => {
            let map;
            try {
                const content = JSON.parse(d).choices[0].message.content;
                map = JSON.parse(content.match(/\{[\s\S]*\}/)[0]);
            } catch (e) {
                console.error(`FAIL  ${MODEL}: response did not parse as JSON`);
                console.error(String(d).slice(0, 300));
                process.exit(1);
            }
            const checks = [
                ['piano task -> G1', map['1']?.goal === 'G1'],
                ['tax-forms task -> G2', map['2']?.goal === 'G2'],
                ['stamps task -> none', (map['3']?.goal || 'none') === 'none'],
            ];
            let fails = 0;
            for (const [name, pass] of checks) {
                console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
                if (!pass) fails++;
            }
            console.log(`\nmodel=${MODEL} verdicts=${JSON.stringify(map)}`);
            process.exit(fails ? 1 : 0);
        });
    }
);
req.on('error', (e) => { console.error(`No OpenAI-compatible server reachable on 127.0.0.1:${PORT} (${e.message})`); process.exit(2); });
req.setTimeout(180000, () => { req.destroy(); console.error('Timed out'); process.exit(2); });
req.end(body);
