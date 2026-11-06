'use strict';

// Tests that need no Node-RED process.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { NodeRedNodeBase } = require('../node-red-base/NodeRedNodeBase.js');

describe('NodeRedNodeBase.createNode options', () => {
    const fakeRED = () => {
        const calls = [];
        return { calls, nodes: { registerType: (...args) => calls.push(args), createNode() {} } };
    };

    it('passes options to RED.nodes.registerType', () => {
        const RED = fakeRED();
        const options = { credentials: { secret: { type: 'password' } } };
        NodeRedNodeBase.createNode('x', [], () => {}, options)(RED);
        assert.equal(RED.calls.length, 1);
        assert.equal(RED.calls[0][0], 'x');
        assert.deepEqual(RED.calls[0][2], options);
    });

    it('does not pass resources on to RED.nodes.registerType', () => {
        const RED = fakeRED();
        NodeRedNodeBase.createNode('x', [], () => {}, { resources: ['/tmp/a'], settings: {} })(RED);
        assert.deepEqual(RED.calls[0][2], { settings: {} });
    });

    it('passes undefined when no options are given', () => {
        const RED = fakeRED();
        NodeRedNodeBase.createNode('x', [], () => {})(RED);
        assert.equal(RED.calls[0][2], undefined);
    });

    it('rejects options that are not an object', () => {
        assert.throws(() => NodeRedNodeBase.createNode('x', [], () => {}, 'creds'), /options must be an object.*got string/);
    });
});

describe('editor comms frontend subscribe', () => {
    const load = ($ = {}) => {
        const fs = require('fs');
        const path = require('path');
        const vm = require('node:vm');
        const win = {};
        const RED = { workspaces: { active: () => true }, events: { on() {} }, comms: { subscribe() {} } };
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'node-red-editorcomms', 'EditorCommsFrontend.js'), 'utf8'),
            { window: win, RED, $, console: { error() {} }, Promise, Error, Object });
        return win.EditorCommsFrontend;
    };

    // A fake $.ajax that answers like jQuery: then(done(body), fail(jqXHR, textStatus, errorThrown))
    const ajaxAnswer = (status, body) => ({ ajax: () => ({ then: (ok, fail) => (status === 200
        ? ok(body) : fail({ status, responseJSON: body }, 'error', 'Internal Server Error')) }) });

    it('publish() resolves with the result of the runtime handler', async () => {
        const comms = new (load(ajaxAnswer(200, { status: 'ok', result: 42 })))();
        assert.equal(await comms.publish('double', 21), 42);
    });

    it('publish() rejects with the status and the error of the runtime', async () => {
        const failed = new (load(ajaxAnswer(500, { error: 'async fail' })))();
        await assert.rejects(failed.publish('fail'), (err) => err.status === 500 && err.message === 'async fail');
        const missing = new (load(ajaxAnswer(404, { status: 'no handler' })))();
        await assert.rejects(missing.publish('x'), (err) => err.status === 404 && /deploy the node first/.test(err.message));
    });

    it('accepts subscribe(type, callback) and subscribe(type, nodeId, callback)', () => {
        const Comms = load();
        const comms = new Comms();
        comms.nodeId = 'n1';
        const a = () => {}, b = () => {};
        comms.subscribe('short', a);
        comms.subscribe('long', 'n2', b);
        assert.equal(Comms.getHandlers().get('n1.short'), a);
        assert.equal(Comms.getHandlers().get('n2.long'), b);
    });
});

describe('async setup', () => {
    it('reports the rejection of an async setup on the node', async () => {
        let ctor;
        const RED = { nodes: { registerType: (type, fn) => { ctor = fn; }, createNode() {} } };
        NodeRedNodeBase.createNode('x', [], async () => { throw new Error('late boom'); })(RED);
        const errors = [];
        ctor.call({ error: (e) => errors.push(e) }, {});
        await new Promise(r => setImmediate(r));
        assert.deepEqual(errors, ['setup of x failed: late boom']);
    });
});

