'use strict';

const path = require('path');
const { NodeRedNodeBase, nodeRedWorker } = require('@nrutils/node-red-utils');

module.exports = NodeRedNodeBase.createNode('worker-node', [nodeRedWorker], (RED, thisNode, config) => {
    const worker = thisNode.nodeRedWorker.init(
        path.join(__dirname, 'worker.js'),
        { iterations: config.iterations || 1000000 }
    );

    // Several messages can be in the worker at the same time. Each request() gets its own answer.
    thisNode.on('input', (msg, send, done) => {
        worker.request('compute', msg.payload).then((result) => {
            msg.payload = result;   // the original msg keeps _msgid and topic
            send(msg);
            done();
        }, done);                   // a throw in the worker, a DataCloneError, or the worker stopped
    });
});
