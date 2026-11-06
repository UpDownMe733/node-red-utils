'use strict';

const { NodeRedNodeBase, nodeRedEditorComms } = require('@nrutils/node-red-utils');

module.exports = NodeRedNodeBase.createNode('editor-comms-node', [nodeRedEditorComms], (RED, thisNode, config) => {
    let messageCount = 0;

    // A request from the editor. The return value goes back to the editor.
    thisNode.nodeRedEditorComms.subscribe('getStats', () => ({ count: messageCount }));

    thisNode.on('input', (msg, send, done) => {
        messageCount++;
        // Notify editor of new message
        thisNode.nodeRedEditorComms.publish('messageReceived', { count: messageCount });
        send(msg);
        done();
    });
});
