# node-red-worker

Run a node's heavy work in a worker thread so it does not block the Node-RED event loop. Worker nodes that are wired together send messages to each other directly, thread to thread.

## Usage

`hash-node.js`:

```js
const path = require('path');
const { NodeRedNodeBase, nodeRedWorker } = require('@nrutils/node-red-utils');

module.exports = NodeRedNodeBase.createNode('hash-node', [nodeRedWorker], (RED, thisNode, config) => {
    const worker = thisNode.nodeRedWorker.init(path.join(__dirname, 'hash-worker.js'), { rounds: 100000 });

    // Several messages can be in the worker at the same time. Each request() gets its own answer.
    thisNode.on('input', (msg, send, done) => {
        worker.request('hash', String(msg.payload), [], { timeout: 10000 }).then((digest) => {
            msg.payload = digest;   // keep _msgid, topic and the other properties
            send(msg);
            done();
        }, done);                   // the worker threw or stopped, the data cannot be cloned, or 10 s passed
    });
});
```

`hash-worker.js`:

```js
const crypto = require('crypto');

// Runs in the worker thread. "data" is the second argument of init(): settings from config.
// Settings that change per message go in the data of each request().
module.exports = function (worker, data) {
    // The return value (or the value of a returned Promise) is the answer to request('hash', text)
    worker.handle('hash', (text) => {
        let digest = text;
        for (let i = 0; i < data.rounds; i++) {
            digest = crypto.createHash('sha256').update(digest).digest('hex');
        }
        return digest;
    });
};
```

If the handler throws, `request()` rejects with an `Error` that has the same `name` and `message`, so `done(err)` shows a Catch node the same text as a local throw.

## Example: an image pipeline across two worker nodes

Wire an `img-gray` node to an `img-threshold` node. The gray worker sends each frame straight to the threshold worker, thread to thread. The frame does not go through the Node-RED runtime, and the pixels move without a copy.

`stages.js` (both node types; the HTML file gives each type one input and one output, and `img-threshold` a `level` field):

```js
const path = require('path');
const { NodeRedNodeBase, nodeRedWorker } = require('@nrutils/node-red-utils');

// msg.payload is { width, height, rgba }: a Buffer with 4 bytes per pixel
const gray = NodeRedNodeBase.createNode('img-gray', [nodeRedWorker], (RED, thisNode) => {
    const worker = thisNode.nodeRedWorker.init(path.join(__dirname, 'gray-worker.js'));
    thisNode.on('input', (msg, send, done) => {
        worker.publish('frame', msg.payload);   // the result goes to the next worker, not back here
        done();
    });
});

// Gets each frame from the thread of the img-gray node that is wired to it
const threshold = NodeRedNodeBase.createNode('img-threshold', [nodeRedWorker], (RED, thisNode, config) => {
    const level = Number(config.level) || 128;
    const worker = thisNode.nodeRedWorker.init(path.join(__dirname, 'threshold-worker.js'), { level });
    worker.subscribe('mask', ({ width, height, mask, lit }) => {
        thisNode.status({ text: `${Math.round(100 * lit / mask.length)} % at or above ${level}` });
        thisNode.send({ payload: { width, height, mask: Buffer.from(mask.buffer) } });
    });
});

module.exports = function (RED) {
    gray(RED);
    threshold(RED);
};
```

`gray-worker.js`:

```js
// Runs in the thread of an img-gray node
module.exports = function (worker) {
    worker.parentPorts.subscribe('frame', ({ width, height, rgba }) => {
        const gray = new Uint8Array(width * height);
        for (let i = 0; i < gray.length; i++) {
            gray[i] = (77 * rgba[4 * i] + 150 * rgba[4 * i + 1] + 29 * rgba[4 * i + 2]) >> 8;
        }
        // To the threads of the wired worker nodes. The transferList moves the pixels
        // without a copy, so it works for one wire only.
        worker.outputPorts.publish('gray', { width, height, gray }, [gray.buffer]);
    });
};
```

`threshold-worker.js`:

```js
// Runs in the thread of an img-threshold node
module.exports = function (worker, data) {
    worker.inputPorts.subscribe('gray', ({ width, height, gray }) => {
        const mask = new Uint8Array(gray.length);
        let lit = 0;
        for (let i = 0; i < gray.length; i++) {
            if (gray[i] >= data.level) { mask[i] = 255; lit++; }
        }
        worker.parentPorts.publish('mask', { width, height, mask, lit }, [mask.buffer]);
    });
};
```

The main thread of `img-threshold` gets no input message. The wire from `img-gray` only tells the mixin which workers to connect. A second wire on the `img-gray` output gets no frame: the first wire has the buffer already, and the publish to the second wire fails with a `DataCloneError`. For more wires, leave out the transferList; then each wire gets a copy.

## Request, publish and subscribe

| Call | Direction | Answer |
| --- | --- | --- |
| `worker.request(type, data)` | main thread to the one `worker.handle(type, fn)` handler in the worker | a Promise for the value that the handler returns |
| `publish(type, data)` | either side, to every `subscribe(type)` and `'default'` handler on the other side | none |
| `subscribe(type, handler)` | gets the other side's `publish(type)` messages | none |

