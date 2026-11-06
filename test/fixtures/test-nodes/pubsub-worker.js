'use strict';

// Test worker: a pub/sub producer with one entry 'latest', a counter that grows every 50 ms.
const path = require('path');
const pubsub = require(path.join(__dirname, 'lib', 'node-red-pubsub-bus', 'NodeRedPubsubBusWorkerProxy.js'));

module.exports = function (worker, data) {
    let latest = null;
    pubsub.registerProducer(data.id, {
        getEntries: () => (latest === null ? [] : [{ name: 'latest', type: 'test/count' }]),
        getMetadata: (name) => (name === 'latest' ? latest : null)
    });
    setInterval(() => {
        latest = (latest || 0) + 1;
        pubsub.notifyChange(data.id, 'latest');
    }, 50);
};
