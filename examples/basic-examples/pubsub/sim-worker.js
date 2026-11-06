'use strict';

// Runs in a worker thread. "data" is the object given to init() in sensor-sim.js.
const pubsub = require('@nrutils/node-red-utils/node-red-pubsub-bus-workerproxy');

module.exports = function (worker, data) {
    let reading = null;

    // The producer id is the node id. getEntries() returns [] until the first reading.
    pubsub.registerProducer(data.id, {
        getEntries: () => (reading === null ? [] : [{ name: 'reading', type: 'example/reading_v1' }]),
        getMetadata: (name) => (name === 'reading' ? reading : null)
    });

    // Random walk around 20, a new reading every 500 ms
    setInterval(() => {
        reading = Math.round(((reading ?? 20) + Math.random() - 0.5) * 100) / 100;
        pubsub.notifyChange(data.id, 'reading');
        worker.parentPorts.publish('reading', reading);
    }, 500);
};
