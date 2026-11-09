/**
 * Copyright 2024 Contributors
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

'use strict';

const SETTLE_LIMIT_MS = 10000;      // the longest wait for open() and close() of the author
const awaitingRestart = new Set();  // connections with a holder that closed; flows:started releases it
const listening = new WeakSet();    // RED.events objects that have the flows:started listener

/**
 * One managed connection of a node. The owner node gets it from nodeRedConnection.manage().
 *
 * States: idle, connecting, ready, failed, closing.
 * Each attempt has a generation number. A result of open() or a lost() call from an
 * older generation is stale: the mixin ignores it, and closes a stale client at once.
 * An onState function can call acquire() or close a node, so each step checks the
 * generation and the state again after it calls the onState functions.
 */
class NodeRedConnection {

    constructor(thisNode, { open, close, backoff }) {
        this._node = thisNode;
        this._openFn = open;
        this._closeFn = close;
        this._backoff = { min: 1000, max: 30000, ...backoff };
        this._state = 'idle';
        this._err = undefined;            // the error of the failed state
        this._emits = 0;                  // count of state changes, to stop an old call loop after a newer one
        this._holders = new Map();        // node id -> { node, onState, pendingRestart }
        this._gen = 0;                    // generation of the current attempt
        this._client = null;              // the client of the current attempt, when ready
        this._failures = 0;               // failed attempts since the last ready or idle
        this._timer = null;               // the one reconnect timer
        this._pendingOpens = new Set();   // open() calls that are not finished, with the close() of a late client
        this._pendingCloses = new Set();  // close() calls that are not finished
        this._whenIdle = null;            // settles when closing goes to idle
        this._waiters = new Set();        // pending ready() calls
        this._ownerClosed = false;        // true when the owner node closed

        thisNode.on('close', (done) => { this._end().then(() => done(), () => done()); });
    }

    /** The client in the state ready, else undefined */
    get client() { return this._state === 'ready' ? this._client : undefined; }

    /** Holds the connection open while node is not closed. onState(state, err) gets the current state, then each change. */
    acquire(node, onState) {
        if (!node || typeof node.on !== 'function') {
            throw new TypeError('nodeRedConnection: acquire(node, [onState]) needs a Node-RED node');
        }
        if (onState !== undefined && typeof onState !== 'function') {
            throw new TypeError('nodeRedConnection: acquire(node, onState): onState must be a function (state, err) => {}');
        }
        if (this._ownerClosed) throw new Error('nodeRedConnection: acquire() after the owner node closed');
        const held = this._holders.get(node.id);
        if (held && held.node === node) return;
        // A node that restarts has the same id: it replaces its old holder
        const holder = { node, onState: null, pendingRestart: false };
        this._holders.set(node.id, holder);
        node.on('close', () => this._release(holder));
        if (this._state === 'idle') this._connect();
        if (onState && this._holders.get(node.id) === holder) {
            holder.onState = onState;
            this._call(onState, this._state, this._err);
        }
    }

