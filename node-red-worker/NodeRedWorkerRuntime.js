/**
 * Copyright 2024 Contributors
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

//
// This class is created in the worker thread
//

'use strict';
const { parentPort, MessagePort } = require('worker_threads');

// Types that the library uses itself. 'default' handlers do not get them.
const isInternalType = (type) => type === 'ack' || type.startsWith('_');

/**
 * Walks a value and collects every unique ArrayBuffer / MessagePort found.
 * Used by Connection.pipe() so forwarded messages preserve zero-copy transfer
 * semantics across relay hops without the relay having to know the payload shape.
 */
function collectTransferables(obj, acc = new Set(), seen = new WeakSet()) {
    if (!obj || typeof obj !== 'object') return acc;
    if (seen.has(obj)) return acc;
    seen.add(obj);
    if (obj instanceof ArrayBuffer) { acc.add(obj); return acc; }
    if (ArrayBuffer.isView(obj)) { acc.add(obj.buffer); return acc; }
    if (obj instanceof MessagePort) { acc.add(obj); return acc; }
    for (const k in obj) collectTransferables(obj[k], acc, seen);
    return acc;
}

/**
 * Represents a connection between nodes with pub/sub capabilities
 * @extends {Object}
 */
class Connection extends Object {
    /**
     * Creates a new Connection
     * @param {MessagePort} messagePort - MessagePort for communication
     * @param {Connections} connections - Parent Connections instance
     */
    constructor(messagePort, trace) {
        super();
        this.trace = trace;
        this._intervalID = null;            // used in publishUntilAcknowledged
        this._subscribers = new Map();
        this.messagePort = messagePort;
        this.setMessagePort(messagePort);
        this._currentPollingTopic = null;
        this._currentPollingAckTopic = null;
        this._currentPollingAckHandler = null;
        this._currentPollingCancel = null;
        Object.defineProperty(this, 'length', { value: 1, writable: false, configurable: false });

        // namedPorts setup
        this._namedPortsMap = new Map();
        this.namedPorts = new Proxy({}, {
            get: (target, prop) => {
                if (prop === 'forEach') {
                    return (callback) => {
                        if (typeof callback !== 'function') {
                            throw new Error('Callback must be a function');
                        }
                        for (const [name, port] of this._namedPortsMap.entries()) {
                            callback(port, name, this.namedPorts);
                        }
                    };
                } else if (prop === 'length') {
                    return this._namedPortsMap.size;
                } else if (prop === Symbol.iterator) {
                    return function* () {
                        for (const [name, port] of this._namedPortsMap.entries()) {
                            yield [name, port];
                        }
                    }.bind(this);
                } else if (prop === 'delete') {
                    return (portName) => {
                        if (this._namedPortsMap.has(portName)) {
                            const port = this._namedPortsMap.get(portName);
                            if (port && typeof port.close === 'function') {
                                port.close();
                            }
                            return this._namedPortsMap.delete(portName);
                        }
                        return false;
                    };
                } else if (prop === 'deleteAll') {
                    return () => {
                        for (const port of this._namedPortsMap.values()) {
                            if (port && typeof port.close === 'function') {
                                port.close();
                            }
                        }
                        this._namedPortsMap.clear();
                        return true;
                    };
                } else if (typeof prop === 'string') {
                    return this._namedPortsMap.get(prop);
                }
                return target[prop];
            }
        });
    }

    /**
     * Creates a named MessageChannel 
     */
    createNamedPort(myPortName, theirPortName = myPortName) {
        const channel = new MessageChannel();
        this._namedPortsMap.set(myPortName, channel.port2);
        this.publish('_createNamedPort', { portName: theirPortName, port: channel.port1 }, [channel.port1]);
        return channel.port2;
    };

