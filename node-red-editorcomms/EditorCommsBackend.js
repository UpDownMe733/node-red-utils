/**
 * Copyright 2024 Contributors
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

'use strict';

const path = require('path');
const { NodeRedResourceEndpoint } = require('../node-red-resourceendpoint/NodeRedResourceEndpoint.js');

// All copies of this library in one process share this state.
// Thus one POST route serves the handlers of every copy.
const shared = globalThis[Symbol.for('node-red-utils.editorcomms')] ??= {};
shared.handlers ??= new Map();      // nodeId.messageType -> callback

/** Serve EditorCommsFrontend.js and add the POST route. Safe to call more than one time. */
function setup(RED) {
    new NodeRedResourceEndpoint(RED).registerResources('node-red-editorcomms', path.join(__dirname, 'EditorCommsFrontend.js'));
    if (shared.routeRegistered) return;
    shared.routeRegistered = true;
    // Single endpoint for all communication
    RED.httpAdmin.post('/node_red_editorcomms', RED.auth.needsPermission('write'), async (req, res) => {
        const { messageType, nodeId, payload } = req.body || {};
        const handler = shared.handlers.get(nodeId + '.' + messageType);
        if (!handler) {
            // For example a node that is not deployed yet
            res.status(404).json({ status: 'no handler' });
            return;
        }
        let result;
        try {
            result = await handler(payload);
        } catch (error) {
            const message = (error && error.message) || String(error);
            const node = RED.nodes.getNode(nodeId);
            if (node) node.error(`Editor message '${messageType}' failed: ${message}`);
            res.status(500).json({ error: message });
            return;
        }
        res.json({ status: 'ok', result });
    });
}

/**
 * NodeRedEditorComms - Class for managing communication between the Node-RED editor and runtime
 * Allows nodes to publish and subscribe to messages between the editor and backend
 */
class NodeRedEditorComms {

    /**
     * Create a new editor communications handler
     * @param {object} RED - The Node-RED runtime instance
     * @param {object} node - The node instance
     */
    constructor(RED, node) {
        this.RED = RED;
        this.node = node;
        this.STATIC_TOPIC = 'node_red_editorcomms';

        setup(RED);

        // Remove the handlers of this node when the node closes
        this.ownedKeys = new Map();
        node.on('close', () => {
            for (const [key, callback] of this.ownedKeys) {
                if (shared.handlers.get(key) === callback) shared.handlers.delete(key);
            }
            this.ownedKeys.clear();
        });
    }

    /**
     * Subscribe to messages of a specific type
     * @param {string} messageType - The type of message to subscribe to
     * @param {Function} callback - Called with the payload. Its return value (or the value of its Promise) goes back to the editor.
     */
    subscribe(messageType, callback) {
        const key = this.node.id + '.' + messageType;
        shared.handlers.set(key, callback);
        this.ownedKeys.set(key, callback);
    }

    /**
     * Publish a message to subscribers
     * @param {string} messageType - The type of message to publish
     * @param {any} payload - The payload to send with the message
     */
    publish(messageType, payload) {
        const message = {
            id: this.STATIC_TOPIC,
            retain: false,
            payload: {
                messageType,
                nodeId: this.node.id,
                payload
            }
        };
        this.RED.events.emit('runtime-event', message);
    }
}

/**
 * Mixin that adds editor communication capabilities to Node-RED nodes
 * 
 * Allows nodes to communicate between the editor frontend and the runtime backend
 * 
 * @param {class} superclass - The class to extend with editor comms capabilities
 * @returns {class} A new class that extends the superclass with editor comms functionality
 */
const nodeRedEditorComms = (superclass) => class extends superclass {
    // Serve the frontend script and the POST route before the first deploy
    static onRegisterType(RED) {
        super.onRegisterType?.(RED);
        setup(RED);
    }

    constructor(RED, thisNode, config) {
        super(RED, thisNode, config);

        // Create the editor comms handler for this node
        const editorComms = new NodeRedEditorComms(RED, thisNode);

        const commsInterface = {
            /**
             * Subscribe to messages of a specific type
             * @param {string} messageType - The type of message to subscribe to
             * @param {Function} callback - The callback function to invoke when messages are received
             */
            subscribe: function(messageType, callback) {
                editorComms.subscribe(messageType, callback);
                return this;
            },

            /**
             * Publish a message to subscribers
             * @param {string} messageType - The type of message to publish
             * @param {any} payload - The payload to send with the message
             */
            publish: function(messageType, payload) {
                editorComms.publish(messageType, payload);
                return this;
            }
        };

        // Make available on both
        this.nodeRedEditorComms = commsInterface;
        thisNode.nodeRedEditorComms = commsInterface;

    }
};

// Export both the class and the mixin
module.exports.nodeRedEditorComms = nodeRedEditorComms;
module.exports.NodeRedEditorComms = NodeRedEditorComms;