    /** A Promise for the client when the state is ready */
    ready({ timeout } = {}) {
        if (this._ownerClosed) return Promise.reject(new Error('nodeRedConnection: the node closed'));
        if (this._state === 'ready') return Promise.resolve(this._client);
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject, timer: null };
            if (timeout !== undefined) {
                waiter.timer = setTimeout(() => {
                    this._waiters.delete(waiter);
                    reject(new Error(`nodeRedConnection: not ready after ${timeout} ms`));
                }, timeout);
            }
            this._waiters.add(waiter);
        });
    }

    _call(onState, state, err) {
        try { onState(state, err); } catch (e) {
            this._node.error(`nodeRedConnection: an onState function failed: ${(e && e.message) || e}`);
        }
    }

    _setState(state, err) {
        this._state = state;
        this._err = err;
        if (state === 'idle') this._failures = 0;
        const seq = ++this._emits;
        const calls = Array.from(this._holders.values(), holder => holder.onState).filter(Boolean);
        for (const onState of calls) {
            // An onState function changed the state: the other functions got the newer state already
            if (seq !== this._emits) return;
            this._call(onState, state, err);
        }
    }

    _settleWaiters(err, client) {
        for (const waiter of this._waiters) {
            clearTimeout(waiter.timer);
            if (err) waiter.reject(err); else waiter.resolve(client);
        }
        this._waiters.clear();
    }

    /** A Promise that settles when all open() and close() calls are finished, or after SETTLE_LIMIT_MS */
    _settled() {
        const pending = [...this._pendingOpens, ...this._pendingCloses];
        if (pending.length === 0) return Promise.resolve();
        let timer;
        const limit = new Promise((resolve) => {
            timer = setTimeout(() => {
                this._node.warn(`nodeRedConnection: open() or close() did not finish in ${SETTLE_LIMIT_MS / 1000} s. The connection goes on without it.`);
                resolve();
            }, SETTLE_LIMIT_MS);
        });
        return Promise.race([Promise.all(pending), limit]).then(() => clearTimeout(timer));
    }

    _connect() {
        const gen = ++this._gen;
        this._setState('connecting');
        if (gen !== this._gen) return;
        // A throw in open() becomes a rejection
        const attempt = new Promise((resolve) => resolve(this._openFn((err) => this._drop(gen, err))))
            .then((client) => this._onOpen(gen, client), (err) => this._drop(gen, err))
            .then(() => { this._pendingOpens.delete(attempt); });
        this._pendingOpens.add(attempt);
    }

    _onOpen(gen, client) {
        if (gen !== this._gen) return client == null ? undefined : this._closeClient(client);
        if (client == null) return this._drop(gen, new Error('nodeRedConnection: open() gave no client'));
        this._client = client;
        this._failures = 0;
        this._settleWaiters(null, client);
        this._setState('ready');
    }

    /** The attempt of generation gen failed or lost its client: close the client, then wait and retry */
    _drop(gen, err) {
        if (gen !== this._gen) return;
        const nextGen = ++this._gen;
        if (this._client) this._closeClient(this._client);
        this._client = null;
        this._setState('failed', err);
        if (nextGen !== this._gen) return;     // an onState function released the connection

        const { min, max } = this._backoff;
        // A random delay from half to all of the backoff delay
        const delay = Math.min(max, min * 2 ** this._failures) * (0.5 + Math.random() / 2);
        this._failures++;
        this._timer = setTimeout(() => {
            // One open() at a time, and the old client is closed before the next open()
            this._settled().then(() => { if (nextGen === this._gen) this._connect(); });
        }, delay);
    }

    _closeClient(client) {
        const closing = Promise.resolve()
            .then(() => this._closeFn(client))
            .catch((e) => this._node.error(`nodeRedConnection: close() failed: ${(e && e.message) || e}`))
            .then(() => { this._pendingCloses.delete(closing); });
        this._pendingCloses.add(closing);
        return closing;
    }

    /** Stops the attempt or closes the client. Returns a Promise that settles in the idle state. */
    _disconnect() {
        this._gen++;
        clearTimeout(this._timer);
        if (this._state === 'idle') return this._settled();
        if (this._state === 'closing') return this._whenIdle;
        if (this._client) this._closeClient(this._client);
        this._client = null;
        // Stay in closing until a pending open() and each close() are finished
        this._whenIdle = this._settled().then(() => {
            this._setState('idle');
            // A node acquired the connection while it was closing
            if (this._state === 'idle' && this._holders.size > 0) this._connect();
        });
        this._setState('closing');
        return this._whenIdle;
    }

    /** A closed holder can be a restart: keep the connection until flows:started */
    _release(holder) {
        if (this._holders.get(holder.node.id) !== holder) return;
        holder.onState = null;
        holder.pendingRestart = true;
        awaitingRestart.add(this);
    }

    _sweep() {
        awaitingRestart.delete(this);
        for (const [id, holder] of this._holders) {
            if (holder.pendingRestart) this._holders.delete(id);
        }
        if (this._holders.size === 0) this._disconnect();
    }

    async _end() {
        this._ownerClosed = true;
        awaitingRestart.delete(this);
        this._holders.clear();
        this._settleWaiters(new Error('nodeRedConnection: the node closed'));
        await this._disconnect();
    }
}

/**
 * nodeRedConnection - Mixin that opens, closes and reconnects client connections for a node
 *
 * @param {class} superclass - The class to extend
 * @returns {class} A new class that adds thisNode.nodeRedConnection.manage()
 */
const nodeRedConnection = (superclass) => class extends superclass {
    // A holder that closed is released at the next flows:started, if it did not come back.
    // Listen before the first deploy, one time for each RED.
    static onRegisterType(RED) {
        super.onRegisterType?.(RED);
        if (listening.has(RED.events)) return;
        listening.add(RED.events);
        RED.events.on('flows:started', () => {
            for (const conn of Array.from(awaitingRestart)) conn._sweep();
        });
    }

    constructor(RED, thisNode, config) {
        super(RED, thisNode, config);

        this.nodeRedConnection = {
            manage: (options) => {
                const { open, close, backoff = {} } = options || {};
                if (typeof open !== 'function') throw new TypeError('nodeRedConnection.manage(options): open must be a function (lost) => client');
                if (typeof close !== 'function') throw new TypeError('nodeRedConnection.manage(options): close must be a function (client) => {}');
                for (const key of ['min', 'max']) {
                    if (key in backoff && !(Number.isFinite(backoff[key]) && backoff[key] >= 0)) {
                        throw new TypeError(`nodeRedConnection.manage(options): backoff.${key} must be a number of milliseconds >= 0; got ${backoff[key]}`);
                    }
                }
                return new NodeRedConnection(thisNode, { open, close, backoff });
            }
        };
        thisNode.nodeRedConnection = this.nodeRedConnection;
    }
};

module.exports.nodeRedConnection = nodeRedConnection;