    /**
     * Forwards every raw message arriving on this connection's MessagePort to
     * the target's MessagePort, reconstructing transferList so ArrayBuffers
     * stay zero-copy across the hop. Used to build generic passthrough relay
     * workers (link in / link out / taps) without knowing the payload shape.
     *
     * @param {Connection|Connections|Ports} target - destination to pipe into.
     *   Connection: forward to its single messagePort. Connections/Ports: fan
     *   out to every contained Connection (only the first gets the transfer;
     *   remaining recipients receive structured-clone copies since a transferable
     *   can only be moved once).
     */
    pipe(target) {
        const resolveTargets = () => {
            if (target instanceof Connection) return [target];
            if (target && typeof target === 'object' && target._connections) {
                return Object.values(target._connections);
            }
            if (target && typeof target === 'object' && target._ports) {
                const out = [];
                for (const port of Object.values(target._ports)) {
                    if (port._connections) out.push(...Object.values(port._connections));
                }
                return out;
            }
            return [];
        };

        this.messagePort.on('message', (message) => {
            const targets = resolveTargets();
            if (targets.length === 0) return;
            const transferables = [...collectTransferables(message)];
            for (let i = 0; i < targets.length; i++) {
                const t = targets[i];
                if (!t.messagePort) continue;
                t.messagePort.postMessage(message, i === 0 ? transferables : []);
            }
        });
    }

    /**
     * Sets or updates the message port for this connection and establishes message handling
     * @param {MessagePort} messagePort - The message port to use for communication
     * @returns {void}
     * 
     * @description
     * This method assigns a MessagePort to the connection and sets up event listeners
     * to handle incoming messages. When a message arrives, it:
     * 1. Extracts trace information for the receiver
     * 2. Processes the message data and sender trace
     * 3. Calls appropriate subscribers at multiple levels (port group, port, and connection)
     * 4. Routes the message to the handlers of its type and to the 'default' handlers
     * 
     * If the messagePort parameter is falsy, the method returns early without making changes.
     */
    setMessagePort(messagePort) {
        if (!messagePort) return;
        this.messagePort = messagePort;
        this.linkId = null;
        messagePort.on('message', (message) => {
            if (this.messagePort !== messagePort) return;   // a port that was replaced or removed
            const { baseObject, basePortsGroup, portIndex } = this.trace;
            const levels = [baseObject[basePortsGroup], baseObject[basePortsGroup][portIndex], this];

            // Before the worker file runs, keep a message that has no handler yet.
            // The runtime sends it again after the worker file adds its subscriptions.
            if (!baseObject._ready && typeof message?.type === 'string' &&
                !levels.some(level => level._subscribers.has(message.type))) {
                baseObject._earlyMessages.push({ connection: this, message });
                return;
            }
            this._dispatch(message);
        });
    }

    /**
     * Calls the subscribers of a message at the port group, port, and connection levels
     * @param {object} message - The received message
     * @private
     */
    async _dispatch(message) {
        // Other users of the port (e.g. the pubsub proxy) send messages without a type
        if (typeof message?.type !== 'string') return;
        const { baseObject, basePortsGroup, portIndex, connectionIndex } = this.trace;
        // A request() from the main thread goes to its worker.handle() handler only
        if (message.requestId !== undefined) return baseObject._answer(this, message);
        const receiverTrace = { nodeId: baseObject.nodeId, basePortsGroup, portIndex, connectionIndex };
        const { type, data, senderTrace } = message;
        // The handlers at the port group, port and connection levels, in this order.
        // A handler that fails goes to worker.handlerError(); the next handlers still run.
        for (const subscriberMap of [baseObject[basePortsGroup]._subscribers,
            baseObject[basePortsGroup][portIndex]._subscribers, this._subscribers]) {
            const handlers = subscriberMap.get(type) || [];
            const defaultHandlers = isInternalType(type) ? [] : subscriberMap.get('default') || [];
            for (const handler of [...handlers, ...defaultHandlers]) {
                try {
                    await handler(data, senderTrace, receiverTrace, type);
                } catch (error) {
                    baseObject.handlerError(error, type, data);
                }
            }
        }
    }

