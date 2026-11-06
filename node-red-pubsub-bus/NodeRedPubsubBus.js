/**
 * Copyright 2024 Contributors
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

'use strict';

const { EventEmitter } = require('events');
const { Worker, MessagePort } = require('worker_threads');

const STANDARD_KEYS = ['producerId', 'desc', 'type', 'kind'];
const ALLOWED_KINDS = new Set(['connect', 'change', 'disconnect']);
const PRODUCER_REGISTERED_EVENT = '__pubsub:producerRegistered';
// A getMetadata request to a worker producer fails after this time without a reply
const PULL_TIMEOUT_MS = 5000;

// All copies of this library in one process share this state.
// Thus producers of one copy are visible to consumers of another copy.
// The state holds plain data only, so copies of different versions stay compatible.
// Shape: { emitter: EventEmitter, producers: Map, adminMounted: boolean }
const shared = globalThis[Symbol.for('node-red-utils.pubsub-bus')] ??= {};
if (!shared.emitter) {
    shared.emitter = new EventEmitter();
    shared.emitter.setMaxListeners(0);
}
shared.producers ??= new Map();

let _busInstance = null;

/**
 * Returns the process-lifetime singleton instance of NodeRedPubsubBus.
 * The bus uses the state that all copies of this library share.
 * @returns {NodeRedPubsubBus}
 */
function getBus() {
    if (!_busInstance) _busInstance = new NodeRedPubsubBus(shared);
    return _busInstance;
}

/**
 * Mounts the discovery admin endpoint. Idempotent — the route is registered
 * exactly once per process, when the first node type with the mixin is registered.
 * @param {object} RED
 */
function mountAdminRoute(RED) {
    if (shared.adminMounted || !RED || !RED.httpAdmin) return;
    shared.adminMounted = true;
    RED.httpAdmin.get('/node-red-pubsub-bus/producers',
        RED.auth.needsPermission('flows.read'),
        (req, res) => res.json(getBus().listProducers())
    );
}

/**
 * Validates the standard message shape required by the bus.
 * Throws if any required key is missing.
 * @param {object} msg - The message to validate
 * @throws {Error} If msg is missing any standard key
 */
function validateStandardMsg(msg) {
    if (!msg || typeof msg !== 'object') {
        throw new Error('NodeRedPubsubBus: msg must be an object');
    }
    for (const k of STANDARD_KEYS) {
        if (!(k in msg)) {
            throw new Error(`NodeRedPubsubBus: msg is missing required key '${k}'`);
        }
    }
}

/**
 * In-process pub/sub bus with MQTT-shaped semantics. Process-lifetime singleton;
 * no broker, no external connection. Topics are flat strings of the form
 * `<producerId>/<entryName>`. Three trigger kinds: `change` (broadcast — fires
 * on producer register and on metadata mutation), `connect` (retained-on-
 * subscribe replay to a single new subscriber) and `disconnect` (broadcast —
 * fires when the producer unregisters).
 */
class NodeRedPubsubBus {

    /**
     * @param {{emitter: EventEmitter, producers: Map}} [state] - Shared state. Omit it for a private bus.
     */
    constructor(state) {
        if (state) {
            this._emitter = state.emitter;
            this._producers = state.producers;
        } else {
            this._emitter = new EventEmitter();
            this._emitter.setMaxListeners(0);
            // producerId -> { getEntries, getMetadata }
            this._producers = new Map();
        }
        // worker bookkeeping is per-attach, kept inside attachWorker closures.
    }

    /**
     * Publishes a message to a topic. Validates the standard shape; does not mutate msg.
     * @param {string} topic
     * @param {object} msg - Must contain producerId, desc, type, kind
     */
    publish(topic, msg) {
        validateStandardMsg(msg);
        this._emitter.emit(topic, msg);
    }

