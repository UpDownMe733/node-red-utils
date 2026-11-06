'use strict';

const { NodeRedNodeBase, nodeRedPopup, nodeRedEditorComms } = require('@nrutils/node-red-utils');

module.exports = NodeRedNodeBase.createNode('popup-node', [nodeRedPopup, nodeRedEditorComms], (RED, thisNode, config) => {
    let lastMessage = null;

    thisNode.nodeRedEditorComms.subscribe('getLastMessage', () => {
        thisNode.nodeRedEditorComms.publish('lastMessage', lastMessage);
    });

    thisNode.on('input', (msg, send, done) => {
        lastMessage = { payload: msg.payload, time: new Date().toISOString() };
        thisNode.nodeRedEditorComms.publish('lastMessage', lastMessage);
        send(msg);
        done();
    });
});
