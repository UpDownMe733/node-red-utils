'use strict';

// Starts one real Node-RED (adminAuth on) and checks worker.request() and
// the error report of main-thread worker handlers.
// Needs Node-RED: a local install, node-red on PATH, or NODE_RED_JS=<path to red.js>.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startNodeRed, waitFor } = require('./helpers/node-red.js');

const flows = (label, extra = []) => [
    { id: 'rt', type: 'tab', label },
    { id: 'rq', type: 'nru-test-a-req', z: 'rt', wires: [] },
    { id: 'rc', type: 'catch', z: 'rt', scope: ['rq'], uncaught: false, wires: [['rr']] },
    { id: 'rr', type: 'nru-test-a-rec', z: 'rt', wires: [] },
    ...extra.map(n => ({ z: 'rt', wires: [], ...n }))
];

describe('worker.request() in a real Node-RED', { timeout: 60000 }, () => {
    let red;
    const stats = () => red.json('/nru-test-a/stats');
    // The deploy request can return before the new nodes run
    const trigger = (query) => waitFor(async () =>
        (await red.request('POST', '/nru-test-a/trigger/rq?' + new URLSearchParams(query))).ok, 3000, 'trigger');
    const until = (fn, what) => waitFor(async () => { const s = await stats(); return fn(s) && s; }, 5000, what);
    const deploy = async (label, extra) => {
        await red.request('POST', '/nru-test-a/reset');
        await red.deploy(flows(label, extra));
    };

    before(async () => {
        red = await startNodeRed();
        if (red) await deploy('request');
    });
    after(async () => { if (red) await red.stop(); });

    it('resolves with the value that the worker handler returns', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        // The first request can arrive before the worker file has run
        await trigger({ topic: 'double', payload: '21' });
        const s = await until(s => s.answers.rq, 'answer');
        assert.deepEqual(s.answers.rq, [[21, 42]]);
    });

    it('a throw in the worker handler reaches done(err) with the same message', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        await red.request('POST', '/nru-test-a/reset');
        await trigger({ topic: 'fail', payload: '1' });
        const s = await until(s => s.caught.rr, 'Catch node');
        assert.deepEqual(s.rejects.rq, ['bad input from worker']);
        // The name crosses the thread too, so a Catch node shows the same text as for a local TypeError
        assert.deepEqual(s.caught.rr, ['TypeError: bad input from worker']);
    });

    it('a request type with no handler rejects', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        await red.request('POST', '/nru-test-a/reset');
        await trigger({ topic: 'nothing', payload: '1' });
        const s = await until(s => s.rejects.rq, 'reject');
        assert.match(s.rejects.rq[0], /no worker\.handle\('nothing'/);
    });

    it('many requests in flight resolve to the right callers', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        await red.request('POST', '/nru-test-a/reset');
        // The first request takes longest, so the answers come back in the reverse order
        for (let n = 0; n < 10; n++) await trigger({ topic: 'slow', payload: JSON.stringify({ n, ms: (10 - n) * 20 }) });
        const s = await until(s => s.answers.rq?.length === 10, '10 answers');
        for (const [sent, answer] of s.answers.rq) assert.equal(answer, sent.n);
        assert.deepEqual(s.answers.rq.map(([sent]) => sent.n), [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    });

    it('the timeout option rejects a request that gets no answer', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        await red.request('POST', '/nru-test-a/reset');
        await trigger({ topic: 'hang', payload: '1', timeout: '100' });
        const s = await until(s => s.rejects.rq, 'timeout');
        assert.deepEqual(s.rejects.rq, ["worker request 'hang' timed out after 100 ms"]);
    });

    it('a worker crash rejects the pending requests', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        await red.request('POST', '/nru-test-a/reset');
        await trigger({ topic: 'hang', payload: '1' });
        await trigger({ topic: 'crash' });
        const s = await until(s => s.rejects.rq, 'reject after crash');
        assert.deepEqual(s.rejects.rq, ['worker error: async boom']);
        await deploy('after-crash');
    });

    it('a redeploy rejects the pending requests', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        await trigger({ topic: 'hang', payload: '1' });
        await trigger({ topic: 'hang', payload: '2' });
        await red.deploy(flows('redeploy'));
        const s = await until(s => s.rejects.rq?.length === 2, 'reject on close');
        assert.deepEqual(s.rejects.rq, ['worker request ended: the node closed', 'worker request ended: the node closed']);
    });

    it('a main-thread handler that throws is reported on the node and the next handler runs', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        await deploy('handler-error');
        await trigger({ topic: 'emit' });
        const s = await until(s => s.after.rq && s.caught.rr, 'second handler and Catch node');
        assert.deepEqual(s.after.rq, [1]);
        assert.deepEqual(s.caught.rr, ["worker message handler for 'boom' failed: handler boom"]);
    });

    it('a worker handler that throws is reported on the node, the next handler runs and the worker keeps running', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        await deploy('worker-handler-error');
        await trigger({ topic: 'throw' });
        const s = await until(s => s.afterThrow.rq && s.caught.rr, 'second handler and Catch node');
        assert.deepEqual(s.afterThrow.rq, [1]);
        assert.deepEqual(s.caught.rr, ["worker message handler for 'throw' failed: worker handler boom"]);
        await trigger({ topic: 'double', payload: '2' });
        await until(s => s.answers.rq, 'answer after the throw');
    });

    it('handlerError gets the data of the message that the handler got', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        await deploy('worker-handler-error');
        await trigger({ topic: 'throw-data', payload: '"the data"' });
        const s = await until(s => s.handlerData.rq, 'data in handlerError');
        assert.deepEqual(s.handlerData.rq, ['the data']);
    });

    it('request(), on() and terminate() before init() throw a clear error', async (t) => {
        if (!red) return t.skip('Node-RED not found');
        await deploy('stub', [{ id: 'st', type: 'nru-test-a-req', name: 'stub' }]);
        const s = await until(s => s.stub.st, 'stub errors');
        assert.equal(s.stub.st.length, 3);
        for (const line of s.stub.st) assert.match(line, /^(request|on|terminate): nodeRedWorker: call init\(\) before/);
    });
});
