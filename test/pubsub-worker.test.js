'use strict';

// Checks the worker proxy of the pub/sub bus. Needs no Node-RED.

const { it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Worker } = require('worker_threads');
const { getBus } = require('../node-red-pubsub-bus/NodeRedPubsubBus.js');

const PROXY = path.join(__dirname, '..', 'node-red-pubsub-bus', 'NodeRedPubsubBusWorkerProxy.js');

it('a producer-only worker learns that it is attached', async () => {
    // The worker registers a producer and gets no requests.
    // It reports whether the proxy saw a reply from the main thread.
    const code = `
        const { parentPort } = require('worker_threads');
        const proxy = require(${JSON.stringify(PROXY)});
        proxy.registerProducer('nru-proxy-test', { getEntries: () => [], getMetadata: () => null });
        const end = Date.now() + 2000;
        const check = () => {
            if (proxy._anyMessageReceived || Date.now() > end) parentPort.postMessage({ result: proxy._anyMessageReceived });
            else setTimeout(check, 20);
        };
        check();`;
    const worker = new Worker(code, { eval: true });
    const detach = getBus().attachWorker(worker);
    const result = await new Promise((resolve, reject) => {
        worker.on('message', (m) => { if (m && 'result' in m) resolve(m.result); });
        worker.on('error', reject);
    });
    detach();
    await worker.terminate();
    assert.equal(result, true, 'the proxy would log the "no attachWorker" warning');
});

it('getMetadata gives up after 5 s when the other side does not reply', { timeout: 15000 }, async () => {
    // Worker side: a proxy in a worker that nobody attached
    const code = `
        const { parentPort } = require('worker_threads');
        const proxy = require(${JSON.stringify(PROXY)});
        proxy.getMetadata('nobody', 'x').then(
            () => parentPort.postMessage({ result: 'resolved' }),
            (err) => parentPort.postMessage({ result: err.message }));`;
    const lonely = new Worker(code, { eval: true });
    const workerSide = new Promise((resolve, reject) => {
        lonely.on('message', (m) => { if (m && 'result' in m) resolve(m.result); });
        lonely.on('error', reject);
    });

    // Main side: a worker producer that never answers get-metadata
    const mute = new Worker(`require('worker_threads').parentPort.postMessage(
        { tag: 'pubsub:register', producerId: 'nru-mute', entries: [{ name: 'x', type: 't' }] });
        setInterval(() => {}, 1000);`, { eval: true });
    const detach = getBus().attachWorker(mute);
    await new Promise(r => mute.once('message', r));
    await new Promise(r => setImmediate(r));

    const started = Date.now();
    try {
        await assert.rejects(Promise.resolve(getBus().getMetadata('nru-mute', 'x')), /did not reply within 5000 ms/);
        assert.match(await workerSide, /no reply from the main thread within 5000 ms/);
        assert.ok(Date.now() - started >= 4500);
    } finally {
        detach();
        await lonely.terminate();
        await mute.terminate();
    }
});
