'use strict';

// Starts one real Node-RED (adminAuth on) and checks the library in it.
// Needs Node-RED: a local install, node-red on PATH, or NODE_RED_JS=<path to red.js>.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { startNodeRed, waitFor, sleep } = require('./helpers/node-red.js');

const flows = (comment = 'v1', withCommsA = true, { w1Name = '', extra = [] } = {}) => [
    { id: 't1', type: 'tab', label: 'test' },
    { id: 'w1', type: 'nru-test-a-worker', z: 't1', name: w1Name, wires: [['w2']] },
    { id: 'w2', type: 'nru-test-a-worker', z: 't1', wires: [] },
    { id: 'subA', type: 'nru-test-a-sub', z: 't1', wires: [] },
    { id: 'subB', type: 'nru-test-b-sub', z: 't1', wires: [] },
    ...(withCommsA ? [{ id: 'commsA', type: 'nru-test-a-comms', z: 't1', wires: [] }] : []),
    { id: 'commsB', type: 'nru-test-b-comms', z: 't1', wires: [] },
    { id: 'ui', type: 'nru-test-a-ui', z: 't1', wires: [] },
    { id: 'c1', type: 'comment', z: 't1', name: comment, wires: [] },
    ...extra.map(n => ({ z: 't1', wires: [], ...n }))
];

