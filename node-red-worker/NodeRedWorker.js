/**
 * Copyright 2024 Contributors
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

const path = require('path');
const { Worker } = require('worker_threads');

// Types that the library uses itself. 'default' handlers do not get them.
const isInternalType = (type) => type === 'ack' || type.startsWith('_');
let nextLinkId = 0;

/**
 * Extended Worker class for Node-RED that handles worker thread communication and management
 * @extends {Worker}
 */
class NodeRedWorker extends Worker {
    static _REDListenerCreated = false;
    static _flowsRunning = false;     // true from flows:started to flows:stopping
    static _nodeRedWorkers = [];

    constructor( params ) {
        super(params.workerRuntimeFile, { workerData: params.workerData } );

        this.RED = params.RED;
        this.thisNode = params.thisNode;

        this._connectionsCompleteCallback = params.connectionsCompleteCallback;

        this.dirname = path.dirname(params.workerRuntimeFile);
        this._wired = false;    // true after the first flows:started wires this worker
        NodeRedWorker._nodeRedWorkers.push({ worker: this, node: this.thisNode });
        this._subscribers = new Map();
        this._namedPorts = {};
        this._links = [];       // { linkId, peer }: one entry for each wire to another worker
        this._exited = false;
        this._requests = new Map();     // requestId -> { resolve, reject, timer }: request() calls without an answer
        this._nextRequestId = 0;
        this._setupStandardSubscriptions();

        // A throw in the worker that nothing catches. Without this listener, Node-RED stops.
        this.on('error', (err) => {
            const message = err && err.message ? err.message : String(err);
            this._rejectRequests(`worker error: ${message}`);
            this._reportError(message);
        });
        this.on('exit', (code) => {
            this._exited = true;
            this._rejectRequests(`worker stopped with exit code ${code}`);
            this._unlink();
            NodeRedWorker._nodeRedWorkers = NodeRedWorker._nodeRedWorkers.filter(entry => entry.worker !== this);
            if (!this._terminatePromise && !this._failed) this._reportError(`worker stopped with exit code ${code}`);
        });

        this.senderTrace = {
            nodeId: this.thisNode.id,
            hostType: 'parent',
            basePortsGroup: 'parentPorts',
            portIndex: 0,
            connectionIndex: 0
        };

        NodeRedWorker._listen(this.RED);
        // A worker made after the flows started (init() after an await, or in an
        // input handler) gets no flows:started. Wire it now.
        if (NodeRedWorker._flowsRunning) NodeRedWorker._wireFresh(this.RED).catch(err => this.RED.log.error('nodeRedWorker: wiring failed: ' + err.message));

        // call handlers when message is received
        this.on('message', async (message) => {
            // Other users of the port (e.g. the pubsub proxy) send messages without a type
            if (typeof message?.type !== 'string') return;
            const { type, data, senderTrace } = message;
            // 'default' handlers get every type except the internal ones.
            // A handler that fails is reported on the node; the next handlers still run.
            for (const handler of [
                ...(this._subscribers.get(type) || []),
                ...(isInternalType(type) ? [] : this._subscribers.get('default') || [])]) {
                try {
                    await handler(data, senderTrace, this.senderTrace, type);
                } catch (error) {
                    this.thisNode.error(`worker message handler for '${type}' failed: ${(error && error.message) || error}`, {});
                }
            }
        });
    }

    /**
    * Listens to the flow events one time. The mixin calls it when the node type is
    * registered, so that it knows if the flows run when a worker starts.
    * @private
    */
    static _listen(RED) {
        if (NodeRedWorker._REDListenerCreated) return;
        NodeRedWorker._REDListenerCreated = true;
        RED.events.on('flows:stopping', () => { NodeRedWorker._flowsRunning = false; });
        RED.events.on('flows:started', () => {
            NodeRedWorker._flowsRunning = true;
            NodeRedWorker._wireFresh(RED).catch(err => RED.log.error('nodeRedWorker: wiring failed: ' + err.message));
        });
    }