describe('pubsub subscriber errors', () => {
    const { NodeRedPubsubBus, nodeRedPubsubBus, getBus } = require('../node-red-pubsub-bus/NodeRedPubsubBus.js');
    const entries = () => [{ name: 'e', type: 't' }];

    it('a handler that throws or rejects does not stop the others or the producer', async () => {
        const bus = new NodeRedPubsubBus();
        const errors = [];
        const got = [];
        bus.registerProducer('p', { getEntries: entries, getMetadata: () => 1 });
        // Let the connect replay pass
        bus.subscribe('p/e', (e) => { if (e.kind === 'change') throw new Error('sync'); }, (err) => errors.push(err.message));
        bus.subscribe('p/e', async (e) => { if (e.kind === 'change') throw new Error('async'); }, (err) => errors.push(err.message));
        bus.subscribe('p/e', (e) => got.push(e.kind));
        await new Promise(r => setImmediate(r));
        bus.notifyChange('p', 'e');
        await new Promise(r => setImmediate(r));
        assert.deepEqual(got, ['connect', 'change']);
        assert.deepEqual(errors.sort(), ['async', 'sync']);
    });

    it('the mixin reports a failed handler with node.error', async () => {
        const errors = [];
        const node = { id: 'n', on() {}, error: (e) => errors.push(e), status() {} };
        const Node = nodeRedPubsubBus(class {});
        new Node({}, node, {});
        const unregister = getBus().registerProducer('nru-unit-p', { getEntries: entries, getMetadata: () => 1 });
        try {
            node.nodeRedPubsubBus.subscribe('nru-unit-p/e', async () => { throw new Error('consumer boom'); });
            await new Promise(r => setImmediate(r));
            assert.deepEqual(errors, ['pubsub subscriber of nru-unit-p/e failed: consumer boom']);
        } finally {
            unregister();
        }
    });
});

describe('pubsub bus getMetadata and notifyChange', () => {
    const path = require('path');
    const { Worker } = require('worker_threads');
    const { getBus } = require('../node-red-pubsub-bus/NodeRedPubsubBus.js');
    const PROXY = path.join(__dirname, '..', 'node-red-pubsub-bus', 'NodeRedPubsubBusWorkerProxy.js');

    it('returns a Promise for a main-thread producer and for no producer', async () => {
        const bus = getBus();
        const unregister = bus.registerProducer('nru-unit-main', { getEntries: () => [{ name: 'e', type: 't' }], getMetadata: () => 7 });
        try {
            const value = bus.getMetadata('nru-unit-main', 'e');
            assert.ok(value instanceof Promise);
            assert.equal(await value, 7);
            const none = bus.getMetadata('nru-unit-none', 'e');
            assert.ok(none instanceof Promise);
            assert.equal(await none, null);
        } finally { unregister(); }
    });

    it('returns a Promise for a worker producer', async () => {
        const code = `
            const proxy = require(${JSON.stringify(PROXY)});
            proxy.registerProducer('nru-unit-worker', { getEntries: () => [{ name: 'e', type: 't' }], getMetadata: () => 8 });`;
        const worker = new Worker(code, { eval: true });
        const detach = getBus().attachWorker(worker);
        try {
            const bus = getBus();
            const end = Date.now() + 3000;
            while (!bus.listProducers().some(p => p.producerId === 'nru-unit-worker') && Date.now() < end) {
                await new Promise(r => setTimeout(r, 20));
            }
            const value = bus.getMetadata('nru-unit-worker', 'e');
            assert.ok(value instanceof Promise);
            assert.equal(await value, 8);
        } finally {
            detach();
            await worker.terminate();
        }
    });

    it('notifyChange returns false and sends nothing for a name that is not in getEntries()', () => {
        const bus = getBus();
        const unregister = bus.registerProducer('nru-unit-nc', { getEntries: () => [{ name: 'e', type: 't' }], getMetadata: () => 1 });
        const events = [];
        const unsubscribe = bus.subscribe('nru-unit-nc/other', (event) => events.push(event));
        try {
            assert.equal(bus.notifyChange('nru-unit-nc', 'other'), false);
            assert.equal(bus.notifyChange('nru-unit-nc', 'e'), true);
            assert.deepEqual(events, []);
        } finally { unsubscribe(); unregister(); }
    });
});

describe('nodeRedWorker without Node-RED', () => {
    const path = require('path');
    const EventEmitter = require('events');
    const { nodeRedWorker, NodeRedWorker } = require('../node-red-worker/NodeRedWorker.js');
    const makeNode = () => {
        const RED = { events: new EventEmitter(), log: { error() {} } };
        const node = Object.assign(new EventEmitter(), { id: 'unit', error() {}, status() {} });
        new (NodeRedNodeBase.with(nodeRedWorker))(RED, node, {});
        return node;
    };

    it('request(), on() and terminate() before init() throw the "call init() first" error', () => {
        const node = makeNode();
        for (const call of ['request', 'on', 'terminate', 'publish', 'subscribe']) {
            assert.throws(() => node.nodeRedWorker[call]('x', () => {}), /call init\(\) before/, call);
        }
    });

    it('close calls done also when terminate() rejects', async () => {
        const node = makeNode();
        const worker = node.nodeRedWorker.init(path.join(__dirname, 'fixtures', 'test-nodes', 'worker.js'), {});
        worker.terminate = () => Promise.reject(new Error('terminate failed'));
        try {
            const done = await Promise.race([
                new Promise(resolve => node.emit('close', () => resolve(true))),
                new Promise(resolve => setTimeout(() => resolve(false), 1000))]);
            assert.equal(done, true);
        } finally {
            await NodeRedWorker.prototype.terminate.call(worker);
        }
    });
});
