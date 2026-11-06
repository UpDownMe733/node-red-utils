'use strict';

// Starts one real Node-RED (adminAuth on) and checks the pub/sub bus in it:
// the discovery route, a producer in a worker (nodeRedWorker + attachWorker + proxy),
// the disconnect event and a duplicate worker producer id.
// Needs Node-RED: a local install, node-red on PATH, or NODE_RED_JS=<path to red.js>.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startNodeRed, waitFor, sleep } = require('./helpers/node-red.js');

const tab = { id: 'pt', type: 'tab', label: 'pubsub' };
const node = (id, type, name, extra = {}) => ({ id, type: 'nru-test-a-' + type, z: 'pt', name, wires: [], ...extra });

describe('node-red-pubsub-bus in a real Node-RED', { timeout: 60000 }, () => {
    let red;
    let logStart = 0;
    const newLog = () => red.log().slice(logStart);
    const stats = () => red.json('/nru-test-a/stats');
    const value = async (id) => (await red.json('/nru-test-a/pubsub/' + id)).value;
    const producers = async () => (await red.json('/node-red-pubsub-bus/producers')).map(p => p.producerId).sort();

    before(async () => { red = await startNodeRed(); });
    after(async () => { if (red) await red.stop(); });

    it('serves the producers route before any deploy', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        assert.equal((await red.request('GET', '/node-red-pubsub-bus/producers', { auth: false })).status, 401);
        const res = await red.request('GET', '/node-red-pubsub-bus/producers');
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), []);
    });

    it('a worker producer delivers values with no errors in the log, also after a redeploy', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        logStart = red.log().length;
        const flows = (comment) => [tab, node('pw', 'psworker', 'p1'), node('ps', 'pssub', 'p1'),
            { id: 'pc', type: 'comment', z: 'pt', name: comment, wires: [] }];
        await red.deploy(flows('v1'));
        const first = await waitFor(async () => (await value('p1')) > 0 && value('p1'), 5000, 'first value');
        await waitFor(async () => (await value('p1')) > first, 5000, 'value grows');
        assert.deepEqual(await producers(), ['p1']);
        assert.ok((await stats()).pubsub.ps.includes('change'));

        // A full redeploy restarts the worker, which registers the same id again
        await red.deploy(flows('v2'));
        await sleep(300);
        await waitFor(async () => (await value('p1')) > 0, 5000, 'value after redeploy');
        assert.deepEqual(await producers(), ['p1']);
        assert.doesNotMatch(newLog(), /error|warn|TypeError/i);
    });

    it('subscribers get a disconnect event when the producer goes', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        await red.request('POST', '/nru-test-a/reset');
        await red.deploy([tab, node('ps', 'pssub', 'p1')], 'nodes');
        await waitFor(async () => (await stats()).pubsub.ps?.includes('disconnect'), 5000, 'disconnect event');
        assert.deepEqual(await producers(), []);
        assert.equal(await value('p1'), null);
    });

    it('a duplicate worker producer id is reported on the node and Node-RED stays up', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        logStart = red.log().length;
        await red.deploy([tab, node('d1', 'psworker', 'dup'), node('d2', 'psworker', 'dup')]);
        await waitFor(async () => /already registered/.test(newLog()), 5000, 'duplicate error in log');
        await sleep(300);
        assert.doesNotMatch(newLog(), /Uncaught Exception/);
        assert.deepEqual(await producers(), ['dup']);
        assert.ok((await value('dup')) > 0);
        await red.deploy([tab]);
    });
});