    /**
    * Connects each worker that is not wired yet to the worker nodes it is wired to.
    * Workers that are wired already keep their live connections.
    * It uses the wires of the runtime nodes, so it also works in a subflow instance.
    * @private
    */
    static async _wireFresh(RED) {
        const fresh = NodeRedWorker._nodeRedWorkers.filter(entry => !entry.worker._wired);
        if (fresh.length === 0) return;
        fresh.forEach(entry => { entry.worker._wired = true; });

        const byNodeId = new Map(NodeRedWorker._nodeRedWorkers.map(entry => [entry.node.id, entry]));
        const ackPromises = [];

        for (const upstreamWorkerEntry of NodeRedWorker._nodeRedWorkers) {
            const upstreamNode = upstreamWorkerEntry.node;
            const upstreamWorker = upstreamWorkerEntry.worker;
            const nodeWires = upstreamNode.wires || [];
            const wires = !Array.isArray(nodeWires[0]) ? [nodeWires] : nodeWires;
            wires.forEach((connections, outputPortIndex) => {
                connections.forEach((nodeId, outputConnectionIndex) => {
                    const downstreamWorkerEntry = byNodeId.get(nodeId);
                    // Make a new connection only if one end is a new worker
                    if (!downstreamWorkerEntry || !(fresh.includes(upstreamWorkerEntry) || fresh.includes(downstreamWorkerEntry))) return;
                    const downstreamWorker = downstreamWorkerEntry.worker;
                    const channel = new MessageChannel();
                    const linkId = nextLinkId++;
                    upstreamWorker._links.push({ linkId, peer: downstreamWorker });
                    downstreamWorker._links.push({ linkId, peer: upstreamWorker });

                    ackPromises.push(upstreamWorker._waitForAcknowledgment(upstreamWorker, '_outputPortReceived'));
                    ackPromises.push(downstreamWorker._waitForAcknowledgment(downstreamWorker, '_inputPortReceived'));

                    upstreamWorker.publish('_addOutputConnection', {
                        nodeId: upstreamNode.id,
                        portIndex: outputPortIndex,
                        connectionIndex: outputConnectionIndex,
                        linkId,
                        messagePort: channel.port1
                    }, [channel.port1]);

                    downstreamWorker.publish('_addInputConnection', {
                        nodeId: downstreamWorkerEntry.node.id,
                        linkId,
                        messagePort: channel.port2
                    }, [channel.port2]);
                });
            });
        }

        // Wait for all acks before proceeding
        await Promise.all(ackPromises);

        // Tell the new workers that their connections are complete
        fresh.forEach(({ worker }) => {
            if (worker._exited) return;
            try {
                if (typeof worker._connectionsCompleteCallback === 'function') worker._connectionsCompleteCallback();
            } catch (err) {
                worker.thisNode.error(err);
            }
            worker.publish('_ConnectionsComplete', null);
        });
    }

    /**
    * Set up default message handlers from this worker
    * @private
    */
    _setupStandardSubscriptions() {

        this.subscribe('_createNamedPort', ({ portName, port }, senderTrace, receiverTrace ) => {
            this._namedPorts[portName] = port;
            this.publish('_namedPortReceived', null);
        });

        // The worker file threw while it loaded. The thread is of no use now: stop it,
        // so that 'exit' fires as for any other worker failure.
        this.subscribe('_workerError', (message) => {
            this._rejectRequests(`worker error: ${message}`);
            this._reportError(message);
            this.terminate();
        });

        // A subscribe handler in the worker failed (see handlerError in NodeRedWorkerRuntime.js)
        this.subscribe('_handlerError', ({ type, message }) => {
            this.thisNode.error(`worker message handler for '${type}' failed: ${message}`, {});
        });

        // The answer to a request(): a result, or an error as { name, message }
        this.subscribe('_reply', ({ requestId, result, error }) => {
            const request = this._requests.get(requestId);
            if (!request) return;
            this._requests.delete(requestId);
            clearTimeout(request.timer);
            if (!error) return request.resolve(result);
            const err = new Error(error.message);
            err.name = error.name;
            request.reject(err);
        });

    };

    /**
    * Reports a worker failure on the node: an error in the log (Catch nodes get it) and a red status.
    * The worker is not started again. The node stays in error until a Full deploy or Restart Flows starts it again.
    * @private
    */
    _reportError(message) {
        this._failed = true;
        // The empty msg lets Catch nodes get the error; without a msg, Node-RED only logs it
        this.thisNode.error(`Worker error: ${message}`, {});
        this.thisNode.status({ fill: 'red', shape: 'ring', text: 'worker error' });
    }