    /**
     * Subscribes to a message type
     * @param {string} type - The message type to subscribe to
     * @param {Function} handler - Handler function to call when messages of this type arrive
     * @throws {Error} If handler is not a function
     */
    subscribe(type, handler) {
        if (typeof handler !== 'function') { throw new Error('Handler must be a function') };
        if (!this._subscribers.has(type)) { this._subscribers.set(type, []) };
        this._subscribers.get(type).push(handler);
    }

    /**
     * Unsubscribes a handler from a message type
     * @param {string} type - The message type to unsubscribe from
     * @param {Function} handler - The handler function to remove
     * @returns {boolean} - Whether the handler was successfully removed
     */
    unsubscribe(type, handler) {
        if (!this._subscribers.has(type)) return false;
        const handlers = this._subscribers.get(type);
        const index = handlers.indexOf(handler);
        if (index !== -1) {
            handlers.splice(index, 1);
            if (handlers.length === 0) {
                this._subscribers.delete(type);
            }
            return true;
        }
        return false;
    }

    /**
     * Publishes a message to this connection
     * @param {string} type - The message type
     * @param {any} data - Data to send
     * @param {Array} [transferList=[]] - Optional array of transferable objects
     */
    publish(type, data, transferList = []) {
        if (!this.messagePort) {
            // silently fail
        } else {
            const { basePortsGroup, portIndex, connectionIndex } = this.trace;
            const nodeId = this.trace.baseObject.nodeId;
            const senderTrace = { nodeId, hostType: 'worker', basePortsGroup, portIndex, connectionIndex };
            this.messagePort.postMessage({ type, data, senderTrace }, transferList);
        }
    }

    /**
     * Repeatedly sends a message until an acknowledgment is received
     * @param {string} messageTopic - The message type to send
     * @param {string} ackTopic - The message type to wait for as acknowledgment
     * @param {number} interval - Milliseconds between retries
     * @param {any} data - Data to send
     * @param {Array} [transferList=[]] - Optional array of transferable objects
     * @returns {Function} cancel - Function to call to stop sending. If this topic is already polling, nothing is sent again and the cancel function of that poll is returned.
     */
    publishUntilAcknowledged(messageTopic, ackTopic, interval, data, transferList = []) {
        
        if (this._currentPollingTopic === messageTopic) return this._currentPollingCancel; // already polling this topic

        // Cancel any existing message polling
        if (this._publishIntervalId) {
            clearInterval(this._publishIntervalId);
            this._publishIntervalId = null;
            if (this._currentPollingTopic && this._currentPollingAckHandler) {
                this.unsubscribe(this._currentPollingAckTopic, this._currentPollingAckHandler);
                this._currentPollingAckHandler = null;
            }
        }

        // Store the current polling topic and ack topic
        this._currentPollingTopic = messageTopic;
        this._currentPollingAckTopic = ackTopic;

        // Publish the message
        this.publish(messageTopic, data, transferList);     // Send the first message immediately
        this._publishIntervalId = setInterval(() => {
            this.publish(messageTopic, data, transferList) }, interval);

        // Create and store the acknowledgment handler
        this._currentPollingAckHandler = (ackData, senderTrace, receiverTrace) => {
            clearInterval(this._publishIntervalId);
            this._publishIntervalId = null;
            this._currentPollingTopic = null;
            this._currentPollingAckTopic = null;
            this.unsubscribe(ackTopic, this._currentPollingAckHandler);
            this._currentPollingAckHandler = null;
        };
        
        // Subscribe to the acknowledgment topic
        this.subscribe(ackTopic, this._currentPollingAckHandler);

        // Return a cancel function
        this._currentPollingCancel = () => {
            if (this._publishIntervalId) {
                clearInterval(this._publishIntervalId);
                this._publishIntervalId = null;
            }
            
            if (this._currentPollingAckHandler) {
                this.unsubscribe(ackTopic, this._currentPollingAckHandler);
                this._currentPollingAckHandler = null;
            }
            
            this._currentPollingTopic = null;
            this._currentPollingAckTopic = null;
        };
        return this._currentPollingCancel;
    }

}

