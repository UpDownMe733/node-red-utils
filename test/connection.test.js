'use strict';

// Tests of nodeRedConnection with fake nodes. They need no Node-RED process.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { NodeRedNodeBase } = require('../node-red-base/NodeRedNodeBase.js');
const { nodeRedConnection } = require('../node-red-connection/NodeRedConnection.js');
const { sleep } = require('./helpers/node-red.js');

const NodeClass = NodeRedNodeBase.with(nodeRedConnection);

// The flows:started event of Node-RED. A closed holder is released at this event.
const RED = { events: new EventEmitter() };
NodeClass.onRegisterType(RED);
const started = () => RED.events.emit('flows:started');

let ids = 0;

/** A node with the close behavior of Node-RED: a handler gets (done) or nothing, by its length. */
function fakeNode(id = 'n' + ++ids) {
    const closers = [];
    const node = {
        id,
        errors: [],
        warnings: [],
        on(event, fn) { if (event === 'close') closers.push(fn); },
        error(msg) { node.errors.push(msg); },
        warn(msg) { node.warnings.push(msg); },
        close: () => Promise.all(closers.map(fn => new Promise(r => { if (fn.length) fn(r); else { fn(); r(); } })))
    };
    return node;
}

/** Poll fn until it returns a truthy value, or throw after timeoutMs. */
async function until(fn, timeoutMs = 2000, what = 'condition') {
    const end = Date.now() + timeoutMs;
    while (!fn()) {
        if (Date.now() > end) throw new Error('Timeout: ' + what);
        await sleep(2);
    }
}

/**
 * An owner node with a managed connection. Each open() returns a new client { id, lost }.
 * hold(node) acquires the connection for node and logs each state in log.states until node closes.
 * state() reads the private state, because no public call gives the state after the last holder closed.
 */