    /**
     * Subscribes to a topic. If a producer is already registered for the topic's
     * producerId, fires a `connect` event on the new handler immediately
     * (retained-on-subscribe replay).
     * A handler that throws or returns a Promise that rejects does not stop the
     * other subscribers. The error goes to onError.
     * @param {string} topic
     * @param {Function} handler
     * @param {Function} [onError] - Called with the error of the handler. Default: console.error.
     * @returns {Function} unsubscribe
     */
    subscribe(topic, handler, onError = (err) => console.error('NodeRedPubsubBus: subscriber of ' + topic + ' failed:', err)) {
        if (typeof handler !== 'function') {
            throw new Error('NodeRedPubsubBus: handler must be a function');
        }
        const report = (err) => { try { onError(err); } catch (_) {} };
        const guarded = (msg) => {
            try {
                const result = handler(msg);
                if (result && typeof result.then === 'function') result.then(undefined, report);
            } catch (err) { report(err); }
        };
        this._emitter.on(topic, guarded);

        // Retained-on-subscribe replay.
        const slash = topic.indexOf('/');
        if (slash > 0) {
            const producerId = topic.slice(0, slash);
            const name = topic.slice(slash + 1);
            const type = this._typeOf(producerId, name);
            if (type) {
                Promise.resolve().then(() => guarded(this._buildMsg(producerId, name, type, 'connect')));
            }
        }

        return () => { this._emitter.off(topic, guarded); };
    }

    /**
     * Registers a producer. Emits `change` per topic returned by getEntries() so any
     * already-subscribed consumers re-pull. Returns an unregister fn that drops the
     * producer and emits `disconnect` per topic of its last entries.
     * @param {string} producerId
     * @param {{ getEntries: Function, getMetadata: Function }} opts
     * @returns {Function} unregister
     */
    registerProducer(producerId, { getEntries, getMetadata }) {
        if (typeof getEntries !== 'function' || typeof getMetadata !== 'function') {
            throw new Error('NodeRedPubsubBus: registerProducer requires getEntries and getMetadata fns');
        }
        if (this._producers.has(producerId)) {
            throw new Error(`NodeRedPubsubBus: producer '${producerId}' is already registered`);
        }

        const producer = { getEntries, getMetadata };
        this._producers.set(producerId, producer);

        // Notify any onProducerRegistered listeners so they can subscribe to
        // this producer's topics. Fired BEFORE the per-entry change burst so
        // a fresh subscriber's `connect` replay covers every entry.
        this._emitter.emit(PRODUCER_REGISTERED_EVENT, producerId);

        // Fire change per entry so any already-subscribed consumers re-pull.
        let entries = [];
        try { entries = getEntries() || []; } catch (err) {
            console.error('NodeRedPubsubBus: getEntries threw at register', err);
        }
        for (const entry of entries) {
            const topic = `${producerId}/${entry.name}`;
            this._emitter.emit(topic, this._buildMsg(producerId, entry.name, entry.type, 'change'));
        }

        return () => {
            // A later registration with the same id is not ours to remove
            if (this._producers.get(producerId) !== producer) return;
            let lastEntries = [];
            try { lastEntries = getEntries() || []; } catch (_) {}
            this._producers.delete(producerId);
            for (const entry of lastEntries) {
                this._emitter.emit(`${producerId}/${entry.name}`,
                    this._buildMsg(producerId, entry.name, entry.type, 'disconnect'));
            }
        };
    }

    /**
     * Fired by a producer after it has updated its own metadataVersion to signal
     * a `change` on a single entry. Producer is responsible for incrementing version.
     * @param {string} producerId
     * @param {string} name
     * @returns {boolean} false if the producer is not registered or has no entry `name` in getEntries(): nothing is sent
     */
    notifyChange(producerId, name) {
        const producer = this._producers.get(producerId);
        if (!producer) return false;
        const type = this._typeOf(producerId, name);
        if (!type) return false;
        const topic = `${producerId}/${name}`;
        this._emitter.emit(topic, this._buildMsg(producerId, name, type, 'change'));
        return true;
    }