/**
 * Manages multiple connections for a port
 * @extends {Object}
 */
class Connections extends Object {
    /**
     * Creates a new Connections instance
     * @param {Ports} ports - Parent Ports instance
     * @returns {Proxy} A proxy that auto-creates connections on property access
     */
    constructor(trace) {
        super();
        this.trace = trace;
        this._subscribers = new Map();
        this._connections = {};

        Object.defineProperty(this, 'length', {
            get: () =>
                Object.keys(this._connections).length
        });

        // Make the class iterable
        this[Symbol.iterator] = function* () {
            for (const key of Object.keys(this._connections).sort((a, b) => Number(a) - Number(b))) {
                yield this._connections[key];
            }
        };

        return new Proxy(this, {
            get(target, prop) {
                if (typeof prop === 'string' && !isNaN(prop) && !(prop in target)) {
                    target.addConnection(Number(prop));
                }
                return target[prop];
            }
        });
    }

    forEach(callback) {
        if (typeof callback !== 'function') { throw new Error('Callback must be a function') };

        for (const [index, connection] of Object.entries(this._connections)) {
            callback(connection, Number(index), this);
        }
    }

    addConnection(connectionIndex, messagePort) {
        if (this._connections[connectionIndex]) {  // If the connection already exists but has no messagePort, just set the port
            if (messagePort) { this._connections[connectionIndex].setMessagePort(messagePort) };
        } else {  // Otherwise create a new connection
            this[connectionIndex] = new Connection(messagePort, { ...this.trace, connectionIndex });
            this._connections[connectionIndex] = this[connectionIndex];
        }
    }

    hasConnection(connectionIndex) {
        return connectionIndex in this._connections;
    }

    /**
     * Subscribes to a message type for all connections in this group
     * @param {string} type - The message type to subscribe to
     * @param {Function} handler - Handler function to call when messages of this type arrive
     * @throws {Error} If handler is not a function
     */
    subscribe(type, handler) {
        if (typeof handler !== 'function') { throw new Error('Handler must be a function') };
        if (!this._subscribers.has(type)) { this._subscribers.set(type, []) };
        this._subscribers.get(type).push(handler);
    }

    /**
     * Publishes a message to all connections in this group
     * @param {string} type - The message type
     * @param {any} data - Data to send
     * @param {Array} [transferList=[]] - Optional array of transferable objects
     */
    publish(type, data, transferList = []) {
        Object.values(this._connections).forEach(connection => {
            connection.publish(type, data, transferList);
        });
    }

    /**
     * Closes the connection with this linkId, if this port has it, and frees its slot
     * @returns {boolean} true if the connection was found
     */
    removeLink(linkId) {
        for (const connection of Object.values(this._connections)) {
            if (connection.linkId !== linkId) continue;
            connection.messagePort.close();
            connection.messagePort = null;
            connection.linkId = null;
            return true;
        }
        return false;
    }

    getNextConnectionNumber() {
        // First look for existing connections without messagePorts
        for (const [key, connection] of Object.entries(this._connections)) {
            if (!connection.messagePort) {
                return Number(key);
            }
        }
        // If no pending connections found, get next available number
        const numericKeys = Object.keys(this._connections)
            .filter(key => !isNaN(key))
            .map(Number);
        return numericKeys.length ? Math.max(...numericKeys) + 1 : 0;
    }

}

/**
 * Manages multiple ports for a base ports group
 * @extends {Object}
 */
