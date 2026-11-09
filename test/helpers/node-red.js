'use strict';

// Starts a real Node-RED in a scratch userDir, with adminAuth on.
// The scratch userDir gets two copies of the test node package
// (nru-test-a and nru-test-b). Each copy bundles its own copy of the library.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
// NRU_LIB lets you run the tests against another copy of the library
const LIB = process.env.NRU_LIB ? path.resolve(process.env.NRU_LIB) : REPO;
const MODULES = ['node-red-base', 'node-red-editorcomms', 'node-red-resourceendpoint',
    'node-red-popup', 'node-red-singleton', 'node-red-worker', 'node-red-pubsub-bus', 'node-red-connection'];
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'test-nodes');
const USER = 'admin';
const PASSWORD = 'test';

/** Find red.js of Node-RED: NODE_RED_JS, then a local install, then node-red on PATH. */
function findNodeRed() {
    if (process.env.NODE_RED_JS) return process.env.NODE_RED_JS;
    try { return require.resolve('node-red/red.js', { paths: [REPO] }); } catch (_) {}
    try {
        const bin = execFileSync('sh', ['-c', 'command -v node-red'], { encoding: 'utf8' }).trim();
        if (bin) return fs.realpathSync(bin);
    } catch (_) {}
    return null;
}

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}

function installPackage(userDir, name) {
    const dir = path.join(userDir, 'node_modules', name);
    fs.cpSync(FIXTURE, dir, { recursive: true });
    for (const mod of MODULES) {
        fs.cpSync(path.join(LIB, mod), path.join(dir, 'lib', mod), { recursive: true });
    }
    // As in a real install, the library copy has its own package.json
    fs.writeFileSync(path.join(dir, 'lib', 'package.json'), JSON.stringify({ name: '@nrutils/node-red-utils' }));
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    pkg.name = name;
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Poll fn until it returns a truthy value, or throw after timeoutMs. */
async function waitFor(fn, timeoutMs = 5000, what = 'condition') {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const value = await fn().catch(() => null);
        if (value) return value;
        if (Date.now() > end) throw new Error('Timeout: ' + what);
        await sleep(50);
    }
}

async function startNodeRed() {
    const redJs = findNodeRed();
    if (!redJs) return null;

    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-red-utils-test-'));
    installPackage(userDir, 'nru-test-a');
    installPackage(userDir, 'nru-test-b');
    const port = await freePort();
    fs.writeFileSync(path.join(userDir, 'settings.js'), `module.exports = {
        uiHost: '127.0.0.1',
        uiPort: ${port},
        flowFile: 'flows.json',
        credentialSecret: false,
        logging: { console: { level: 'warn' } },
        diagnostics: { enabled: false },
        telemetry: { enabled: false },
        adminAuth: {
            type: 'credentials',
            users: (u) => Promise.resolve(u === '${USER}' ? { username: u, permissions: '*' } : null),
            authenticate: (u, p) => Promise.resolve(u === '${USER}' && p === '${PASSWORD}' ? { username: u, permissions: '*' } : null)
        }
    };`);

    const child = spawn(process.execPath, [redJs, '-u', userDir, '-s', path.join(userDir, 'settings.js')],
        { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', d => { log += d; });
    child.stderr.on('data', d => { log += d; });

    const base = `http://127.0.0.1:${port}`;
    const red = {
        base,
        token: null,
        log: () => log,
        async request(method, url, { body, headers = {}, auth = true } = {}) {
            const h = { ...headers };
            if (auth && red.token) h.Authorization = 'Bearer ' + red.token;
            if (body !== undefined) h['Content-Type'] = 'application/json';
            return fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
        },
        async json(url) { return (await red.request('GET', url)).json(); },
        async deploy(flows, type = 'full') {
            const res = await red.request('POST', '/flows', { body: flows, headers: { 'Node-RED-Deployment-Type': type } });
            if (!res.ok) throw new Error('deploy failed: ' + res.status + ' ' + await res.text());
        },
        /** POST the trigger route until the node exists. After a deploy, Node-RED answers before the new flow is started. */
        async trigger(id, query) {
            const url = '/nru-test-a/trigger/' + id + (query ? '?' + query : '');
            await waitFor(async () => (await red.request('POST', url)).ok, 5000, 'trigger ' + id);
        },
        async stop() {
            if (child.exitCode === null) {
                const exited = new Promise(r => child.once('exit', r));
                child.kill('SIGTERM');
                await Promise.race([exited, sleep(5000)]);
                if (child.exitCode === null) child.kill('SIGKILL');
            }
            fs.rmSync(userDir, { recursive: true, force: true });
        }
    };

    try {
        await waitFor(async () => (await fetch(base + '/auth/login')).ok, 30000, 'Node-RED start');
        const res = await fetch(base + '/auth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: 'node-red-admin', grant_type: 'password', scope: '*', username: USER, password: PASSWORD })
        });
        red.token = (await res.json()).access_token;
    } catch (err) {
        await red.stop();
        throw new Error(err.message + '\n' + log);
    }
    return red;
}

module.exports = { startNodeRed, waitFor, sleep };