    /**
     * Installs the worker proxy bridge protocol on a Worker or MessagePort.
     * Tracks every shim subscription, remote-producer registration, and pending
     * get-metadata reqId so detach (or worker exit) is a clean teardown.
     * @param {Worker|MessagePort} worker
     * @param {Function} [onError] - Called with an Error when a worker request fails,
     *   for example a duplicate producer id. Default: console.error.
     * @returns {Function} detach
     */
    attachWorker(worker, onError = (err) => console.error(err.message)) {
        if (!worker || typeof worker.on !== 'function' || typeof worker.postMessage !== 'function') {
            throw new Error('NodeRedPubsubBus: attachWorker requires a Worker or MessagePort');
        }

        // subId -> { topic, unsubscribe }
        const shimSubs = new Map();
        // producerId -> unregister fn
        const remoteProducers = new Map();
        // reqId -> { resolve, reject }
        const pendingMetadataReqs = new Map();

        let nextReqId = 1;

        // Never throw from a 'message' listener: Node-RED would stop with an uncaught exception
        const onMessage = (message) => {
            try { dispatch(message); } catch (err) {
                try { onError(err); } catch (_) {}
            }
        };
        const dispatch = (message) => {
            if (!message || typeof message !== 'object') return;
            switch (message.tag) {
                case 'pubsub:subscribe':
                    this._handleWorkerSubscribe(message, worker, shimSubs);
                    break;
                case 'pubsub:unsubscribe':
                    this._handleWorkerUnsubscribe(message, shimSubs);
                    break;
                case 'pubsub:publish':
                    this._handleWorkerPublish(message);
                    break;
                case 'pubsub:register':
                    this._handleWorkerRegister(message, worker, remoteProducers, pendingMetadataReqs, () => nextReqId++);
                    break;
                case 'pubsub:notify-change':
                    this._handleWorkerNotifyChange(message, remoteProducers);
                    break;
                case 'pubsub:pull-metadata':
                    this._handleWorkerPullMetadata(message, worker);
                    break;
                case 'pubsub:get-metadata-reply':
                    this._handleWorkerMetadataReply(message, pendingMetadataReqs);
                    break;
                case 'pubsub:ping':
                    // Tells the worker proxy that it is attached
                    worker.postMessage({ tag: 'pubsub:pong' });
                    break;
                default:
                    // Unknown tag — ignore (other protocols may share parentPort).
                    break;
            }
        };

        worker.on('message', onMessage);

        const cleanup = () => {
            worker.off ? worker.off('message', onMessage) : worker.removeListener('message', onMessage);
            for (const sub of shimSubs.values()) {
                try { sub.unsubscribe(); } catch (_) {}
            }
            shimSubs.clear();
            for (const { unregister } of remoteProducers.values()) {
                try { unregister(); } catch (_) {}
            }
            remoteProducers.clear();
            for (const pending of pendingMetadataReqs.values()) {
                clearTimeout(pending.timer);
                try { pending.reject(new Error('NodeRedPubsubBus: worker detached')); } catch (_) {}
            }
            pendingMetadataReqs.clear();
        };

        // Auto-detach on worker exit.
        if (typeof worker.once === 'function') {
            worker.once('exit', cleanup);
        }

        return cleanup;
    }

    /**
     * Pulls metadata for a registered producer entry. Always returns a Promise for
     * the producer's getMetadata(name) result. It rejects if the producer throws.
     * The Promise gives null if the producer is not registered.
     * @param {string} producerId
     * @param {string} name
     * @returns {Promise<*>}
     */
    async getMetadata(producerId, name) {
        const producer = this._producers.get(producerId);
        if (!producer) return null;
        return producer.getMetadata(name);
    }

    /**
     * Returns a snapshot of currently-subscribed topic strings.
     * @returns {string[]}
     */
    listTopics() {
        return this._emitter.eventNames().filter((n) => typeof n === 'string');
    }

    /**
     * Returns a snapshot of every registered producer and its current entries.
     * Used by editor-side discovery dropdowns.
     * @returns {Array<{producerId: string, entries: Array<{name: string, type: string}>}>}
     */
    listProducers() {
        const out = [];
        for (const [producerId, producer] of this._producers.entries()) {
            let entries = [];
            try { entries = producer.getEntries() || []; } catch (_) {}
            out.push({
                producerId,
                entries: entries.map((e) => ({ name: e.name, type: e.type }))
            });
        }
        return out;
    }

    /**
     * Returns the count of subscribers for a topic.
     * @param {string} topic
     * @returns {number}
     */
    listSubscribers(topic) {
        return this._emitter.listenerCount(topic);
    }

    /**
     * Subscribes to a fire-on-every-producer-registered notification. Handler
     * receives the new `producerId`. Used by consumers
     * that want to track the producer set as workers come online after deploy.
     * @param {Function} handler
     * @returns {Function} unsubscribe
     */
    onProducerRegistered(handler) {
        if (typeof handler !== 'function') {
            throw new Error('NodeRedPubsubBus: handler must be a function');
        }
        this._emitter.on(PRODUCER_REGISTERED_EVENT, handler);
        return () => { this._emitter.off(PRODUCER_REGISTERED_EVENT, handler); };
    }

    // ----- internal helpers -----

    /**
     * Builds the standard message envelope. Identity-only — no payload, no version, no timestamp.
     * @private
     */
    _buildMsg(producerId, desc, type, kind) {
        if (!ALLOWED_KINDS.has(kind)) {
            throw new Error(`NodeRedPubsubBus: invalid kind '${kind}'`);
        }
        return { producerId, desc, type, kind };
    }