The worker can send without a question, for example progress:

```js
// worker file
worker.parentPorts.publish('progress', 50);

// node
worker.subscribe('progress', (p) => thisNode.status({ text: `${p} %` }));
```

## Worker file

The worker file runs in its own thread. It has no `RED`, no node object, no flow or global context. It talks to the node only through messages. Objects arrive as structured clones (a `Buffer` arrives as a `Uint8Array`). `require` your own modules in the worker file.

The worker file exports one function, `(worker, data)`. CommonJS and ES modules both work:

```js
// my-worker.js (CommonJS)
module.exports = function (worker, data) { /* ... */ };
```

```js
// my-worker.mjs, or a .js file in a package with "type": "module"
export default function (worker, data) { /* ... */ }
```

A file that exports something else (for example only named exports) gives a load error that shows the two shapes above.

## Lifecycle

1. `init()` starts the thread. The thread loads the runtime, not your worker file yet. Call `init()` in the setup function, before any `await`.
2. After each deploy, on `flows:started`, the mixin connects each new worker to the worker nodes it is wired to. A worker that `init()` starts after `flows:started` is connected at once.
3. When all connections of a worker are ready, the optional `init()` callback runs on the main thread. Then the runtime calls your worker function one time.
4. When the node closes, the mixin publishes `close` to the worker, waits up to 2 seconds for its `close` handlers to finish, then terminates the thread. A worker in a long synchronous loop cannot run its `close` handler until the loop ends, so the deploy waits the full 2 seconds and the cleanup does not run. To let a long job stop in time, split it into parts with `await new Promise(setImmediate)` between them, and check a flag that your `close` handler sets.

A message can arrive before your worker function has run: for example the parent publishes on the first input, or an upstream worker publishes when it starts. The runtime holds such messages and delivers them in order after your function returns, so you do not need a `setTimeout` before the first publish. Subscribe synchronously in your worker function, not after an `await`. After the function has run, a message with no subscriber is dropped.

Call `worker.handle()` synchronously in your worker function too. A request that arrives before your function has run waits, as above. A request for a type with no handler rejects with an error that names the type.

To clean up in the worker, subscribe to `close`:

```js
worker.parentPorts.subscribe('close', () => { /* free resources */ });
```

## Errors

If your worker file throws while it loads, or worker code throws later and nothing catches it (for example in a `setTimeout` callback), Node-RED keeps running. The node:

- logs `Worker error: <message>` with `node.error`, so a Catch node gets it too,
- shows a red ring status with the text `worker error`.

The worker is not restarted. Its wires to other workers are closed. A Full deploy, or Restart Flows, starts it again; the default Modified Nodes deploy does not restart an unchanged node. Every `request()` that waits for an answer rejects, with `worker error: <message>` or `worker stopped with exit code <code>`, and later calls reject at once. Messages that the node publishes to the stopped worker are dropped.

When a redeploy or a delete closes the node, the pending requests reject with `worker request ended: the node closed`.

A throw inside a `subscribe` handler in the worker is different: the runtime catches it and logs it with `console.error`, and the worker keeps running. A throw inside a `handle` handler goes back to the caller of `request()`.

`publish()` and `request()` use the structured clone algorithm. Data that cannot be cloned, such as a function or an object that contains a function, makes `publish()` throw a `DataCloneError` at once, and makes `request()` reject with it. An answer from `handle()` that cannot be cloned rejects the request.

## One worker per node, jobs queue

Each node has one worker thread. A worker runs one piece of synchronous code at a time, so requests and messages to it wait in a queue. Ten messages that each need 1 s of CPU take 10 s on one node. To use more cores, put more nodes in the flow (for example behind a switch node that splits the messages), or start your own pool of `worker_threads` in the worker or the node.

A worker handler that is `async` and waits for I/O lets the next request start while it waits.

## Big results

The answer of a request, and the data of a publish, is copied between the threads (structured clone). The copy of a big object runs on the main thread when it arrives, and the event loop of Node-RED waits for it. Thus:

- send less: only the fields that the flow needs, or a summary;
- send big data in chunks, with `publish()`;
- move binary data without a copy: put the data in an `ArrayBuffer` and transfer it. In a `handle` handler, push the buffer into `transferList`, the second argument of the handler:

```js
worker.handle('render', (spec, transferList) => {
    const pixels = new Uint8Array(spec.width * spec.height * 4);
    // ... fill pixels ...
    transferList.push(pixels.buffer);   // moved, not copied; the worker cannot use it after this
    return pixels;
});
```

On the main thread, `request(type, data, transferList)` and `publish(type, data, transferList)` do the same in the other direction.

## API

### Main thread

