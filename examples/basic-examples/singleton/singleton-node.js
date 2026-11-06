'use strict';

const { NodeRedNodeBase, nodeRedSingleton } = require('@nrutils/node-red-utils');

module.exports = NodeRedNodeBase.createNode('singleton-node', [nodeRedSingleton], (RED, thisNode, config) => {
    // The editor allows only one node of this type
    thisNode.on('input', (msg, send, done) => {
        msg.singleton = true;
        send(msg);
        done();
    });
});