    /**
     * Looks up the declared type for a producer's entry name.
     * Returns null if the producer or entry is not registered.
     * @private
     */
    _typeOf(producerId, name) {
        const producer = this._producers.get(producerId);
        if (!producer) return null;
        let entries = [];
        try { entries = producer.getEntries() || []; } catch (_) {}
        const found = entries.find((e) => e.name === name);
        return found ? found.type : null;
    }

    /** @private */
    _handleWorkerSubscribe(message, worker, shimSubs) {
        const { subId, topic } = message;
        if (subId == null || typeof topic !== 'string') return;
        if (shimSubs.has(subId)) return;
        const handler = (msg) => {
            try {
                worker.postMessage({ tag: 'pubsub:event', subId, msg });
            } catch (err) {
                console.error('NodeRedPubsubBus: postMessage to worker failed', err);
            }
        };
        const unsubscribe = this.subscribe(topic, handler);
        shimSubs.set(subId, { topic, unsubscribe });
    }

    /** @private */
    _handleWorkerUnsubscribe(message, shimSubs) {
        const { subId } = message;
        const entry = shimSubs.get(subId);
        if (!entry) return;
        try { entry.unsubscribe(); } catch (_) {}
        shimSubs.delete(subId);
    }

    /** @private */
    _handleWorkerPublish(message) {
        const { topic, msg } = message;
        if (typeof topic !== 'string') return;
        try { this.publish(topic, msg); } catch (err) {
            console.error('NodeRedPubsubBus: worker publish rejected', err);
        }
    }

    /** @private */
    _handleWorkerRegister(message, worker, remoteProducers, pendingMetadataReqs, nextReqId) {
        const { producerId, entries } = message;
        if (typeof producerId !== 'string' || !Array.isArray(entries)) return;
        if (remoteProducers.has(producerId)) return;
        if (this._producers.has(producerId)) {
            throw new Error(`NodeRedPubsubBus: a worker tried to register producer '${producerId}', ` +
                'but that id is already registered. Use a unique id, such as the node id.');
        }

        const requestFromWorker = (name) => new Promise((resolve, reject) => {
            const reqId = nextReqId();
            const timer = setTimeout(() => {
                if (!pendingMetadataReqs.delete(reqId)) return;
                reject(new Error(`NodeRedPubsubBus: getMetadata('${producerId}', '${name}'): ` +
                    `the worker producer did not reply within ${PULL_TIMEOUT_MS} ms`));
            }, PULL_TIMEOUT_MS);
            if (typeof timer.unref === 'function') timer.unref();
            pendingMetadataReqs.set(reqId, { resolve, reject, timer });
            try {
                worker.postMessage({ tag: 'pubsub:get-metadata', reqId, producerId, name });
            } catch (err) {
                clearTimeout(timer);
                pendingMetadataReqs.delete(reqId);
                reject(err);
            }
        });

        // entriesRef is mutable so notifyChange can refresh it without re-registering.
        const entriesRef = { current: entries };
        const unregister = this.registerProducer(producerId, {
            getEntries: () => entriesRef.current,
            getMetadata: (name) => requestFromWorker(name),
        });
        remoteProducers.set(producerId, { unregister, entriesRef });
    }

    /** @private */
    _handleWorkerNotifyChange(message, remoteProducers) {
        const { producerId, name, entries } = message;
        if (typeof producerId !== 'string' || typeof name !== 'string') return;
        // Refresh the cached entries snapshot (worker entries can grow/shrink dynamically).
        if (Array.isArray(entries) && remoteProducers && remoteProducers.has(producerId)) {
            remoteProducers.get(producerId).entriesRef.current = entries;
        }
        // Re-fire the producer-registered notification so consumers tracking the
        // bus producer set can pick up entries that
        // appeared after the initial registerProducer call. Idempotent on the
        // consumer side.
        this._emitter.emit(PRODUCER_REGISTERED_EVENT, producerId);
        try { this.notifyChange(producerId, name); } catch (err) {
            console.error('NodeRedPubsubBus: worker notifyChange rejected', err);
        }
    }

    /** @private */
    _handleWorkerPullMetadata(message, worker) {
        const { reqId, producerId, name } = message;
        if (typeof reqId === 'undefined') return;
        const reply = (payload) => {
            try { worker.postMessage({ tag: 'pubsub:pull-metadata-reply', reqId, payload }); }
            catch (err) { console.error('NodeRedPubsubBus: pull-metadata-reply postMessage failed', err); }
        };
        this.getMetadata(producerId, name).then(p => reply(p == null ? null : p)).catch(() => reply(null));
    }