class Ports extends Object {
    /**
     * Creates a new Ports instance
     * @param {NodeRedWorkerRuntime} basePortsGroup - Parent NodeRedWorkerRuntime instance
     * @returns {Proxy} A proxy that auto-creates ports on property access
     */
    constructor(trace) {
        super()
        this.trace = trace;
        this._subscribers = new Map();
        this._ports = {};

        Object.defineProperty(this, 'length', {
            get: () =>
                Object.keys(this._ports).length
        });

        this[Symbol.iterator] = function* () {
            for (const key of Object.keys(this._ports).sort((a, b) => Number(a) - Number(b))) {
                yield this._ports[key];
            }
        };

        return new Proxy(this, {
            get(target, prop) {
                if (typeof prop === 'string' && !isNaN(prop) && !(prop in target)) {
                    target.addPort(Number(prop));
                }
                return target[prop];
            }
        });
    }

    forEach(callback) {
        if (typeof callback !== 'function') {
            throw new Error('Callback must be a function');
        }

        for (const [index, port] of Object.entries(this._ports)) {
            callback(port, Number(index), this);
        }
    }

    addPort(portIndex) {
        this[portIndex] = new Connections({ ...this.trace, portIndex });
        this._ports[portIndex] = this[portIndex];
    }

    hasPort(portIndex) {
        return portIndex in this._ports;
    }

    /**
     * Subscribes to a message type for all ports in this group
     * @param {string} type - The message type to subscribe to
     * @param {Function} handler - Handler function to call when messages of this type arrive
     * @throws {Error} If handler is not a function
     */
    subscribe(type, handler) {
        if (typeof handler !== 'function') { throw new Error('Handler must be a function') };
        if (!this._subscribers.has(type)) { this._subscribers.set(type, []) };
        this._subscribers.get(type).push(handler);
    }

    /**
     * Publishes a message to all ports in this group
     * @param {string} type - The message type
     * @param {any} data - Data to send
     * @param {Array} [transferList=[]] - Optional array of transferable objects
     */
    publish(type, data, transferList = []) {
        Object.values(this._ports).forEach(port => {
            port.publish(type, data, transferList);
        });
    }

}

/**
 * Pub/Sub message communication between worker threads and the main thread in Node-RED
 */
class NodeRedWorkerRuntime {
    /**
     * Creates a new NodeRedWorkerRuntime instance
     * @param {string} workerPath - Path to the worker directory
     * @param {Function} [ConnectionsCompleteCallback=null] - Callback function executed when all connections are established
     */
    constructor(params) {
        // list all params here
        this._connectionsCompleteCallback = params.ConnectionsCompleteCallback;

        this.nodeId = null;
        this._started = false;      // true after the worker file was loaded
        this._ready = false;        // true after the worker file added its subscriptions
        this._earlyMessages = [];   // messages that arrived before _ready, in order
        this._handlers = new Map(); // request type -> handler of worker.handle()
        this.inputPorts = new Ports({ baseObject: this, basePortsGroup: 'inputPorts' });
        this.outputPorts = new Ports({ baseObject: this, basePortsGroup: 'outputPorts' });
        this.parentPorts = new Ports({ baseObject: this, basePortsGroup: 'parentPorts' });
        this.parentPorts[0][0].setMessagePort(parentPort);  // attach the standard worker parentPort to our parentPorts object
        this._setupStandardSubscriptions();
    }

    /**
     * Answers the main-thread request() calls of one type.
     * The handler gets (data, transferList) and returns the answer or a Promise for it.
     * Push ArrayBuffers of the answer into transferList to move them instead of copying them.
     * If the handler throws, request() rejects with an Error that has the same name and message.
     * @param {string} type - The request type
     * @param {Function} handler - (data, transferList) => answer
     * @throws {Error} If handler is not a function, or the type has a handler already
     */
    handle(type, handler) {
        if (typeof handler !== 'function') throw new Error('Handler must be a function');
        if (this._handlers.has(type)) throw new Error(`worker.handle(): type '${type}' has a handler already`);
        this._handlers.set(type, handler);
    }