`thisNode.nodeRedWorker.init(workerFile, [workerData], [callback])` starts the worker. `init()` returns the worker object (a `NodeRedWorker`, a subclass of Node's `Worker`); use the returned value. `workerFile` must be an absolute path, for example `path.join(__dirname, 'my-worker.js')`. A relative path throws a `TypeError` that names the path. `workerData` must be cloneable with the structured clone algorithm. Call `init()` one time for each node, in the setup function (see [Lifecycle](#lifecycle)). A second call throws. A call to `publish()`, `request()`, `subscribe()`, `on()` or `terminate()` before `init()` throws an error that says to call `init()` first.

- `publish(type, [data], [transferList])`: send to the worker. For `transferList`, see [Big results](#big-results). Throws a `DataCloneError` if `data` cannot be cloned. A Node `Buffer` arrives as a `Uint8Array` (use `Buffer.from(u8.buffer, u8.byteOffset, u8.length)` to get a `Buffer` again). The same is true in the other direction and between workers.
- `request(type, [data], [transferList], [options])`: send `data` to the worker's `handle(type)` handler. Returns a Promise for the value that the handler returns. It rejects with the error that the handler throws, with a `DataCloneError`, when the worker stops or fails, and when the node closes. `options.timeout`: reject after this many milliseconds with `worker request '<type>' timed out after <n> ms`. Default: no timeout. A timeout does not stop the work in the worker.
- `subscribe(type, handler)`: call `handler(data, senderTrace, receiverTrace, type)` for each message of `type` from the worker. See [the `default` type](#the-default-type). If a handler throws (or returns a promise that rejects), the node logs `worker message handler for '<type>' failed: <message>` with `node.error`, and a Catch node gets it. The other handlers for the same message still run. To tie the error to a message, put your own `try`/`catch` in the handler and call `done(err)` there.
- `namedPort(name)`: a `MessagePort` that the worker made with `parentPorts[0][0].createNamedPort()`, or `null`.
- `terminate()`: the close sequence in [Lifecycle](#lifecycle). The mixin calls it for you.

### Worker thread

Your worker file exports `function (worker, data)` (see [Worker file](#worker-file)).

`worker.handle(type, handler)`: answer the main thread's `request(type, ...)`. `handler(data, transferList)` returns the answer or a Promise for it. For `transferList`, see [Big results](#big-results). One handler for each type; a second `handle()` for the same type throws.

`worker` has three port groups:

- `worker.parentPorts`: to and from the main-thread node.
- `worker.inputPorts`: from upstream worker nodes.
- `worker.outputPorts`: to downstream worker nodes.

Each group has `publish(type, [data], [transferList])` and `subscribe(type, handler)`. See [Advanced: worker to worker](#advanced-worker-to-worker) for ports, wires and the other connection calls.

## Advanced: worker to worker

The [image pipeline](#example-an-image-pipeline-across-two-worker-nodes) shows the basic case: `outputPorts.publish()` in the upstream worker, `inputPorts.subscribe()` in the downstream worker.

Messages between workers do not go through the Node-RED runtime, so the Debug sidebar does not see them. Only nodes that use this mixin get these direct connections; a wire to a normal node does nothing on the worker side.

Subflows: worker nodes that are wired to each other inside a subflow are connected, in each subflow instance. A worker inside the subflow that is wired to a subflow output is also connected to the worker nodes that the output of the instance is wired to. A wire into a subflow input is not: the upstream worker is wired to the subflow instance node, which is not a worker. Send such data on the main thread instead (`node.send()` and an input handler).

Known limit: two worker nodes from different node packages, each with its own copy of this library, are not connected to each other.

Each group, each port (`worker.outputPorts[0]`) and each wire (`worker.outputPorts[0][1]`) has `publish(type, [data], [transferList])` and `subscribe(type, handler)`. The handler gets `(data, senderTrace, receiverTrace, type)`. The traces hold the node id and the port and wire numbers. A connection object also has:

- `unsubscribe(type, handler)`.
- `publishUntilAcknowledged(type, ackType, intervalMs, [data], [transferList])`: publish again every `intervalMs` until an `ackType` message arrives. Returns a function that stops it. If this connection already polls the same `type`, nothing is sent again and the stop function of that poll is returned. If it polls another type, that poll stops first.
- `pipe(target)`: forward every raw message from this connection to another connection, port or port group.
- `createNamedPort(myName, [theirName])`: open an extra `MessageChannel` to the other end and return your `MessagePort`. A downstream worker finds the other end in `worker.inputPorts[p][c].namedPorts[theirName]`. On a `parentPorts` connection, the main thread gets it from `namedPort(theirName)`.

A `publish` to a port with no connected worker is dropped without an error, as in Node-RED when an output has no wire. Use the `outputPorts[p][w]` numbers that match the node's `wires`.

Port and wire numbers:

- `outputPorts[p][w]`: `p` is the output of the node and `w` is the wire on that output, in the order of the node's `wires` in the flow. These numbers are stable.
- `inputPorts[0][w]`: a node has one input, so `p` is always `0`. `w` is a slot that the runtime gives to each upstream wire in the order the connections are made. When an upstream worker stops (for example a deploy changes it), its slot becomes free and the next new connection uses it. Thus the number of slots stays the same across deploys, but do not use `w` to find out which node sent a message. Use `senderTrace.nodeId`.

### The `default` type

A handler subscribed to `'default'` gets every message type, also the types that have their own handler, on the main thread and in the worker. It does not get the types that the library uses itself (`ack` and names that start with `_`). It gets `close`.

[Back to node-red-utils](../README.md)