function setup(options = {}) {
    const owner = fakeNode();
    new NodeClass({}, owner, {});
    const log = { clients: [], closed: [], states: [], errors: [] };
    const conn = owner.nodeRedConnection.manage({
        open: (lost) => {
            const client = { id: log.clients.length + 1, lost };
            log.clients.push(client);
            return client;
        },
        close: (client) => { log.closed.push(client.id); },
        backoff: { min: 5, max: 40 },
        ...options
    });
    const hold = (node) => conn.acquire(node, (state, err) => { log.states.push(state); log.errors.push(err && err.message); });
    const state = () => conn._state;
    return { owner, conn, log, state, hold };
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

describe('nodeRedConnection', () => {
    // No jitter: each delay is the full backoff delay
    const realRandom = Math.random;
    beforeEach(() => { Math.random = () => 1; });
    afterEach(() => { Math.random = realRandom; });

    it('manage() checks its arguments', () => {
        const node = fakeNode();
        new NodeClass({}, node, {});
        assert.throws(() => node.nodeRedConnection.manage({ close() {} }), /open must be a function/);
        assert.throws(() => node.nodeRedConnection.manage({ open() {}, close() {}, backoff: { min: -1 } }), /backoff.min must be/);
    });

    it('a second manage() gives a second connection, and the owner close ends both', async () => {
        const owner = fakeNode();
        new NodeClass({}, owner, {});
        const closed = [];
        const make = (name) => owner.nodeRedConnection.manage({ open: () => ({ name }), close: (c) => { closed.push(c.name); } });
        const one = make('one'), two = make('two');
        one.acquire(owner);
        two.acquire(owner);
        assert.deepEqual([(await one.ready()).name, (await two.ready()).name], ['one', 'two']);
        await owner.close();
        assert.deepEqual(closed.sort(), ['one', 'two']);
    });

    it('the first acquire connects and the last release disconnects at flows:started', async () => {
        const { log, state, hold } = setup();
        const user = fakeNode();
        assert.equal(state(), 'idle');
        hold(user);
        await until(() => state() === 'ready', 2000, 'ready');
        assert.equal(log.clients.length, 1);
        await user.close();
        assert.equal(state(), 'ready', 'the connection waits for flows:started');
        started();
        await until(() => state() === 'idle', 2000, 'idle');
        assert.deepEqual(log.states, ['connecting', 'ready']);
        assert.deepEqual(log.closed, [1]);
    });

    it('two holders share one connection; a node that acquires twice counts once', async () => {
        const { conn, log, state } = setup();
        const a = fakeNode(), b = fakeNode();
        conn.acquire(a);
        conn.acquire(a);
        conn.acquire(b);
        await until(() => state() === 'ready');
        await a.close();
        assert.equal(state(), 'ready');
        assert.deepEqual(log.closed, []);
        await b.close();
        started();
        await until(() => state() === 'idle');
        assert.deepEqual(log.closed, [1]);
        assert.equal(log.clients.length, 1);
    });

    it('a failed open retries with a delay that doubles to the maximum and resets after ready', async () => {
        const times = [];
        let fails = 4;
        const { owner, log, state, hold } = setup({
            open: (lost) => {
                times.push(Date.now());
                if (fails-- > 0) throw new Error('refused');
                const client = { id: log.clients.length + 1, lost };
                log.clients.push(client);
                return client;
            },
            backoff: { min: 10, max: 40 }
        });
        hold(owner);
        await until(() => state() === 'ready', 2000, 'ready');
        const delays = times.slice(1).map((t, i) => t - times[i]);
        for (const [i, min] of [10, 20, 40, 40].entries()) assert.ok(delays[i] >= min - 1, `delay ${i}: ${delays}`);
        assert.ok(delays[3] < 80, `delay 3 is not capped: ${delays}`);
        assert.equal(log.errors[1], 'refused');

        // After ready, the next delay starts at min again
        const lostAt = Date.now();
        log.clients[0].lost(new Error('gone'));
        await until(() => times.length === 6, 2000, 'reconnect');
        assert.ok(times[5] - lostAt < 30, `delay after reset: ${times[5] - lostAt}`);
        await owner.close();
    });

    it('lost() closes the client and reconnects', async () => {
        const { owner, log, state, hold } = setup();
        hold(owner);
        await until(() => state() === 'ready');
        log.clients[0].lost(new Error('socket closed'));
        assert.equal(state(), 'failed');
        await until(() => log.clients.length === 2 && state() === 'ready', 2000, 'reconnect');
        assert.deepEqual(log.states, ['connecting', 'ready', 'failed', 'connecting', 'ready']);
        assert.equal(log.errors[2], 'socket closed');
        assert.deepEqual(log.closed, [1]);
        await owner.close();
    });

    it('lost() from an old attempt is ignored', async () => {
        const { owner, conn, log, state } = setup();
        conn.acquire(owner);
        await until(() => state() === 'ready');
        log.clients[0].lost();
        await until(() => log.clients.length === 2 && state() === 'ready');
        log.clients[0].lost(new Error('late event'));
        await sleep(20);
        assert.equal(state(), 'ready');
        assert.equal(log.clients.length, 2);
        assert.deepEqual(log.closed, [1]);
        assert.equal(await conn.ready(), log.clients[1]);
        await owner.close();
    });

    it('a release during connecting stays in closing until the late client is closed', async () => {
        const pending = deferred();
        const { conn, log, state } = setup({ open: () => pending.promise });
        const user = fakeNode();
        conn.acquire(user);
        await user.close();
        started();
        await sleep(10);
        assert.equal(state(), 'closing');
        pending.resolve({ id: 7 });
        await until(() => state() === 'idle', 2000, 'idle');
        assert.deepEqual(log.closed, [7]);
    });

    it('never runs two open() at one time, and closes the old client before the next open()', async () => {
        const order = [];
        const first = deferred();
        const { conn, log, state } = setup({
            open: () => {
                order.push('open');
                return order.length === 1 ? first.promise : { id: 2 };
            },
            close: (client) => { order.push('close ' + client.id); log.closed.push(client.id); }
        });
        const a = fakeNode(), b = fakeNode();
        conn.acquire(a);
        await a.close();
        started();
        conn.acquire(b);
        await sleep(10);
        assert.deepEqual(order, ['open']);
        assert.equal(state(), 'closing');
        first.resolve({ id: 1 });
        await until(() => state() === 'ready', 2000, 'second client');
        assert.deepEqual(order, ['open', 'close 1', 'open']);
        assert.equal(await conn.ready(), conn.client);
        await b.close();
        started();
        await until(() => state() === 'idle');
        assert.deepEqual(order, ['open', 'close 1', 'open', 'close 2']);
    });

    it('owner close during connecting waits for the late client, closes it and rejects ready()', async () => {
        const pending = deferred();
        const { owner, conn, log } = setup({ open: () => pending.promise });
        conn.acquire(owner);
        const waiting = conn.ready();
        let closed = false;
        owner.close().then(() => { closed = true; });
        await assert.rejects(waiting, /node closed/);
        await assert.rejects(conn.ready(), /node closed/);
        assert.throws(() => conn.acquire(fakeNode()), /owner node closed/);
        await sleep(10);
        assert.equal(closed, false);
        pending.resolve({ id: 9 });
        await until(() => closed, 2000, 'owner close');
        assert.deepEqual(log.closed, [9]);
    });

    it('calls close(client) exactly once for each client', async () => {
        let late = null;
        const { owner, conn, log, state } = setup({
            open: (lost) => {
                const client = { id: log.clients.length + 1, lost };
                log.clients.push(client);
                if (client.id !== 3) return client;
                // lost() during connecting: the client of this attempt arrives later
                lost(new Error('early drop'));
                late = deferred();
                return late.promise.then(() => client);
            }
        });
        conn.acquire(owner);
        await until(() => state() === 'ready');
        log.clients[0].lost();
        log.clients[0].lost();
        await until(() => log.clients.length === 2 && state() === 'ready');
        log.clients[1].lost();
        log.clients[1].lost();
        await until(() => late && state() === 'failed', 2000, 'third attempt');
        await sleep(20);
        assert.equal(log.clients.length, 3, 'no open() while the third one is pending');
        late.resolve();
        await until(() => log.clients.length === 4 && state() === 'ready', 2000, 'fourth client');
        await owner.close();
        await until(() => log.closed.length === 4);
        await sleep(20);
        assert.deepEqual(log.closed.sort(), [1, 2, 3, 4]);
    });

    it('owner close waits for an async close()', async () => {
        let finished = false;
        const { owner, conn, state } = setup({ close: async () => { await sleep(30); finished = true; } });
        conn.acquire(owner);
        await until(() => state() === 'ready');
        await owner.close();
        assert.equal(finished, true);
        assert.equal(state(), 'idle');
    });

    it('ready() resolves with the client and rejects after the timeout', async () => {
        const { owner, conn, log, state } = setup();
        await assert.rejects(conn.ready({ timeout: 20 }), /not ready after 20 ms/);
        const waiting = conn.ready({ timeout: 1000 });
        conn.acquire(owner);
        assert.equal(await waiting, log.clients[0]);
        assert.equal(await conn.ready(), log.clients[0]);
        await owner.close();
    });

    it('keeps at most one reconnect timer', async () => {
        const realSet = global.setTimeout, realClear = global.clearTimeout;
        const live = new Set();
        let most = 0;
        global.setTimeout = (fn, ms) => {
            // Count only the timers of the mixin, not the timers of the test
            if (!new Error().stack.includes('NodeRedConnection.js')) return realSet(fn, ms);
            const t = realSet(() => { live.delete(t); fn(); }, ms);
            live.add(t);
            most = Math.max(most, live.size);
            return t;
        };
        global.clearTimeout = (t) => { live.delete(t); realClear(t); };
        try {
            let n = 0;
            const { owner, conn, state } = setup({
                open: (lost) => { n++; lost(new Error('a')); lost(new Error('b')); throw new Error('c'); }
            });
            conn.acquire(owner);
            await until(() => n >= 4, 2000, 'retries');
            await owner.close();
            assert.equal(most, 1);
            assert.equal(live.size, 0);
        } finally {
            global.setTimeout = realSet;
            global.clearTimeout = realClear;
        }
    });

    it('an onState function that throws is reported on the owner node', async () => {
        const { owner, conn, log, state, hold } = setup();
        hold(owner);
        conn.acquire(fakeNode(), () => { throw new Error('bad onState'); });
        await until(() => state() === 'ready');
        assert.match(owner.errors[0], /onState function failed: bad onState/);
        assert.equal(owner.errors.length, 2);       // the first call, then ready
        assert.deepEqual(log.states, ['connecting', 'ready']);
        await owner.close();
    });

    it('a release in a failed onState stops the retries', async () => {
        let opens = 0;
        const { conn, state } = setup({ open: () => { opens++; throw new Error('refused'); } });
        const user = fakeNode();
        conn.acquire(user, (s) => { if (s === 'failed') { user.close(); started(); } });
        await sleep(60);
        assert.equal(opens, 1);
        assert.equal(state(), 'idle');
    });

    it('an acquire in an idle onState runs open() one time', async () => {
        let opens = 0;
        const { conn, state } = setup({ open: () => ({ id: ++opens }) });
        const a = fakeNode(), b = fakeNode(), c = fakeNode();
        conn.acquire(a);
        await until(() => state() === 'ready');
        await a.close();
        started();
        assert.equal(state(), 'closing');
        // b gets 'idle' as the first node with an onState
        conn.acquire(b, (s) => { if (s === 'idle') conn.acquire(c); });
        await until(() => state() === 'ready');
        await sleep(20);
        assert.equal(opens, 2);
        await b.close();
        await c.close();
        started();
    });

    it('the retry delay starts at min again after idle', async () => {
        const times = [];
        const { conn, state } = setup({
            open: () => { times.push(Date.now()); throw new Error('refused'); },
            backoff: { min: 10, max: 400 }
        });
        const a = fakeNode();
        conn.acquire(a);
        await until(() => times.length === 4, 2000, 'three retries');     // delays 10, 20, 40
        await a.close();
        started();
        await until(() => state() === 'idle');
        const b = fakeNode();
        conn.acquire(b);
        await until(() => times.length === 6, 2000, 'retry after idle');
        assert.ok(times[5] - times[4] < 40, `delay after idle: ${times[5] - times[4]}`);
        await b.close();
        started();
    });

    it('the retry delay is a random value from half to all of the backoff delay', async () => {
        Math.random = () => 0;
        const times = [];
        const { owner, conn } = setup({
            open: () => { times.push(Date.now()); throw new Error('refused'); },
            backoff: { min: 60, max: 60 }
        });
        conn.acquire(owner);
        await until(() => times.length === 2, 2000, 'retry');
        const delay = times[1] - times[0];
        assert.ok(delay >= 29 && delay < 60, `delay with Math.random() 0: ${delay}`);
        await owner.close();
    });

    it('a hung open() or close() holds closing for 10 s at most, then the connection goes on', async () => {
        // Hold the 10 s timers of the mixin, so that the test can expire them at once
        const realSet = global.setTimeout, realClear = global.clearTimeout;
        const held = new Map();
        global.setTimeout = (fn, ms, ...args) => {
            if (ms !== 10000) return realSet(fn, ms, ...args);
            const handle = {};
            held.set(handle, fn);
            return handle;
        };
        global.clearTimeout = (handle) => { if (!held.delete(handle)) realClear(handle); };
        const expire = () => { const fns = [...held.values()]; held.clear(); fns.forEach(fn => fn()); };
        try {
            const hung = deferred();
            let opens = 0;
            const { owner, conn, log, state } = setup({
                open: () => (++opens === 1 ? hung.promise : { id: opens }),
                close: (client) => { log.closed.push(client.id); return client.id === 2 ? new Promise(() => {}) : undefined; }
            });
            const a = fakeNode(), b = fakeNode();
            conn.acquire(a);
            await a.close();
            started();
            conn.acquire(b);
            await sleep(10);
            assert.equal(state(), 'closing');
            assert.equal(held.size, 1);
            expire();
            await until(() => state() === 'ready', 2000, 'connection goes on');
            assert.match(owner.warnings[0], /did not finish in 10 s/);
            assert.equal(opens, 2);         // b holds the connection: it connects again
            hung.resolve({ id: 1 });
            await until(() => log.closed.length === 1);
            assert.deepEqual(log.closed, [1]);

            // close() of client 2 never finishes: the owner close ends at the limit
            let ended = false;
            owner.close().then(() => { ended = true; });
            await sleep(10);
            assert.equal(ended, false);
            expire();
            await until(() => ended, 2000, 'owner close');
            assert.deepEqual(log.closed, [1, 2]);
        } finally {
            global.setTimeout = realSet;
            global.clearTimeout = realClear;
        }
    });

    it('keeps the connection when its last holder restarts', async () => {
        const { owner, conn, log, state } = setup();
        const u1 = fakeNode('u1');
        conn.acquire(u1);
        await until(() => state() === 'ready');
        await u1.close();                   // a modified-nodes deploy stops the node
        conn.acquire(fakeNode('u1'));       // and starts it again with the same id
        started();
        await sleep(20);
        assert.equal(state(), 'ready');
        assert.deepEqual(log.closed, []);
        await owner.close();
    });

    it('closes the connection at flows:started when the holder does not come back', async () => {
        const { conn, log, state } = setup();
        const u1 = fakeNode();
        conn.acquire(u1);
        await until(() => state() === 'ready');
        await u1.close();
        await sleep(20);
        assert.equal(state(), 'ready');
        started();
        await until(() => state() === 'idle');
        assert.deepEqual(log.closed, [1]);
    });

    it('acquire(node, onState) gives the current state, then each change, until the node closes', async () => {
        const { owner, conn, state } = setup();
        conn.acquire(owner);
        await until(() => state() === 'ready');
        const seen = [];
        const user = fakeNode();
        conn.acquire(user, (s) => seen.push(s));
        assert.deepEqual(seen, ['ready']);
        conn.client.lost(new Error('gone'));
        await until(() => state() === 'ready');
        assert.deepEqual(seen, ['ready', 'failed', 'connecting', 'ready']);
        await user.close();
        conn.client.lost();
        await until(() => state() === 'ready');
        assert.equal(seen.length, 4);
        assert.throws(() => conn.acquire(fakeNode(), 'x'), /onState must be a function/);
        await owner.close();
    });

    it('20 restarts of a user node leave no listeners behind', async () => {
        const { owner, conn, state } = setup();
        conn.acquire(owner);
        await until(() => state() === 'ready');
        let calls = 0;
        for (let i = 0; i < 20; i++) {
            const user = fakeNode('user');
            conn.acquire(user, () => calls++);
            await user.close();
        }
        conn.client.lost();
        await until(() => state() === 'ready');
        assert.equal(calls, 20);           // only the first call of each node
        await owner.close();
    });

    it('conn.client is the client only in the state ready', async () => {
        const pending = deferred();
        const { owner, conn, state } = setup({ open: () => pending.promise });
        assert.equal(conn.client, undefined);
        conn.acquire(owner);
        assert.equal(conn.client, undefined);
        const client = { id: 1, lost: null };
        pending.resolve(client);
        await until(() => state() === 'ready');
        assert.equal(conn.client, client);
        let closed = false;
        owner.close().then(() => { closed = true; });
        assert.equal(conn.client, undefined);
        await until(() => closed);
    });
});