    /**
    * Rejects every request() that has no answer yet.
    * @private
    */
    _rejectRequests(message) {
        for (const { reject, timer } of this._requests.values()) {
            clearTimeout(timer);
            reject(new Error(message));
        }
        this._requests.clear();
    }

    /**
    * Closes the wires between this worker and other workers.
    * Each peer closes its end and frees the wire slot, so a new wire does not add a slot.
    * @private
    */
    _unlink() {
        for (const { linkId, peer } of this._links) {
            peer._links = peer._links.filter(link => link.linkId !== linkId);
            if (!peer._exited) peer.publish('_removeConnection', { linkId });
        }
        this._links = [];

    };

    /**
    * Gets a named port by its channel name
    * @param {string} channelName - The name of the channel
    * @returns {MessagePort|null} The message port if found, null otherwise
    */
    namedPort(channelName) { return this._namedPorts[channelName] || null };

    _waitForAcknowledgment(worker, expectedAck) {
        return new Promise((resolve) => {
            if (worker._exited) return resolve();
            const finish = () => {
                worker.removeListener('message', onMessage);
                worker.removeListener('exit', finish);
                resolve();
            };
            const onMessage = (message) => {
                if (message.type === 'ack' && message.data === expectedAck) finish();
            };
            worker.on('message', onMessage);
            worker.on('exit', finish);    // a stopped worker sends no ack
        });
    }

    /**
     * Publishes a message to the worker thread
     * @param {string} type - The message type
     * @param {any} [data] - The data to send. It must be cloneable, or postMessage throws a DataCloneError.
     * @param {Array} [transferList] - Optional array of transferable objects
     */
    publish(type, data, transferList = []) {
        this.postMessage({ type, data, senderTrace: this.senderTrace }, transferList);
    }

    /**
     * Sends a request to the handler that the worker registered with worker.handle(type, fn),
     * and returns a Promise for its answer.
     * @param {string} type - The request type
     * @param {any} [data] - The data to send. It must be cloneable.
     * @param {Array} [transferList] - Optional array of transferable objects
     * @param {object} [options]
     * @param {number} [options.timeout] - Reject after this many milliseconds. Default: no timeout.
     * @returns {Promise<any>} The value that the handler returned. Rejects with the error that the
     *   handler threw, or when the worker stops, the node closes or the timeout expires.
     */
    request(type, data, transferList = [], { timeout } = {}) {
        if (this._exited || this._terminatePromise) {
            return Promise.reject(new Error(`worker request '${type}': the worker is stopped`));
        }
        return new Promise((resolve, reject) => {
            const requestId = this._nextRequestId++;
            const request = { resolve, reject, timer: null };
            if (timeout > 0) {
                request.timer = setTimeout(() => {
                    this._requests.delete(requestId);
                    reject(new Error(`worker request '${type}' timed out after ${timeout} ms`));
                }, timeout);
            }
            this._requests.set(requestId, request);
            try {
                this.postMessage({ type, data, senderTrace: this.senderTrace, requestId }, transferList);
            } catch (err) {             // for example a DataCloneError
                clearTimeout(request.timer);
                this._requests.delete(requestId);
                reject(err);
            }
        });
    }

    /** init() runs one time for each node. After it, thisNode.nodeRedWorker is this object. */
    init() {
        throw new Error('nodeRedWorker.init() was already called for this node; it starts one worker per node');
    }

    /**
     * Subscribes to a message type
     * @param {string} type - The message type to subscribe to
     * @param {Function} handler - The handler function to be called when the message type is received
     * @throws {Error} If handler is not a function
     */
    subscribe(type, handler) {
        if (typeof handler !== 'function') { throw new Error('Handler must be a function') };
        if (!this._subscribers.has(type)) { this._subscribers.set(type, []) };
        this._subscribers.get(type).push(handler);
    }

