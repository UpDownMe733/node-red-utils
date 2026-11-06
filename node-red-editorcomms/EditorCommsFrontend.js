/**
 * Copyright 2024 Contributors
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

//
//  Begin EditorCommsFrontend.js
//
//      Frontend communication handler for Node-RED editor.
//      Manages pub/sub messaging between frontend and backend components.
//

if (!window.EditorCommsFrontend) {

    window.EditorCommsFrontend = class EditorCommsFrontend {

        static #handlers = new Map();

        constructor() {
            this.nodeId = null;
            this.STATIC_TOPIC = 'node_red_editorcomms';
            return this;
        }

        static getHandlers() { return this.#handlers }
        static clearHandlers() { this.#handlers.clear() }
        static setHandler(key, handler) { this.#handlers.set(key, handler) }

        // subscribe(type, callback) listens to this node; subscribe(type, nodeId, callback) to another node
        subscribe(messageType, nodeId, callback) {
            if (typeof nodeId === 'function') { callback = nodeId; nodeId = this.nodeId; }
            const key = nodeId + "." + messageType;
            EditorCommsFrontend.#handlers.set(key, callback);
        }

        // Returns a Promise that resolves with the return value of the runtime handler.
        // It rejects with an Error that has a status: 404 (no handler, for example
        // the node is not deployed), 500 (the handler threw) or 0 (no connection).
        publish(messageType, payload) {

            const message = {
                messageType,
                payload,
                nodeId: this.nodeId
            };

            return new Promise((resolve, reject) => {
                $.ajax({
                    url: this.STATIC_TOPIC,      // relative: works with httpAdminRoot and proxy paths
                    type: 'POST',
                    data: JSON.stringify(message),
                    contentType: 'application/json'
                }).then((body) => resolve(body && body.result), (jqXHR, textStatus, errorThrown) => {
                    const body = jqXHR.responseJSON || {};
                    const text = jqXHR.status === 404 ? 'no handler for ' + messageType + ': deploy the node first'
                        : body.error || errorThrown || textStatus;
                    console.error('Failed to publish:', messageType, text);
                    reject(Object.assign(new Error(text), { status: jqXHR.status }));
                });
            });
        }
    }

    // Hold messages until the editor has drawn the flows. Handlers that
    // touch the view or the DOM fail before that.
    let flowsLoaded = !!RED.workspaces.active();
    const pending = [];
    const dispatch = ({ messageType, nodeId, payload }) => {
        const handler = window.EditorCommsFrontend.getHandlers().get(nodeId + "." + messageType);
        if (handler) handler(payload);
    };
    RED.events.on('flows:loaded', () => {
        flowsLoaded = true;
        pending.splice(0).forEach(dispatch);
    });
    RED.comms.subscribe('notification/node_red_editorcomms', (topic, data) => {
        if (flowsLoaded) dispatch(data);
        else pending.push(data);
    });

    // Remove the handlers of a node that is deleted in the editor
    RED.events.on('nodes:remove', (node) => {
        const handlers = window.EditorCommsFrontend.getHandlers();
        for (const key of handlers.keys()) {
            if (key.startsWith(node.id + '.')) handlers.delete(key);
        }
    });

    // add nodeRedEditorComms to every node
    RED.events.on('nodes:add', async (node) => {

        // Give every node its own comms instance
        node.nodeRedEditorComms = new window.EditorCommsFrontend();
        node.nodeRedEditorComms.nodeId = node.id;
        
        // Add developer subscriptions if defined
        if (node?._def?.nodeRedEditorComms_subscriptions) {
            Object.entries(node._def.nodeRedEditorComms_subscriptions).forEach(([type, handler]) => 
                window.EditorCommsFrontend.getHandlers().set(`${node.id}.${type}`, handler.bind(node))
            );
        }
    });

}
