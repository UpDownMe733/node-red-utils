/**
 * Copyright 2024 Contributors
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

'use strict';

//
// Worker-side counterpart to NodeRedPubsubBus. Same surface as the main-thread
// bus, but every call serializes over `parentPort`. Expects the host main-thread
// to have called `pubsubBus.attachWorker(worker)`. If that didn't happen, calls
// fall on the floor. The first call also sends a ping; attachWorker answers it.
// If no answer comes within 5s, a one-time warning is logged.
//

const { parentPort } = require('worker_threads');

// getMetadata fails after this time without a reply from the main thread
const PULL_TIMEOUT_MS = 5000;

/**
 * Worker-side proxy for the main-thread NodeRedPubsubBus. Singleton per worker
 * isolate; the worker only ever talks to one parentPort.
 */
class NodeRedPubsubBusWorkerProxy {

    constructor() {
        // subId -> handler
        this._subscribers = new Map();
        // producerId -> getMetadata
        this._producerMetadataFns = new Map();
        // producerId -> getEntries (so notifyChange can refresh main-side entry cache)
        this._producerEntriesFns = new Map();
        // reqId -> { resolve, reject } for pulls we issued to main
        this._pendingPulls = new Map();

        this._nextSubId = 1;
        this._nextLocalId = 1;
        this._nextPullId = 1;

        this._anyMessageReceived = false;
        this._firstSendAt = null;
        this._warnedNoBridge = false;
        this._warnTimer = null;

        if (parentPort) {
            parentPort.on('message', (message) => this._onMessage(message));
        }
    }

    /**
     * Publishes a message via the main-thread bus.
     * @param {string} topic
     * @param {object} msg
     */
    publish(topic, msg) {
        this._send({ tag: 'pubsub:publish', topic, msg });
    }

    /**
     * Subscribes to a topic via the main-thread bus.
     * @param {string} topic
     * @param {Function} handler
     * @returns {Function} unsubscribe
     */
    subscribe(topic, handler) {
        if (typeof handler !== 'function') {
            throw new Error('NodeRedPubsubBusWorkerProxy: handler must be a function');
        }
        const subId = this._nextSubId++;
        this._subscribers.set(subId, handler);
        this._send({ tag: 'pubsub:subscribe', subId, topic });
        return () => {
            if (!this._subscribers.has(subId)) return;
            this._subscribers.delete(subId);
            this._send({ tag: 'pubsub:unsubscribe', subId });
        };
    }

    /**
     * Registers a producer with the main-thread bus. Local getMetadata is retained
     * to satisfy main → worker `pubsub:get-metadata` requests.
     * @param {string} producerId
     * @param {{ getEntries: Function, getMetadata: Function }} opts
     * @returns {Function} unregister
     */
    registerProducer(producerId, { getEntries, getMetadata }) {
        if (typeof getEntries !== 'function' || typeof getMetadata !== 'function') {
            throw new Error('NodeRedPubsubBusWorkerProxy: registerProducer requires getEntries and getMetadata fns');
        }
        if (this._producerMetadataFns.has(producerId)) {
            throw new Error(`NodeRedPubsubBusWorkerProxy: producer '${producerId}' already registered`);
        }
        this._producerMetadataFns.set(producerId, getMetadata);
        this._producerEntriesFns.set(producerId, getEntries);
        this._send({ tag: 'pubsub:register', producerId, entries: getEntries() });

        return () => {
            if (!this._producerMetadataFns.has(producerId)) return;
            this._producerMetadataFns.delete(producerId);
            this._producerEntriesFns.delete(producerId);
            // Note: spec defines no explicit `pubsub:unregister` tag. Producer
            // teardown is normally driven by worker exit, which auto-detaches
            // on the main side. If a host wants to revoke a producer without
            // exiting, that's an out-of-band concern beyond this spec.
        };
    }

    /**
     * Asks the main-thread bus to fire a `change` event for a single entry of
     * a worker-side producer. Use after mutating the cached metadata payload
     * so subscribers re-pull via getMetadata.
     * @param {string} producerId
     * @param {string} name
     */
    notifyChange(producerId, name) {
        // Re-send the current entries snapshot so the main-side cache stays in
        // sync — entries can change dynamically as the worker discovers/loses
        // upstream channels.
        const getEntries = this._producerEntriesFns.get(producerId);
        const entries = getEntries ? getEntries() : null;
        this._send({ tag: 'pubsub:notify-change', producerId, name, entries });
    }

