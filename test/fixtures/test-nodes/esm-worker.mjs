// Test worker as an ES module
export default function (worker, data) {
    worker.parentPorts.publish('started', data.id);
    worker.outputPorts.publish('data', 'hello-from-' + data.id);
}
