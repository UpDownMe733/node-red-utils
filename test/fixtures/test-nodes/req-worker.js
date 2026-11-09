'use strict';

// Test worker for request(): each worker.handle() type answers in a different way.
module.exports = function (worker) {
    worker.handle('double', (n) => n * 2);
    worker.handle('slow', ({ n, ms }) => new Promise(resolve => setTimeout(() => resolve(n), ms)));
    worker.handle('fail', () => { throw new TypeError('bad input from worker'); });
    worker.handle('hang', () => new Promise(() => {}));
    worker.parentPorts.subscribe('crash', () => setTimeout(() => { throw new Error('async boom'); }));
    worker.parentPorts.subscribe('emit', () => worker.parentPorts.publish('boom', 1));
    worker.parentPorts.subscribe('throw', () => { throw new Error('worker handler boom'); });
    worker.parentPorts.subscribe('throw', () => worker.parentPorts.publish('after-throw', 1));
    // Replaces the default for one type, to show the data of the message that the handler got
    const defaultHandlerError = worker.handlerError.bind(worker);
    worker.handlerError = (error, type, data) => type === 'throw-data'
        ? worker.parentPorts.publish('handler-data', data)
        : defaultHandlerError(error, type, data);
    worker.parentPorts.subscribe('throw-data', () => { throw new Error('data boom'); });
};