    /**
     * Gracefully terminates the worker thread.
     * Publishes a 'close' message to the worker and waits up to 2 seconds for it to
     * clean up (e.g., drain GPU dispatches, destroy buffers) before force-killing.
     * Idempotent — subsequent calls return the same promise.
     * @returns {Promise<number>} Promise that resolves with the exit code when the worker thread exits
     */
    terminate() {
        if (this._terminatePromise) return this._terminatePromise;

        this._terminatePromise = (async () => {
            this._rejectRequests('worker request ended: the node closed');
            this._unlink();
            // Signal the worker to shut down gracefully. A stopped worker cannot answer.
            if (!this._exited) {
                try {
                    this.publish('close', null);
                    // Wait for ack or timeout — whichever comes first
                    await Promise.race([
                        this._waitForAcknowledgment(this, 'close'),
                        new Promise(resolve => setTimeout(resolve, 2000)),
                    ]);
                } catch (_) {}
            }

            const index = NodeRedWorker._nodeRedWorkers.findIndex(entry => entry.worker === this);
            if (index > -1) {
                NodeRedWorker._nodeRedWorkers.splice(index, 1);
            }
            return super.terminate();
        })();

        return this._terminatePromise;
    }

}

/**
 * Creates a mixin that adds worker thread capabilities to Node-RED nodes
 * 
 * This function implements the "functional mixin" pattern where a function takes a class
 * and returns an extended version of that class. When used with NodeRedNodeBase.with(),
 * multiple mixins can be composed together to build nodes with combined capabilities.
 * 
 * Each mixin follows the same pattern:
 * 1. It's a function that takes a superclass and returns a derived class
 * 2. It adds its functionality through a namespaced object (e.g., this.nodeRedWorker)
 * 3. It provides standard initialization methods (e.g., init)
 * 4. It keeps its functionality self-contained to avoid naming conflicts
 * 
 * The "mix in" concept is literal - each mixin adds its own namespaced functionality
 * to the base object without interfering with other mixins. This approach creates
 * a cleaner composition model than deep inheritance chains.
 * 
 * @param {class} superclass - The class to extend with worker thread capabilities
 * @returns {class} A new class that extends the superclass with worker functionality
 */
const nodeRedWorker = (superclass) => class extends superclass {
    // Listen to the flow events before the first deploy
    static onRegisterType(RED) {
        super.onRegisterType?.(RED);
        NodeRedWorker._listen(RED);
    }

    constructor(RED, thisNode, config) {
        super(RED, thisNode, config);

        const notStarted = () => { throw new Error('nodeRedWorker: call init() before publish(), request(), subscribe() or other worker calls'); };
        this.nodeRedWorker = {

            init: function(workerFile, myWorkerData, callback = null) {
                if (thisNode.nodeRedWorker instanceof NodeRedWorker) {
                    throw new Error('nodeRedWorker.init() was already called for this node; it starts one worker per node');
                }
                if (typeof workerFile !== 'string' || !path.isAbsolute(workerFile)) {
                    throw new TypeError(`nodeRedWorker.init(workerFile): workerFile must be an absolute path, for example path.join(__dirname, 'my-worker.js'); got ${JSON.stringify(workerFile)}`);
                }

                const instance = new NodeRedWorker({
                    RED: RED,
                    thisNode: thisNode,
                    workerRuntimeFile: path.join( __dirname, 'workerRuntimeLoader.js'),
                    workerData: {
                        workerFile: workerFile,
                        myWorkerData: myWorkerData
                    },
                    connectionsCompleteCallback: callback
                });
                
                // Handle node close event for cleanup
                thisNode.on('close', (done) => { instance.terminate().then(() => done(), () => done()); });
                
                // Store the worker instance on the parent class to replace the namespace object
                // the original nodeRedWorker object with only 'init' and '_parent' gets replaced
                // with the new class instance
                this._parent.nodeRedWorker = instance;
                thisNode.nodeRedWorker = instance;

                return instance;
            },
            // Reference to the parent class to allow the namespace object to modify its container  
            _parent: this,
            publish: notStarted,
            request: notStarted,
            subscribe: notStarted,
            on: notStarted,
            namedPort: notStarted,
            terminate: notStarted
        };
        thisNode.nodeRedWorker = this.nodeRedWorker;
    }
};

module.exports.nodeRedWorker = nodeRedWorker;
module.exports.NodeRedWorker = NodeRedWorker;