describe('node-red-utils in a real Node-RED', { timeout: 60000 }, () => {
    let red;
    const stats = () => red.json('/nru-test-a/stats');
    const workersReady = () => waitFor(async () => {
        const s = await stats();
        return s.starts.w1?.length && s.starts.w2?.length && s;
    }, 5000, 'worker start');

    // Status of each frontend script URL before the first deploy
    const frontendScripts = ['node-red-editorcomms/EditorCommsFrontend.js', 'node-red-popup/NodeRedPopupFrontend.js',
        'node-red-singleton/NodeRedSingletonFrontend.js'];
    const statusBeforeDeploy = {};
    let commsBeforeDeploy, resourceBeforeDeploy;

    before(async () => {
        red = await startNodeRed();
        if (red) {
            for (const p of frontendScripts) {
                statusBeforeDeploy[p] = (await red.request('GET', '/node-red-resourceendpoint/' + p, { auth: false })).status;
            }
            const post = await red.request('POST', '/node_red_editorcomms', { body: { nodeId: 'x', messageType: 'ping', payload: 1 } });
            commsBeforeDeploy = { status: post.status, body: await post.text() };
            resourceBeforeDeploy = (await red.request('GET', '/node-red-resourceendpoint/nru-test-a-res/hello.js', { auth: false })).status;
            await red.deploy(flows());
            await workersReady();
        }
    });
    after(async () => { if (red) await red.stop(); });

    it('resource endpoint serves a registered file', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        const res = await red.request('GET', '/node-red-resourceendpoint/nru-test-a/hello.js', { auth: false });
        assert.equal(res.status, 200);
        assert.match(await res.text(), /nruTestHello/);
    });

    it('frontend scripts of the editor mixins are served before the first deploy', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        for (const p of frontendScripts) assert.equal(statusBeforeDeploy[p], 200, p);
    });

    it('editor comms answers JSON 404 before any node of the library exists', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        assert.equal(commsBeforeDeploy.status, 404);
        assert.deepEqual(JSON.parse(commsBeforeDeploy.body), { status: 'no handler' });
    });

    it('resources in the createNode options are served before the first deploy', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        assert.equal(resourceBeforeDeploy, 200);
    });

    it('frontend scripts of the editor mixins are served', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        for (const p of frontendScripts) {
            const res = await red.request('GET', '/node-red-resourceendpoint/' + p, { auth: false });
            assert.equal(res.status, 200, p);
        }
    });

    it('resource endpoint rejects path traversal and files that are not registered', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        for (const p of ['..%2fsecret.txt', '..%2f..%2fnru-test-a%2fsecret.txt', '%2e%2e%2fsecret.txt',
            '..%2fpackage.json', '..%2f..%2f..%2fsettings.js', 'secret.txt']) {
            const res = await red.request('GET', '/node-red-resourceendpoint/nru-test-a/' + p);
            assert.equal(res.status, 404, p);
        }
    });

    it('two copies of the library share routes, handlers and bus', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        const res = await red.request('GET', '/node-red-resourceendpoint/nru-test-b/hello.js', { auth: false });
        assert.equal(res.status, 200, 'resource of the second copy');

        const post = await red.request('POST', '/node_red_editorcomms',
            { body: { nodeId: 'commsB', messageType: 'ping', payload: 1 } });
        assert.deepEqual(await post.json(), { status: 'ok' }, 'editor comms of the second copy');

        assert.ok((await stats()).producers.includes('nru-test-b-prod'), 'producer of the second copy');
    });

    it('early messages to a worker are delivered', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        const s = await waitFor(async () => {
            const s = await stats();
            return s.processed.w1?.includes('early-w1') && s.got.w2?.includes('early-w1') && s.got.w2?.includes('hello-from-w1') && s;
        }, 3000, 'early messages').catch(async () => stats());
        assert.deepEqual(s.processed.w1, ['early-w1'], 'parent message sent before the worker file ran');
        assert.ok(s.got.w2?.includes('early-w1'), 'early message passed on to the downstream worker');
        assert.ok(s.got.w2?.includes('hello-from-w1'), 'upstream worker message sent at start');
    });

    it('modified-nodes deploy does not re-wire or restart unchanged workers', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        await red.request('POST', '/nru-test-a/reset');
        await red.deploy(flows('v2'), 'nodes');
        await sleep(500);
        await red.trigger('w1');
        await sleep(500);
        const s = await stats();
        assert.equal(s.starts.w1, undefined, 'worker file ran again in w1');
        assert.equal(s.starts.w2, undefined, 'worker file ran again in w2');
        assert.deepEqual(s.processed.w1, ['trigger-w1']);
        assert.deepEqual(s.got.w2, ['trigger-w1']);
    });

    it('full redeploy does not leak workers or bus subscriptions', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        for (let i = 0; i < 2; i++) {
            await red.request('POST', '/nru-test-a/reset');
            await red.deploy(flows('full' + i));
            await workersReady();
        }
        const { workers, subscribers } = await stats();
        // 2 worker nodes, 2 sub nodes with one subscription each
        assert.deepEqual({ workers, subscribers }, { workers: 2, subscribers: 2 });
    });

    it('editor comms returns the result of the handler to the editor', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        await red.deploy(flows('result'));
        // The deploy request can return before the new nodes run
        const post = await waitFor(async () => {
            const res = await red.request('POST', '/node_red_editorcomms',
                { body: { nodeId: 'commsA', messageType: 'double', payload: 21 } });
            return res.status !== 404 && res;
        }, 3000, 'comms handler');
        assert.equal(post.status, 200);
        assert.deepEqual(await post.json(), { status: 'ok', result: 42 });
    });

    it('an editor comms handler that rejects gives status 500 and Node-RED keeps running', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        const logStart = red.log().length;
        const post = await red.request('POST', '/node_red_editorcomms',
            { body: { nodeId: 'commsA', messageType: 'fail', payload: 1 } });
        assert.equal(post.status, 500);
        assert.deepEqual(await post.json(), { error: 'async fail' });
        await waitFor(async () => /Editor message 'fail' failed: async fail/.test(red.log().slice(logStart)), 3000, 'log line');
        await sleep(300);
        assert.doesNotMatch(red.log().slice(logStart), /Uncaught Exception/);
        assert.equal((await red.request('GET', '/flows')).status, 200, 'Node-RED is up');
    });

    it('editor comms handlers are removed when the node closes', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        await red.deploy(flows('nocomms', false));
        const post = await red.request('POST', '/node_red_editorcomms',
            { body: { nodeId: 'commsA', messageType: 'ping', payload: 1 } });
        assert.equal(post.status, 404);
        assert.deepEqual(await post.json(), { status: 'no handler' });
    });

    it('editor comms cannot reach a node inside a subflow instance', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        await red.request('POST', '/nru-test-a/reset');
        await red.deploy(flows('subflow', false, { extra: [
            { id: 'sf1', type: 'subflow', name: 'sf', in: [], out: [], z: undefined },
            { id: 'sfc', type: 'nru-test-a-comms', z: 'sf1', x: 100, y: 100 },
            { id: 'sfi', type: 'subflow:sf1', x: 100, y: 100 }] }));
        const s = await waitFor(async () => { const s = await stats(); return Object.keys(s.comms).length && s; }, 3000, 'comms node in subflow');
        // The runtime node has an id that the editor does not know
        assert.deepEqual(Object.keys(s.comms).filter(id => id === 'sfc' || id === 'sfi'), []);
        for (const nodeId of ['sfc', 'sfi']) {
            const post = await red.request('POST', '/node_red_editorcomms', { body: { nodeId, messageType: 'ping', payload: 1 } });
            assert.equal(post.status, 404, nodeId);
        }
    });

    it("'default' handlers get every type that is not internal, on both sides", async (t) => {
        if (!red) return t.skip('Node-RED not found');
        await red.deploy(flows('defaults'));
        await workersReady();
        await red.request('POST', '/nru-test-a/reset');
        await red.trigger('w1');
        // Wait for all three records: the worker's 'seen' and the main thread's 'processed' arrive in any order
        const s = await waitFor(async () => { const s = await stats();
            return s.seen.w1?.includes('process') && s.defaults.w1?.includes('processed') && s.defaults.w1?.includes('seen') && s; },
            5000, 'default handlers');
        const all = [...s.seen.w1, ...s.defaults.w1];
        assert.deepEqual(all.filter(type => type === 'ack' || type.startsWith('_')), [], 'internal types');
    });

    it('a changed upstream worker does not add input slots to an unchanged downstream worker', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        for (let i = 0; i < 3; i++) {
            await red.request('POST', '/nru-test-a/reset');
            await red.deploy(flows('defaults', true, { w1Name: 'up' + i }), 'nodes');
            await waitFor(async () => (await stats()).starts.w1?.length, 5000, 'w1 start');
            await red.trigger('w2', 'topic=inputs');
            await red.trigger('w1');
            const s = await waitFor(async () => { const s = await stats(); return s.inputs.w2 && s.got.w2?.includes('trigger-w1') && s; },
                3000, 'inputs of w2');
            assert.equal(s.starts.w2, undefined, 'w2 was restarted');
            assert.deepEqual(s.inputs.w2, [1], 'deploy ' + i);
        }
    });

    it('a throw in worker code reports an error and Node-RED keeps running', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        await red.deploy(flows('crash', true, { extra: [
            { id: 'wc', type: 'nru-test-a-worker' },
            { id: 'wb', type: 'nru-test-a-worker', name: 'bad-load' }] }));
        await waitFor(async () => (await stats()).starts.wc?.length, 5000, 'wc start');
        await red.trigger('wc', 'topic=crash');
        const s = await waitFor(async () => {
            const s = await stats();
            return s.status.wc?.includes('worker error') && s.status.wb?.includes('worker error') && s;
        }, 5000, 'red status');
        assert.ok(s.status.wb.includes('worker error'), 'load error');
        // Both failures end the thread, so the node can end its waiting jobs on 'exit'
        await waitFor(async () => { const s = await stats(); return s.exits.wc && s.exits.wb; }, 5000, "'exit' of both workers");
        // The log comes from the child process a bit later than the status
        await waitFor(async () => /Worker error: async boom/.test(red.log()), 3000, 'log of the async throw');
        await waitFor(async () => /Worker error: .*bad-worker\.js: load boom/.test(red.log()), 3000, 'log of the load error');
        assert.equal((await red.request('GET', '/flows')).status, 200, 'Node-RED is up');
        // The other workers still work
        await red.trigger('w1');
        await waitFor(async () => (await stats()).got.w2?.includes('trigger-w1'), 3000, 'w1 to w2');
        // A redeploy stops the failed workers without the 2 s close wait
        await red.deploy(flows('crash2'));
        // The deploy request can return before the new nodes run
        await waitFor(async () => (await stats()).workers === 2, 3000, 'two workers after the redeploy');
    });

    it('a worker that init() starts after flows:started runs and is wired', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        await red.request('POST', '/nru-test-a/reset');
        await red.deploy(flows('late', true, { extra: [{ id: 'wl', type: 'nru-test-a-worker', name: 'late', wires: [['w2']] }] }));
        const s = await waitFor(async () => {
            const s = await stats();
            return s.starts.wl?.length && s.got.w2?.includes('hello-from-wl') && s;
        }, 5000, 'late worker start and wire').catch(async () => stats());
        assert.deepEqual(s.starts.wl, [1], 'late worker ran');
        assert.ok(s.got.w2?.includes('hello-from-wl'), 'late worker wired to w2');
    });

    it('a worker file can be an ES module with a default export', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        await red.request('POST', '/nru-test-a/reset');
        await red.deploy(flows('esm', true, { extra: [
            { id: 'we', type: 'nru-test-a-worker', name: 'esm', wires: [['w2']] },
            { id: 'wx', type: 'nru-test-a-worker', name: 'bad-export' }] }));
        const s = await waitFor(async () => {
            const s = await stats();
            return s.starts.we?.length && s.got.w2?.includes('hello-from-we') && s.status.wx && s;
        }, 5000, 'ESM worker').catch(async () => stats());
        assert.deepEqual(s.starts.we, [1], 'ESM worker ran');
        assert.ok(s.got.w2?.includes('hello-from-we'), 'ESM worker wired to w2');
        assert.deepEqual(s.status.we, undefined, 'no error status');
        await waitFor(async () => /no-export-worker\.js: the worker file must export a function/.test(red.log()), 3000, 'export error');
    });

    it('wired worker nodes inside a subflow connect to each other', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        await red.request('POST', '/nru-test-a/reset');
        await red.deploy(flows('subflow-workers', true, { extra: [
            { id: 'sfw', type: 'subflow', name: 'sfw', in: [], out: [], z: undefined },
            { id: 'sfa', type: 'nru-test-a-worker', z: 'sfw', x: 100, y: 100, wires: [['sfb']] },
            { id: 'sfb', type: 'nru-test-a-worker', z: 'sfw', x: 200, y: 100, wires: [] },
            { id: 'sfwi', type: 'subflow:sfw', x: 100, y: 100 }] }));
        // Inside a subflow instance the runtime nodes have new ids
        const got = await waitFor(async () => {
            const s = await stats();
            return Object.entries(s.got).find(([id, values]) => id !== 'w2' && values.some(v => /^hello-from-/.test(v)));
        }, 5000, 'message between the subflow workers').catch(() => null);
        assert.ok(got, 'the downstream worker in the subflow got the message of the upstream worker');
        assert.notEqual(got[1].find(v => /^hello-from-/.test(v)), 'hello-from-' + got[0], 'not from itself');
    });

    it('credentials declared in createNode options reach the node', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        await red.deploy(flows('cred', true, { extra: [
            { id: 'cr1', type: 'nru-test-a-cred', credentials: { secret: 's3cret' } }] }));
        const s = await waitFor(async () => { const s = await stats(); return s.cred.cr1 && s; }, 3000, 'credential node');
        assert.deepEqual(s.cred.cr1, ['s3cret']);
    });

    it('publishUntilAcknowledged returns a working stop function when it already polls the topic', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        await red.deploy(flows('poll'));
        await red.trigger('w1', 'topic=poll');
        const s = await waitFor(async () => { const s = await stats(); return s.polled.w1 && s; }, 5000, 'poll result');
        assert.deepEqual(s.polled.w1, [['function', 'function']]);
        // The second stop function stopped the poll: the pings stop
        await sleep(300);
        const before = (await stats()).pings.w1.length;
        await sleep(300);
        assert.equal((await stats()).pings.w1.length, before);
    });

    it('init() throws a clear error for a relative workerFile', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        await red.deploy(flows('relative', true, { extra: [{ id: 'rel', type: 'nru-test-a-worker', name: 'relative-path' }] }));
        const s = await waitFor(async () => { const s = await stats(); return s.initError.rel && s; }, 3000, 'init error');
        assert.match(s.initError.rel[0], /workerFile must be an absolute path.*"worker\.js"/);
    });

    /** A TCP server that records each socket and whether it closed */
    async function tcpServer() {
        const sockets = [];
        const server = net.createServer((socket) => {
            socket.resume();
            socket.on('close', () => { socket.gone = true; });
            sockets.push(socket);
        });
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        return { sockets, port: server.address().port, stop: () => { sockets.forEach(s => s.destroy()); server.close(); } };
    }
    const readyCount = (s, id) => (s.conn[id] || []).filter(x => x === 'ready').length;

    it('nodeRedConnection reconnects a TCP client after the server drops the socket', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        const srv = await tcpServer();
        try {
            await red.request('POST', '/nru-test-a/reset');
            await red.deploy(flows('conn', true, { extra: [
                { id: 'cc1', type: 'nru-test-a-conncfg', port: srv.port },
                { id: 'cu1', type: 'nru-test-a-conn', client: 'cc1', x: 100, y: 100 }] }));
            await waitFor(async () => readyCount(await stats(), 'cu1') === 1, 5000, 'first connection');
            srv.sockets[0].destroy();
            const s = await waitFor(async () => { const s = await stats(); return readyCount(s, 'cu1') === 2 && s; }, 5000, 'reconnect');
            assert.deepEqual(s.conn.cu1, ['connecting', 'ready', 'failed', 'connecting', 'ready']);
            assert.equal(srv.sockets.length, 2);
            // A deploy without the nodes closes the client socket
            await red.deploy(flows('conn-gone'));
            await waitFor(async () => srv.sockets[1].gone, 5000, 'socket closed');
        } finally {
            srv.stop();
        }
    });

    it('nodeRedConnection keeps the socket when the user node restarts, and closes it when the node moves or goes', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        const srv = await tcpServer();
        const cfg = [{ id: 'cc1', type: 'nru-test-a-conncfg', port: srv.port }, { id: 'cc2', type: 'nru-test-a-conncfg', port: srv.port }];
        const user = (name, client) => ({ id: 'cu1', type: 'nru-test-a-conn', name, client, x: 100, y: 100 });
        try {
            await red.request('POST', '/nru-test-a/reset');
            await red.deploy(flows('conn2', true, { extra: [...cfg, user('a', 'cc1')] }));
            await waitFor(async () => readyCount(await stats(), 'cu1') === 1, 5000, 'first connection');

            // Modified-nodes deploy: only cu1 restarts. It gets 'ready' at once from the open socket.
            await red.deploy(flows('conn2', true, { extra: [...cfg, user('b', 'cc1')] }), 'nodes');
            await waitFor(async () => readyCount(await stats(), 'cu1') === 2, 5000, 'restarted node');
            await sleep(300);
            assert.equal(srv.sockets.length, 1, 'the restart opened a new socket');
            assert.ok(!srv.sockets[0].gone, 'the restart closed the socket');
            assert.deepEqual((await stats()).conn.cu1, ['connecting', 'ready', 'ready']);

            // cu1 moves to cc2: cc1 has no holder at flows:started and closes its socket
            await red.deploy(flows('conn2', true, { extra: [...cfg, user('b', 'cc2')] }), 'nodes');
            await waitFor(async () => srv.sockets[0].gone && srv.sockets.length === 2, 5000, 'socket of cc1 closed');
            await sleep(300);
            assert.ok(!srv.sockets[1].gone, 'the socket of cc2 is open');

            // The deploy removes cu1: cc2 has no holder at flows:started and closes its socket
            await red.deploy(flows('conn2', true, { extra: cfg }), 'nodes');
            await waitFor(async () => srv.sockets[1].gone, 5000, 'socket of cc2 closed');
        } finally {
            srv.stop();
        }
    });
});
