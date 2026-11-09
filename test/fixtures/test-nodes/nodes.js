'use strict';

// Test nodes. The test copies this package (with its own copy of the library
// in ./lib) into a scratch Node-RED userDir, one time for each package name.

const path = require('path');
const lib = (file) => require(path.join(__dirname, 'lib', file));
const { NodeRedNodeBase } = lib('node-red-base/NodeRedNodeBase.js');
const { NodeRedResourceEndpoint, nodeRedResourceEndpoint } = lib('node-red-resourceendpoint/NodeRedResourceEndpoint.js');
const { nodeRedWorker, NodeRedWorker } = lib('node-red-worker/NodeRedWorker.js');
const { nodeRedPubsubBus, getBus } = lib('node-red-pubsub-bus/NodeRedPubsubBus.js');
const { nodeRedEditorComms } = lib('node-red-editorcomms/EditorCommsBackend.js');
const { nodeRedPopup } = lib('node-red-popup/NodeRedPopupBackend.js');
const { nodeRedSingleton } = lib('node-red-singleton/NodeRedSingletonBackend.js');

const name = require('./package.json').name;

module.exports = function (RED) {
    let stats;
    const reset = () => { stats = { processed: {}, got: {}, starts: {}, comms: {}, inputs: {}, status: {}, seen: {}, defaults: {}, pubsub: {}, pings: {}, polled: {}, cred: {}, initError: {}, exits: {}, answers: {}, rejects: {}, caught: {}, after: {}, afterThrow: {}, handlerData: {}, stub: {} }; };
    const record = (group, id, value) => { (stats[group][id] ??= []).push(value); };
    reset();

    new NodeRedResourceEndpoint(RED).registerResources(name, [path.join(__dirname, 'public')]);

    NodeRedNodeBase.createNode(name + '-worker', [nodeRedWorker], (RED, node) => {
        const status = node.status.bind(node);
        node.status = (s) => { record('status', node.id, s.text); status(s); };
        if (node.name === 'relative-path') {
            try { node.nodeRedWorker.init('worker.js'); } catch (e) { record('initError', node.id, e.message); }
            return;
        }
        // 'late' calls init() after flows:started, as a node does after an await
        if (node.name === 'late') setTimeout(() => start(node), 300);
        else start(node);
    })(RED);

    const workerFiles = { 'bad-load': 'bad-worker.js', 'bad-export': 'no-export-worker.js', esm: 'esm-worker.mjs' };
    function start(node) {
        const worker = node.nodeRedWorker.init(path.join(__dirname, workerFiles[node.name] || 'worker.js'), { id: node.id });
        worker.on('exit', () => record('exits', node.id, 1));
        worker.subscribe('inputs', (n) => record('inputs', node.id, n));
        worker.subscribe('started', () => record('starts', node.id, 1));
        worker.subscribe('processed', (p) => record('processed', node.id, p));
        worker.subscribe('got', (p) => record('got', node.id, p));
        worker.subscribe('seen', (p) => record('seen', node.id, p));
        worker.subscribe('ping', () => record('pings', node.id, 1));
        worker.subscribe('polled', (p) => record('polled', node.id, p));
        worker.subscribe('default', (d, s, r, type) => record('defaults', node.id, type));
        worker.publish('process', 'early-' + node.id);     // sent before the worker file runs
        node.on('input', (msg) => worker.publish(msg.topic || 'process', msg.payload));
    }

    // request(): the input topic is the request type, msg.timeout the optional timeout
    NodeRedNodeBase.createNode(name + '-req', [nodeRedWorker], (RED, node) => {
        if (node.name === 'stub') {
            for (const call of ['request', 'on', 'terminate']) {
                try { node.nodeRedWorker[call]('x', () => {}); } catch (e) { record('stub', node.id, call + ': ' + e.message); }
            }
            return;
        }
        const worker = node.nodeRedWorker.init(path.join(__dirname, 'req-worker.js'));
        worker.subscribe('boom', () => { throw new Error('handler boom'); });
        worker.subscribe('boom', () => record('after', node.id, 1));
        worker.subscribe('handler-data', (data) => record('handlerData', node.id, data));
        worker.subscribe('after-throw', () => record('afterThrow', node.id, 1));
        node.on('input', (msg, send, done) => {
            if (['crash', 'emit', 'throw', 'throw-data'].includes(msg.topic)) { worker.publish(msg.topic, msg.payload); return done(); }
            worker.request(msg.topic, msg.payload, [], { timeout: msg.timeout }).then(
                (answer) => { record('answers', node.id, [msg.payload, answer]); done(); },
                (err) => { record('rejects', node.id, err.message); done(err); });
        });
    })(RED);

    // Records msg.error.message, for a Catch node
    NodeRedNodeBase.createNode(name + '-rec', [], (RED, node) => {
        node.on('input', (msg) => record('caught', node.id, msg.error && msg.error.message));
    })(RED);

    // Files from the createNode options, served before any deploy
    NodeRedNodeBase.createNode(name + '-res', [nodeRedResourceEndpoint], () => {},
        { resources: [path.join(__dirname, 'public', 'hello.js')] })(RED);

    NodeRedNodeBase.createNode(name + '-cred', [], (RED, node) => {
        record('cred', node.id, node.credentials.secret);
    }, { credentials: { secret: { type: 'password' } } })(RED);

    NodeRedNodeBase.createNode(name + '-sub', [nodeRedPubsubBus], (RED, node) => {
        node.nodeRedPubsubBus.subscribe('x/y', () => {});
        node.nodeRedPubsubBus.registerProducer(name + '-prod', {
            getEntries: () => [{ name: 'e', type: 't' }],
            getMetadata: () => null
        });
    })(RED);

    // Producer in a worker, set up as node-red-pubsub-bus/README.md shows. Producer id: node name or node id.
    NodeRedNodeBase.createNode(name + '-psworker', [nodeRedWorker, nodeRedPubsubBus], (RED, node) => {
        const worker = node.nodeRedWorker.init(path.join(__dirname, 'pubsub-worker.js'), { id: node.name || node.id });
        node.nodeRedPubsubBus.attachWorker(worker);
    })(RED);

    // Records the kind of each event on <node name>/latest
    NodeRedNodeBase.createNode(name + '-pssub', [nodeRedPubsubBus], (RED, node) => {
        node.nodeRedPubsubBus.subscribe(node.name + '/latest', (event) => record('pubsub', node.id, event.kind));
    })(RED);

    NodeRedNodeBase.createNode(name + '-comms', [nodeRedEditorComms], (RED, node) => {
        record('comms', node.id, 'created');
        node.nodeRedEditorComms.subscribe('ping', () => record('comms', node.id, 1));
        node.nodeRedEditorComms.subscribe('double', async (n) => n * 2);
        node.nodeRedEditorComms.subscribe('fail', async () => { throw new Error('async fail'); });
    })(RED);

    NodeRedNodeBase.createNode(name + '-ui', [nodeRedPopup, nodeRedSingleton], () => {})(RED);

    // Test-only routes, no auth
    RED.httpAdmin.get(`/${name}/stats`, (req, res) => res.json({
        ...stats,
        workers: NodeRedWorker._nodeRedWorkers.length,
        subscribers: getBus().listSubscribers('x/y'),
        producers: getBus().listProducers().map(p => p.producerId)
    }));
    RED.httpAdmin.get(`/${name}/pubsub/:id`, async (req, res) => {
        try { res.json({ value: await getBus().getMetadata(req.params.id, 'latest') }); }
        catch (err) { res.json({ error: err.message }); }
    });
    RED.httpAdmin.post(`/${name}/reset`, (req, res) => { reset(); res.sendStatus(200); });
    RED.httpAdmin.post(`/${name}/trigger/:id`, (req, res) => {
        const payload = req.query.payload !== undefined ? JSON.parse(req.query.payload) : 'trigger-' + req.params.id;
        const timeout = req.query.timeout !== undefined ? Number(req.query.timeout) : undefined;
        const node = RED.nodes.getNode(req.params.id);
        if (!node) return res.sendStatus(404);     // the new flow is not started yet after a deploy
        node.receive({ topic: req.query.topic, payload, timeout });
        res.sendStatus(200);
    });
};