    /**
     * Pulls metadata for any registered producer/entry through the main-thread bus.
     * Returns a Promise that resolves to the payload (or null if unregistered).
     * It rejects if no reply comes within PULL_TIMEOUT_MS, for example without attachWorker().
     * @param {string} producerId
     * @param {string} name
     * @returns {Promise<*>}
     */
    getMetadata(producerId, name) {
        return new Promise((resolve, reject) => {
            const reqId = this._nextPullId++;
            const timer = setTimeout(() => {
                if (!this._pendingPulls.delete(reqId)) return;
                reject(new Error(`NodeRedPubsubBusWorkerProxy: getMetadata('${producerId}', '${name}'): ` +
                    `no reply from the main thread within ${PULL_TIMEOUT_MS} ms. Did the host call attachWorker(worker)?`));
            }, PULL_TIMEOUT_MS);
            if (typeof timer.unref === 'function') timer.unref();
            this._pendingPulls.set(reqId, { resolve, reject, timer });
            this._send({ tag: 'pubsub:pull-metadata', reqId, producerId, name });
        });
    }

    /** @private */
    _onMessage(message) {
        if (!message || typeof message !== 'object') return;
        this._anyMessageReceived = true;
        if (this._warnTimer) {
            clearTimeout(this._warnTimer);
            this._warnTimer = null;
        }
        switch (message.tag) {
            case 'pubsub:event':
                this._handleEvent(message);
                break;
            case 'pubsub:get-metadata':
                this._handleGetMetadata(message);
                break;
            case 'pubsub:pull-metadata-reply':
                this._handlePullMetadataReply(message);
                break;
            default:
                break;
        }
    }

    /** @private */
    _handlePullMetadataReply(message) {
        const { reqId, payload } = message;
        const pending = this._pendingPulls.get(reqId);
        if (!pending) return;
        this._pendingPulls.delete(reqId);
        clearTimeout(pending.timer);
        pending.resolve(payload);
    }

    /** @private */
    _handleEvent(message) {
        const { subId, msg } = message;
        const handler = this._subscribers.get(subId);
        if (!handler) return;
        const report = (err) => console.error('NodeRedPubsubBusWorkerProxy: subscriber handler failed', err);
        try {
            const result = handler(msg);
            if (result && typeof result.then === 'function') result.then(undefined, report);
        } catch (err) { report(err); }
    }

    /** @private */
    _handleGetMetadata(message) {
        const { reqId, producerId, name } = message;
        const getMetadata = this._producerMetadataFns.get(producerId);
        if (!getMetadata) {
            this._send({ tag: 'pubsub:get-metadata-reply', reqId, payload: null });
            return;
        }
        Promise.resolve()
            .then(() => getMetadata(name))
            .then((payload) => {
                this._send({ tag: 'pubsub:get-metadata-reply', reqId, payload: payload || null });
            })
            .catch((err) => {
                console.error('NodeRedPubsubBusWorkerProxy: getMetadata threw', err);
                this._send({ tag: 'pubsub:get-metadata-reply', reqId, payload: null });
            });
    }

    /** @private */
    _send(message) {
        if (!parentPort) return;
        if (this._firstSendAt === null) {
            this._firstSendAt = Date.now();
            this._warnTimer = setTimeout(() => {
                if (!this._anyMessageReceived && !this._warnedNoBridge) {
                    this._warnedNoBridge = true;
                    console.warn('NodeRedPubsubBusWorkerProxy: no main-side bridge detected after 5s. Did the host call pubsubBus.attachWorker(worker)?');
                }
            }, 5000);
            if (typeof this._warnTimer.unref === 'function') this._warnTimer.unref();
            // attachWorker answers this, so a producer-only worker also gets a reply
            parentPort.postMessage({ tag: 'pubsub:ping' });
        }
        try {
            parentPort.postMessage(message);
        } catch (err) {
            console.error('NodeRedPubsubBusWorkerProxy: postMessage failed', err);
        }
    }
}

const pubsubWorkerProxy = new NodeRedPubsubBusWorkerProxy();

module.exports = pubsubWorkerProxy;
module.exports.NodeRedPubsubBusWorkerProxy = NodeRedPubsubBusWorkerProxy;
module.exports.pubsubWorkerProxy = pubsubWorkerProxy;
