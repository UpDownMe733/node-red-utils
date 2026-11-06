'use strict';

const path = require('path');
const { NodeRedNodeBase, nodeRedWorker, nodeRedEditorComms } = require('@nrutils/node-red-utils');

module.exports = NodeRedNodeBase.createNode('rate-meter', [nodeRedWorker, nodeRedEditorComms], (RED, thisNode, config) => {
    const worker = thisNode.nodeRedWorker.init(path.join(__dirname, 'rate-worker.js'), { windowMs: 5000 });

    // The worker reports one time each second: to the node status and to an open edit dialog
    worker.subscribe('rate', ({ rate, total }) => {
        const text = `${rate.toFixed(1)} msg/s, ${total} total`;
        thisNode.status({ fill: 'green', shape: 'dot', text });
        thisNode.nodeRedEditorComms.publish('rate', text);
    });

    // From the Reset button in the edit dialog. The worker's answer goes back to the dialog.
    thisNode.nodeRedEditorComms.subscribe('reset', () => worker.request('reset'));

    thisNode.on('input', (msg, send, done) => {
        worker.publish('tick', Date.now());
        send(msg);
        done();
    });
});
