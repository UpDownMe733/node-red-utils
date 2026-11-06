'use strict';

const path = require('path');
const { NodeRedNodeBase, nodeRedResourceEndpoint } = require('@nrutils/node-red-utils');

module.exports = NodeRedNodeBase.createNode('resourceendpoint-node', [nodeRedResourceEndpoint], (RED, thisNode, config) => {
    thisNode.on('input', (msg, send, done) => {
        // Tell the flow where the file is served (relative to httpAdminRoot)
        msg.url = 'node-red-resourceendpoint/resourceendpoint-node/hello.txt';
        send(msg);
        done();
    });
}, {
    // Serve only the fixed public/ folder of this package, from when Node-RED loads the node
    resources: [path.join(__dirname, 'public')]
});
