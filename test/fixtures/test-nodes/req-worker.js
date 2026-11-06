'use strict';

// Test worker for request(): each worker.handle() type answers in a different way.
module.exports = function (worker) {
    worker.handle('double', (n) => n * 2);
    worker.handle('slow', ({ n, ms }) => new Promise(resolve => setTimeout(() => resolve(n), ms)));
    worker.handle('fail', () => { throw new TypeError('bad input from worker'); });
    worker.handle('hang', () => new Promise(() => {}));
    worker.parentPorts.subscribe('crash', () => setTimeout(() => { throw new Error('async boom'); }));
    worker.parentPorts.subscribe('emit', () => worker.parentPorts.publish('boom', 1));
};
