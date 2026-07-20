const { spawn, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');

const OllamaManager = {
    process: null,
    port: 11434,
    isReady: false,
    _quitting: false,
    _restartAttempted: false,

    /**
     * Find the system-installed Ollama binary, or null if not installed.
     *
     * `which ollama` works fine when launched from a terminal (shell PATH is
     * populated) but returns nothing when launched from Finder, because macOS
     * gives GUI apps a stripped PATH (`/usr/bin:/bin:/usr/sbin:/sbin`). After
     * the PATH lookup fails we fall back to checking the standard install
     * locations explicitly so the packaged .app can still find Ollama.
     */
    getBinaryPath() {
        // 1. Try PATH lookup first (works for npm start / terminal launches
        //    and respects user's custom installs)
        try {
            const cmd = process.platform === 'win32' ? 'where ollama' : 'which ollama';
            const systemPath = execSync(cmd, { encoding: 'utf8' }).trim().split('\n')[0];
            if (systemPath && fs.existsSync(systemPath)) {
                return systemPath;
            }
        } catch {}

        // 2. Fall back to well-known install locations
        const candidates = process.platform === 'win32'
            ? [
                'C:\\Program Files\\Ollama\\ollama.exe',
                `${process.env.LOCALAPPDATA || ''}\\Programs\\Ollama\\ollama.exe`
              ]
            : [
                '/Applications/Ollama.app/Contents/Resources/ollama',  // macOS desktop app (admin install)
                path.join(os.homedir(), 'Applications/Ollama.app/Contents/Resources/ollama'), // user-scope install
                '/opt/homebrew/bin/ollama',                              // Homebrew Apple Silicon
                '/usr/local/bin/ollama',                                 // Homebrew Intel / manual
                '/usr/bin/ollama'                                        // System install
              ];
        for (const candidate of candidates) {
            if (candidate && fs.existsSync(candidate)) return candidate;
        }
        return null;
    },

    /**
     * Check if something is listening on a port and responding as Ollama
     */
    _checkPort(port) {
        return new Promise((resolve) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port,
                path: '/api/tags',
                method: 'GET',
                timeout: 2000
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        resolve(parsed.models ? 'ollama' : 'other');
                    } catch {
                        resolve('other');
                    }
                });
            });
            req.on('error', () => resolve('free'));
            req.on('timeout', () => { req.destroy(); resolve('free'); });
            req.end();
        });
    },

    /**
     * Wait for Ollama to become ready after spawning
     */
    async _waitForReady(port, retries = 20) {
        for (let i = 0; i < retries; i++) {
            const status = await this._checkPort(port);
            if (status === 'ollama') return true;
            await new Promise(r => setTimeout(r, 500));
        }
        return false;
    },

    /**
     * Spawn the Ollama process on a given port.
     *
     * OLLAMA_NUM_PARALLEL controls how many requests Ollama serves concurrently
     * for a single model. Default is 1, which serializes everything — bad for
     * the AI assistant since the user can have multiple chats streaming at
     * once. We set it to 2: enough to let the agent stream while email
     * analysis runs in the background, without reserving KV cache for four
     * rarely-used slots. Each parallel slot needs its own KV cache allocation
     * (~0.5-1 GB at num_ctx 8192 with q8_0), so on a 16GB Mac, 4 slots stole
     * unified memory from the model weights and caused swapping. Users with
     * more memory (32GB+) can bump this back up via the env var.
     *
     * OLLAMA_FLASH_ATTENTION enables the fused flash-attention kernel. It ships
     * off by default in Ollama but on most modern models on Metal/CUDA it
     * roughly 1.5–2x prompt-eval throughput — which is exactly the path our
     * agent chat hits hardest (big system prompt + tool definitions on every
     * first message). Gen speed is unchanged. If a specific model doesn't
     * support it, Ollama logs a warning at load time and falls back to stock
     * attention silently, so it's safe to leave on for every model.
     *
     * OLLAMA_KV_CACHE_TYPE=q8_0 quantizes the KV cache to 8-bit instead of 16.
     * Halves KV memory per slot (so multi-slot parallelism stays affordable) and
     * is slightly faster in the cache path. Quality difference is imperceptible
     * for chat. Both flags are opt-in overridable via the environment so power
     * users can turn them off.
     */
    _spawn(binaryPath, port) {
        const env = {
            ...process.env,
            OLLAMA_HOST: `127.0.0.1:${port}`,
            OLLAMA_NUM_PARALLEL: process.env.OLLAMA_NUM_PARALLEL || '2',
            OLLAMA_FLASH_ATTENTION: process.env.OLLAMA_FLASH_ATTENTION || '1',
            OLLAMA_KV_CACHE_TYPE: process.env.OLLAMA_KV_CACHE_TYPE || 'q8_0'
        };

        const child = spawn(binaryPath, ['serve'], {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false
        });

        child.stdout.on('data', (data) => {
            console.log('[ollama]', data.toString().trim());
        });
        child.stderr.on('data', (data) => {
            console.log('[ollama]', data.toString().trim());
        });

        child.on('exit', (code) => {
            console.log(`[ollama] Process exited with code ${code}`);
            this.process = null;
            this.isReady = false;

            // Auto-restart once on unexpected exit
            if (!this._quitting && code !== 0 && !this._restartAttempted) {
                this._restartAttempted = true;
                console.log('[ollama] Attempting restart in 2s...');
                setTimeout(() => this._trySpawn(binaryPath, port), 2000);
            }
        });

        return child;
    },

    /**
     * Spawn and wait for readiness
     */
    async _trySpawn(binaryPath, port) {
        this.process = this._spawn(binaryPath, port);
        const ready = await this._waitForReady(port);
        if (ready) {
            this.port = port;
            this.isReady = true;
            console.log(`[ollama] Ready on port ${port}`);
        } else {
            console.log('[ollama] Failed to become ready');
            if (this.process) {
                this.process.kill();
                this.process = null;
            }
        }
        return ready;
    },

    /**
     * Start Ollama — detect running instance or spawn system binary
     */
    async start() {
        // Check if Ollama is already running
        const status = await this._checkPort(11434);
        if (status === 'ollama') {
            console.log('[ollama] Instance detected on port 11434 (managed by something else — we cannot control its OLLAMA_NUM_PARALLEL setting). If parallel chats serialize, quit the external Ollama and let this app spawn it.');
            this.port = 11434;
            this.isReady = true;
            return true;
        }

        // Try to start the system-installed binary
        const binaryPath = this.getBinaryPath();
        if (!binaryPath) {
            console.log('[ollama] Not installed — visit ollama.com/download to install');
            return false;
        }

        // Find an available port
        const startPort = status === 'free' ? 11434 : 11435;
        for (let port = startPort; port <= 11440; port++) {
            if (port !== 11434) {
                const portStatus = await this._checkPort(port);
                if (portStatus !== 'free') continue;
            }
            const success = await this._trySpawn(binaryPath, port);
            if (success) return true;
        }

        console.log('[ollama] Could not start on any port (11434-11440)');
        return false;
    },

    /**
     * Stop the managed Ollama process
     */
    stop() {
        this._quitting = true;
        if (this.process) {
            console.log('[ollama] Stopping managed process');
            this.process.kill('SIGTERM');
            const pid = this.process.pid;
            setTimeout(() => {
                try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {}
            }, 5000);
            this.process = null;
        }
        this.isReady = false;
    },

    /**
     * Get the version of the running Ollama instance
     */
    async getVersion() {
        return new Promise((resolve) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: this.port,
                path: '/api/version',
                method: 'GET',
                timeout: 3000
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        resolve(parsed.version || null);
                    } catch {
                        resolve(null);
                    }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.end();
        });
    },

    /**
     * Pull a model with streaming progress.
     *
     * Ollama's /api/pull is resumable: it skips blobs already on disk, so a
     * dropped connection is recoverable by simply re-issuing the request.
     * We exploit that — a stalled socket or transient connection error
     * auto-resumes (up to MAX_ATTEMPTS) instead of surfacing a hard
     * failure. Progress is summed across every layer digest and clamped so
     * the bar only ever moves forward: Ollama reports completed/total
     * per-layer, which otherwise snaps back to 0% on each new layer and
     * looks like the download restarted.
     */
    pullModel(modelName, onProgress) {
        const MAX_ATTEMPTS = 6;
        const STALL_MS = 300000; // 5 min of socket silence => assume stalled
        const layers = new Map(); // digest -> { completed, total }
        let maxPercent = 0;
        let succeeded = false;

        const friendly = (s) => {
            const t = String(s || '').toLowerCase();
            if (t.includes('pulling') && t.includes('manifest')) return 'Preparing';
            if (t.includes('verifying')) return 'Checking the download';
            if (t.includes('writing') || t.includes('removing')) return 'Finishing up';
            if (t.includes('success')) return 'Done';
            return 'Downloading';
        };

        const emit = (statusText, pct) => {
            if (onProgress) onProgress({ status: statusText, percent: pct, total: null, completed: null });
        };

        const attempt = () => new Promise((resolve, reject) => {
            const body = JSON.stringify({ name: modelName, stream: true });
            const req = http.request({
                hostname: '127.0.0.1',
                port: this.port,
                path: '/api/pull',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body)
                }
            }, (res) => {
                let buffer = '';

                res.on('data', chunk => {
                    buffer += chunk.toString();
                    const lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (const line of lines) {
                        if (!line.trim()) continue;
                        let parsed;
                        try { parsed = JSON.parse(line); } catch { continue; }

                        if (parsed.error) {
                            // Server-side error (bad name, disk full):
                            // unrecoverable — re-pulling won't help.
                            reject(Object.assign(new Error(parsed.error), { fatal: true }));
                            return;
                        }
                        if (parsed.status && /success/i.test(parsed.status)) succeeded = true;
                        if (parsed.digest && parsed.total) {
                            layers.set(parsed.digest, {
                                completed: parsed.completed || 0,
                                total: parsed.total
                            });
                        }

                        let totalAll = 0, doneAll = 0;
                        for (const v of layers.values()) { totalAll += v.total; doneAll += v.completed; }
                        let pct = totalAll > 0 ? Math.round((doneAll / totalAll) * 100) : null;
                        if (pct !== null) {
                            // Monotonic: a newly-announced layer enlarges the
                            // denominator and would otherwise dip the bar.
                            pct = Math.min(100, Math.max(maxPercent, pct));
                            maxPercent = pct;
                        }
                        emit(friendly(parsed.status), succeeded ? 100 : pct);
                    }
                });

                res.on('end', () => {
                    if (succeeded) resolve({ success: true });
                    else reject(new Error('Connection closed before the download finished'));
                });
                res.on('error', (e) => reject(e));
            });

            req.on('error', (e) => reject(e));
            // Inactivity (not total) timeout: Ollama streams progress
            // continuously while bytes flow, so a long silence means the
            // socket stalled. Destroying it triggers a resume, not a fail.
            req.setTimeout(STALL_MS, () => { req.destroy(new Error('Download stalled')); });
            req.write(body);
            req.end();
        });

        return (async () => {
            let lastErr;
            for (let n = 1; n <= MAX_ATTEMPTS; n++) {
                try {
                    return await attempt();
                } catch (e) {
                    lastErr = e;
                    if (e && e.fatal) throw e;            // unrecoverable
                    if (succeeded) return { success: true };
                    if (n < MAX_ATTEMPTS) {
                        emit('Reconnecting, your progress is saved', maxPercent || null);
                        // eslint-disable-next-line no-await-in-loop
                        await new Promise(r => setTimeout(r, Math.min(15000, 2000 * n)));
                    }
                }
            }
            throw lastErr || new Error('Model download failed');
        })();
    },

    /**
     * List available models
     */
    async listModels() {
        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: this.port,
                path: '/api/tags',
                method: 'GET',
                timeout: 5000
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        resolve({ models: [] });
                    }
                });
            });
            req.on('error', (e) => reject(e));
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            req.end();
        });
    },

    /**
     * Download Ollama.app from the given URL and install it to /Applications
     * (falling back to ~/Applications if /Applications is not writable).
     *
     * Supports both .zip (the current ollama.com format) and .dmg by sniffing
     * the file's magic bytes — we don't trust the URL extension because the
     * canonical download URL has changed format historically and could again.
     *
     * Progress callback receives {phase, percent, downloaded, total, message}.
     * Phases: 'download' (streaming bytes), 'extract' (unpacking), 'install'
     * (copying into place), 'done'.
     *
     * Returns {success: true, path} on success, or throws on failure.
     * macOS-only; throws on other platforms (use the manual download link instead).
     */
    async installFromUrl(url, onProgress) {
        if (process.platform !== 'darwin') {
            throw new Error('Automatic install is only supported on macOS. Please download Ollama from ollama.com/download.');
        }
        if (!url) throw new Error('No install URL provided');

        const tmpFile = path.join(os.tmpdir(), `ollama-installer-${Date.now()}.bin`);
        const extractDir = path.join(os.tmpdir(), `ollama-extract-${Date.now()}`);
        let mountPoint = null;

        try {
            // 1. Download
            if (onProgress) onProgress({ phase: 'download', percent: 0, message: 'Connecting...' });
            await this._downloadFile(url, tmpFile, onProgress);

            // 2. Detect format via magic bytes (ZIP = "PK\x03\x04")
            const fd = fs.openSync(tmpFile, 'r');
            const magic = Buffer.alloc(4);
            fs.readSync(fd, magic, 0, 4, 0);
            fs.closeSync(fd);
            const isZip = magic[0] === 0x50 && magic[1] === 0x4B && magic[2] === 0x03 && magic[3] === 0x04;

            // 3. Extract
            fs.mkdirSync(extractDir, { recursive: true });
            let ollamaAppSrc;

            if (isZip) {
                if (onProgress) onProgress({ phase: 'extract', message: 'Extracting archive...' });
                execSync(`/usr/bin/unzip -q -o "${tmpFile}" -d "${extractDir}"`, { encoding: 'utf8' });
                ollamaAppSrc = path.join(extractDir, 'Ollama.app');
            } else {
                // Assume DMG
                if (onProgress) onProgress({ phase: 'extract', message: 'Mounting disk image...' });
                const attachOutput = execSync(
                    `/usr/bin/hdiutil attach -nobrowse -readonly -noautoopen -plist "${tmpFile}"`,
                    { encoding: 'utf8' }
                );
                // Parse the first mount point from the plist output
                const mountMatch = attachOutput.match(/<string>(\/Volumes\/[^<]+)<\/string>/);
                if (!mountMatch) throw new Error('Failed to determine DMG mount point');
                mountPoint = mountMatch[1];
                ollamaAppSrc = path.join(mountPoint, 'Ollama.app');
            }

            if (!fs.existsSync(ollamaAppSrc)) {
                throw new Error('Ollama.app not found in downloaded archive');
            }

            // 4. Copy into place. Try /Applications first; fall back to ~/Applications
            //    on permission failure so non-admin users still get an install.
            if (onProgress) onProgress({ phase: 'install', message: 'Installing Ollama...' });
            const primaryDest = '/Applications/Ollama.app';
            const fallbackDest = path.join(os.homedir(), 'Applications', 'Ollama.app');
            let dest = null;

            const tryCopy = (target) => {
                if (fs.existsSync(target)) {
                    execSync(`/bin/rm -rf "${target}"`);
                }
                fs.mkdirSync(path.dirname(target), { recursive: true });
                execSync(`/bin/cp -R "${ollamaAppSrc}" "${target}"`);
            };

            try {
                tryCopy(primaryDest);
                dest = primaryDest;
            } catch (primaryErr) {
                console.log('[ollama] Install to /Applications failed, trying ~/Applications:', primaryErr.message);
                try {
                    tryCopy(fallbackDest);
                    dest = fallbackDest;
                } catch (fallbackErr) {
                    throw new Error(`Install failed: ${fallbackErr.message}`);
                }
            }

            // 5. Strip Gatekeeper quarantine so our direct spawn doesn't hit a prompt.
            //    We invoke the embedded binary directly rather than launching Ollama.app,
            //    but clearing the xattr is cheap insurance.
            try { execSync(`/usr/bin/xattr -dr com.apple.quarantine "${dest}"`); } catch {}

            if (onProgress) onProgress({ phase: 'done', message: 'Install complete', percent: 100 });
            return { success: true, path: dest };
        } finally {
            // Cleanup — best effort
            if (mountPoint) {
                try { execSync(`/usr/bin/hdiutil detach -quiet -force "${mountPoint}"`); } catch {}
            }
            try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
            try { fs.unlinkSync(tmpFile); } catch {}
        }
    },

    /**
     * HTTPS download with redirect following and progress reporting.
     * Progress is throttled to ~4Hz to avoid flooding the IPC channel.
     */
    _downloadFile(url, destPath, onProgress) {
        const https = require('https');
        return new Promise((resolve, reject) => {
            const doRequest = (requestUrl, redirectsRemaining) => {
                const req = https.get(requestUrl, { timeout: 30000 }, (res) => {
                    // Follow redirects
                    if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                        res.resume();
                        if (redirectsRemaining <= 0) {
                            reject(new Error('Too many redirects'));
                            return;
                        }
                        const nextUrl = new URL(res.headers.location, requestUrl).toString();
                        doRequest(nextUrl, redirectsRemaining - 1);
                        return;
                    }

                    if (res.statusCode !== 200) {
                        res.resume();
                        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
                        return;
                    }

                    const totalBytes = parseInt(res.headers['content-length'] || '0', 10) || null;
                    let downloadedBytes = 0;
                    let lastReportTime = 0;

                    const writeStream = fs.createWriteStream(destPath);
                    writeStream.on('error', (e) => {
                        req.destroy();
                        reject(e);
                    });
                    writeStream.on('finish', () => {
                        writeStream.close(() => resolve());
                    });

                    res.on('data', (chunk) => {
                        downloadedBytes += chunk.length;
                        const now = Date.now();
                        if (onProgress && now - lastReportTime > 250) {
                            lastReportTime = now;
                            onProgress({
                                phase: 'download',
                                percent: totalBytes ? Math.round((downloadedBytes / totalBytes) * 100) : null,
                                downloaded: downloadedBytes,
                                total: totalBytes,
                                message: 'Downloading Ollama...'
                            });
                        }
                    });

                    res.on('error', (e) => {
                        writeStream.destroy();
                        reject(e);
                    });

                    res.pipe(writeStream);
                });

                req.on('error', reject);
                req.on('timeout', () => {
                    req.destroy();
                    reject(new Error('Download timed out'));
                });
            };

            doRequest(url, 5);
        });
    },

    /**
     * Delete a model
     */
    deleteModel(modelName) {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({ model: modelName });
            const req = http.request({
                hostname: '127.0.0.1',
                port: this.port,
                path: '/api/delete',
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body)
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({ success: res.statusCode === 200 }));
            });
            req.on('error', (e) => reject(e));
            req.write(body);
            req.end();
        });
    }
};

module.exports = OllamaManager;