    /**
     * Calls the handler of a request and sends the answer back on the same connection.
     * @private
     */
    async _answer(connection, { type, data, requestId }) {
        const reply = (body, transferList = []) =>
            connection.messagePort.postMessage({ type: '_reply', data: { requestId, ...body } }, transferList);
        try {
            const handler = this._handlers.get(type);
            if (!handler) throw new Error(`the worker has no worker.handle('${type}', ...) handler`);
            const transferList = [];
            const result = await handler(data, transferList);
            reply({ result }, transferList);
        } catch (error) {
            // For example a throw in the handler, or an answer that cannot be cloned
            reply({ error: { name: (error && error.name) || 'Error', message: (error && error.message) || String(error) } });
        }
    }

    /**
     * Reports a throw (or a rejected Promise) of a subscribe handler in the worker.
     * The default sends it to the main thread, where the node logs it with node.error.
     * A worker file can replace it: worker.handlerError = (error, type, data) => { ... }.
     * @param {*} error - The value that the handler threw
     * @param {string} type - The message type of the handler
     * @param {*} data - The data of the message that the handler got
     */
    handlerError(error, type, data) {
        this.parentPorts.publish('_handlerError', { type, message: (error && error.message) || String(error) });
    }

    _setupStandardSubscriptions() {

        // Handle input port addition
        this.parentPorts.subscribe('_addInputConnection', ({ nodeId, linkId, messagePort }, senderTrace, receiverTrace) => {
            const myConnectionIndex = this.inputPorts[0].getNextConnectionNumber();
            this.nodeId = nodeId;
            this.inputPorts[0][myConnectionIndex].setMessagePort(messagePort);
            this.inputPorts[0][myConnectionIndex].linkId = linkId;
            this.parentPorts.publish('ack', '_inputPortReceived');
        });

        // Handle output port addition
        this.parentPorts.subscribe('_addOutputConnection', ({ nodeId, portIndex, connectionIndex, linkId, messagePort }, senderTrace, receiverTrace) => {
            this.nodeId = nodeId;
            this.outputPorts[portIndex][connectionIndex].setMessagePort(messagePort);
            this.outputPorts[portIndex][connectionIndex].linkId = linkId;
            this.parentPorts.publish('ack', '_outputPortReceived');
        });

        // The worker at the other end of a wire closed: close this end and free the slot
        this.parentPorts.subscribe('_removeConnection', ({ linkId }) => {
            for (const group of [this.inputPorts, this.outputPorts]) {
                for (const port of Object.values(group._ports)) {
                    if (port.removeLink(linkId)) return;
                }
            }
        });

        // Handle _createNamedPorts from other workers
        this.inputPorts.subscribe('_createNamedPort', ({ portName, port }, senderTrace, receiverTrace) => {
            const connection = this.inputPorts[receiverTrace.portIndex][receiverTrace.connectionIndex];
            if (connection._namedPortsMap.has(portName)) throw new Error(`_createNamedPort error: Named port '${portName}' already exists.`);
            connection._namedPortsMap.set(portName, port);
        });

        // Handle connections complete notification
        // Load the worker file one time only, then send the early messages again
        this.parentPorts.subscribe('_ConnectionsComplete', async (data, senderTrace, receiverTrace) => {
            if (this._started) return;
            this._started = true;
            if (typeof this._connectionsCompleteCallback === 'function') {
                await this._connectionsCompleteCallback();
            }
            this._ready = true;
            const early = this._earlyMessages;
            this._earlyMessages = [];
            for (const { connection, message } of early) connection._dispatch(message);
        });

        // Built-in close ack — fires at connection level (after user-level 'close' handlers)
        // so gpu.close() and other cleanup runs first, then we ack the main thread
        this.parentPorts[0][0].subscribe('close', () => {
            this.parentPorts.publish('ack', 'close');
        });

    }
}

module.exports.NodeRedWorkerRuntime = NodeRedWorkerRuntime;