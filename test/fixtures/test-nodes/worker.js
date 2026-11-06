'use strict';

// Test worker. It reports to the parent node what it receives.
module.exports = function (worker, data) {
    worker.parentPorts.publish('started', data.id);
    worker.parentPorts.subscribe('process', (payload) => {
        worker.parentPorts.publish('processed', payload);
        worker.outputPorts.publish('data', payload);
    });
    worker.parentPorts.subscribe('default', (d, s, r, type) => { if (type !== 'close') worker.parentPorts.publish('seen', type); });
    worker.parentPorts.subscribe('inputs', () => worker.parentPorts.publish('inputs', worker.inputPorts[0].length));
    worker.parentPorts.subscribe('crash', () => setTimeout(() => { throw new Error('async boom'); }));
    worker.parentPorts.subscribe('poll', () => {
        const connection = worker.parentPorts[0][0];
        const first = connection.publishUntilAcknowledged('ping', 'pong', 50, 1);
        const second = connection.publishUntilAcknowledged('ping', 'pong', 50, 1);
        second();
        worker.parentPorts.publish('polled', [typeof first, typeof second]);
    });
    worker.inputPorts.subscribe('data', (payload) => worker.parentPorts.publish('got', payload));

    // Early message to the downstream worker, sent before it is known to be ready
    worker.outputPorts.publish('data', 'hello-from-' + data.id);
};
