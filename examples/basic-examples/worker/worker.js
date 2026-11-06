'use strict';

// Runs in a worker thread. "data" is the object given to init() in worker-node.js.
module.exports = function (worker, data) {
    const iterations = data.iterations;

    // The return value is the answer to worker.request('compute', value) in worker-node.js
    worker.handle('compute', (value) => {
        // CPU-intensive work runs here without blocking Node-RED
        let result = 0;
        for (let i = 0; i < iterations; i++) {
            result += Math.sqrt(i) * Math.sin(i);
        }
        return { input: value, computed: result, iterations };
    });
};
