'use strict';

const path = require('path');
const { NodeRedNodeBase, nodeRedWorker, nodeRedPubsubBus } = require('@nrutils/node-red-utils');

// Producer: a simulated sensor in a worker thread. On close, nodeRedWorker stops
// the worker and the pubsub mixin removes the producer, so no close handler is needed.
module.exports = NodeRedNodeBase.createNode('sensor-sim', [nodeRedWorker, nodeRedPubsubBus], (RED, thisNode, config) => {
    const worker = thisNode.nodeRedWorker.init(path.join(__dirname, 'sim-worker.js'), { id: thisNode.id });
    thisNode.nodeRedPubsubBus.attachWorker(worker);

    worker.subscribe('reading', (value) => thisNode.status({ fill: 'green', shape: 'dot', text: String(value) }));
});
