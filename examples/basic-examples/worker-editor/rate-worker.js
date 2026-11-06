'use strict';

// Runs in a worker thread. Keeps the arrival times inside the window.
module.exports = function (worker, data) {
    let times = [];
    let total = 0;

    const report = () => {
        const start = Date.now() - data.windowMs;
        times = times.filter(t => t > start);
        worker.parentPorts.publish('rate', { rate: times.length * 1000 / data.windowMs, total });
    };

    worker.parentPorts.subscribe('tick', (time) => { times.push(time); total++; });
    // Answers worker.request('reset'): the total before the reset
    worker.handle('reset', () => {
        const before = total;
        times = [];
        total = 0;
        report();
        return before;
    });

    const timer = setInterval(report, 1000);
    worker.parentPorts.subscribe('close', () => clearInterval(timer));
};
