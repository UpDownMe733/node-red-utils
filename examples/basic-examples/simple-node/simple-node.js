'use strict';

const { NodeRedNodeBase } = require('@nrutils/node-red-utils');

module.exports = NodeRedNodeBase.createNode('simple-node', [], (RED, thisNode, config) => {
    thisNode.on('input', (msg, send, done) => {
        msg.payload = { original: msg.payload, timestamp: Date.now() };
        send(msg);
        done();
    });
});