    /** @private */
    _handleWorkerMetadataReply(message, pendingMetadataReqs) {
        const { reqId, payload } = message;
        const pending = pendingMetadataReqs.get(reqId);
        if (!pending) return;
        pendingMetadataReqs.delete(reqId);
        clearTimeout(pending.timer);
        pending.resolve(payload);
    }
}

/**
 * Mixin factory that adds the namespaced `nodeRedPubsubBus` API to a host node.
 * Proxies to the process-lifetime singleton bus. Tracks every producer registration
 * and worker attachment made through this mixin instance so that on `thisNode.on('close')`
 * only this node's resources are cleaned up — not other nodes' registrations.
 *
 * @param {class} superclass
 * @returns {class}
 */
const nodeRedPubsubBus = (superclass) => class extends superclass {
    // Serve the discovery route before the first deploy
    static onRegisterType(RED) {
        super.onRegisterType?.(RED);
        mountAdminRoute(RED);
    }

    constructor(RED, thisNode, config) {
        super(RED, thisNode, config);

        const bus = getBus();
        const ownedUnregisters = new Set();
        const ownedDetachers = new Set();
        const ownedProducerListeners = new Set();
        const ownedSubscriptions = new Set();

        const namespace = {
            publish: (topic, msg) => bus.publish(topic, msg),

            subscribe: (topic, handler) => {
                const unsubscribe = bus.subscribe(topic, handler,
                    (err) => thisNode.error(`pubsub subscriber of ${topic} failed: ${(err && err.message) || err}`));
                const wrapped = () => {
                    ownedSubscriptions.delete(wrapped);
                    try { unsubscribe(); } catch (_) {}
                };
                ownedSubscriptions.add(wrapped);
                return wrapped;
            },

            registerProducer: (producerId, opts) => {
                const unregister = bus.registerProducer(producerId, opts);
                const wrapped = () => {
                    ownedUnregisters.delete(wrapped);
                    try { unregister(); } catch (_) {}
                };
                ownedUnregisters.add(wrapped);
                return wrapped;
            },

            notifyChange: (producerId, name) => {
                if (!bus.notifyChange(producerId, name)) {
                    thisNode.debug(`pubsub notifyChange('${producerId}', '${name}') ignored: no such producer, or getEntries() has no entry '${name}'`);
                }
            },

            getMetadata: (producerId, name) => bus.getMetadata(producerId, name),

            attachWorker: (worker) => {
                const detach = bus.attachWorker(worker, (err) => {
                    thisNode.error(err.message);
                    thisNode.status({ fill: 'red', shape: 'ring', text: 'pubsub error, see log' });
                });
                const wrapped = () => {
                    ownedDetachers.delete(wrapped);
                    try { detach(); } catch (_) {}
                };
                ownedDetachers.add(wrapped);
                return wrapped;
            },

            listTopics: () => bus.listTopics(),

            listSubscribers: (topic) => bus.listSubscribers(topic),

            listProducers: () => bus.listProducers(),

            onProducerRegistered: (handler) => {
                const off = bus.onProducerRegistered(handler);
                const wrapped = () => {
                    ownedProducerListeners.delete(wrapped);
                    try { off(); } catch (_) {}
                };
                ownedProducerListeners.add(wrapped);
                return wrapped;
            },

            _parent: this,
        };

        this.nodeRedPubsubBus = namespace;
        thisNode.nodeRedPubsubBus = namespace;

        thisNode.on('close', () => {
            for (const fn of Array.from(ownedUnregisters)) {
                try { fn(); } catch (_) {}
            }
            for (const fn of Array.from(ownedDetachers)) {
                try { fn(); } catch (_) {}
            }
            for (const fn of Array.from(ownedProducerListeners)) {
                try { fn(); } catch (_) {}
            }
            for (const fn of Array.from(ownedSubscriptions)) {
                try { fn(); } catch (_) {}
            }
            ownedUnregisters.clear();
            ownedSubscriptions.clear();
            ownedDetachers.clear();
            ownedProducerListeners.clear();
        });
    }
};

module.exports.nodeRedPubsubBus = nodeRedPubsubBus;
module.exports.NodeRedPubsubBus = NodeRedPubsubBus;
module.exports.getBus = getBus;
