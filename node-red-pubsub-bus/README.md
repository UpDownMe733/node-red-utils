# node-red-pubsub-bus

An in-process pub/sub bus for data that nodes share without a wire: readings, settings, calibration, schemas.

A producer node offers named entries. A consumer subscribes to an entry and gets an event when the entry changes. The event does not carry the value; the consumer asks the producer for the current value with `getMetadata`. A consumer that subscribes after the producer has registered the entry gets one `connect` event, so it can ask for the value at once. If the producer has no such entry yet, the consumer gets nothing until the producer adds the entry and calls `notifyChange`.

## Usage

A producer node reads the CPU temperature every 2 seconds and offers it as the entry `latest`. It has no input and no wire:

```js
const fs = require('fs');
const { NodeRedNodeBase, nodeRedPubsubBus } = require('@nrutils/node-red-utils');

// Reads the CPU temperature every 2 s and offers it on the bus as the entry 'latest'
module.exports = NodeRedNodeBase.createNode('cpu-temp', [nodeRedPubsubBus], (RED, thisNode, config) => {
    const bus = thisNode.nodeRedPubsubBus;
    let latest = null;

    bus.registerProducer(thisNode.id, {
        getEntries: () => (latest === null ? [] : [{ name: 'latest', type: 'acme/reading_v1' }]),
        getMetadata: (name) => (name === 'latest' ? latest : null)
    });

    const timer = setInterval(() => {
        fs.readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8', (err, text) => {
            if (err) return thisNode.status({ fill: 'red', shape: 'ring', text: err.code });
            const celsius = Number(text) / 1000;
            if (latest && latest.celsius === celsius) return;   // no change, no event
            latest = { celsius, time: Date.now() };
            bus.notifyChange(thisNode.id, 'latest');
        });
    }, 2000);
    thisNode.on('close', () => clearInterval(timer));
});
```

A consumer node subscribes to `<producerId>/<entry>` and pulls the value on each event:

```js
const { NodeRedNodeBase, nodeRedPubsubBus } = require('@nrutils/node-red-utils');

module.exports = NodeRedNodeBase.createNode('bus-consumer', [nodeRedPubsubBus], (RED, thisNode, config) => {
    const bus = thisNode.nodeRedPubsubBus;

    if (!config.producer) {                 // no producer selected in the edit dialog
        thisNode.status({ fill: 'grey', shape: 'ring', text: 'no producer selected' });
        return;
    }

    bus.subscribe(`${config.producer}/latest`, async (event) => {
        if (event.kind === 'disconnect') {  // the producer is gone
            thisNode.status({ text: 'no producer' });
            return;
        }
        try {
            const value = await bus.getMetadata(event.producerId, event.desc);
            if (value === null) return;     // no value yet, or the producer is gone
            thisNode.send({ payload: value, kind: event.kind });
        } catch (err) {
            thisNode.error(err);            // for example a worker producer that did not reply
        }
    });
});
```

Use as many consumer nodes as you need, on any flow tab. Each one reads the same producer. A consumer that is deployed later gets `connect` and pulls the current reading at once.

`config.producer` is the producer's node id. In the editor, fill a dropdown from the [discovery endpoint](#discovery-endpoint); see [Producer dropdown in the edit dialog](#producer-dropdown-in-the-edit-dialog).

## How it works

- Events carry no payload. Every event is `{ producerId, desc, type, kind }`, where `desc` is the entry name. The consumer pulls the value with `getMetadata`, so it never acts on a stale copy.
- `kind` is one of:
  - `'change'`: goes to all subscribers of the entry when the producer registers or calls `notifyChange`.
  - `'connect'`: goes to one new subscriber if the entry already exists.
  - `'disconnect'`: goes to all subscribers of the entry when the producer unregisters: its node closes (redeploy, delete), its worker exits, or it calls `unregister()`. The subscription stays. If the producer comes back with the same id, the subscriber gets a `change`.

  Handle `change` and `connect` the same way: pull now. On `disconnect`, show that the producer is gone.
- `getEntries()` decides what exists. An entry that `getEntries()` does not return gets no events, does not show in `listProducers()`, and does not get a `disconnect`. Return `[]` to hide the entries until there is a value.
- `type` is a free-form string that the producer picks, such as `acme/reading_v1`. The bus does not check it.
- The method names call the value "metadata" (`getMetadata`). It can be any value.
- When a node closes, the mixin removes its subscriptions, its producers, its `onProducerRegistered` handlers and its attached workers. When a worker exits, the bus removes everything that the worker registered. Subscribers of the removed producers get `disconnect`.
- There is one bus per Node-RED process. Producer ids must be unique; `thisNode.id` is a good choice.

## API

All methods are on `thisNode.nodeRedPubsubBus`.

- `registerProducer(producerId, { getEntries, getMetadata })` returns `unregister()`. `getEntries()` returns `[{ name, type }]`. `getMetadata(name)` returns the value or a Promise. Throws if `producerId` is already registered. `producerId` must not contain `/`, because the topic `<producerId>/<entry>` uses `/` to separate the two parts.
- `notifyChange(producerId, name)`: send a `change` for one entry. Call it after the value changes. If `getEntries()` has no entry `name` (or the producer is not registered), nothing is sent; the node logs a line at `debug` level. Add the entry to `getEntries()` first.
- `subscribe(topic, handler)` returns `unsubscribe()`. `topic` is `<producerId>/<entry>`. `handler(event)` can be `async`. If it throws or its Promise rejects, the node logs `pubsub subscriber of <topic> failed: <message>` with `node.error`, and the other subscribers and the producer are not affected.
- `getMetadata(producerId, name)`: always a Promise for the value. It gives `null` if there is no such producer. A producer also returns `null` when it has no value yet, so treat `null` as "no value now". The Promise rejects if the producer's `getMetadata` throws, or if a worker producer does not reply within 5 seconds, so use `await` in a `try`/`catch`.
- `publish(topic, event)`: emit your own event. It must have `producerId`, `desc`, `type` and `kind`.
- `onProducerRegistered(handler)` returns `unsubscribe()`. Calls `handler(producerId)` for each new producer, for example one that starts after deploy.
- `listProducers()`: `[{ producerId, entries: [{ name, type }] }]`. It holds only producers that are registered now, which means deployed and running nodes, from all node packages in this Node-RED. A node that is in the editor but not deployed is not in the list.
- `listTopics()`, `listSubscribers(topic)`: topic names and the subscriber count, for debugging.
- `attachWorker(worker)` returns `detach()`. Connects a worker thread to the bus; see below.

## Discovery endpoint

The mixin adds `GET /node-red-pubsub-bus/producers` to the admin API when Node-RED loads a node type that uses it, so the route exists before the first deploy. It returns `listProducers()` as JSON (`[]` if no producer runs) and needs the `flows.read` permission. In the editor, use a relative URL, so that the editor sends its login token:

```js
$.getJSON('node-red-pubsub-bus/producers', (producers) => { /* fill a <select> */ });
```

## Producer dropdown in the edit dialog

A consumer node stores the producer's node id in a `producer` property. This edit dialog lists the running producers that have an entry `latest` of type `acme/reading_v1`. Each option shows the producer node's name from the editor (`RED.nodes.node(id)`), so the producer needs no label option. If the saved producer does not run now (not deployed, or its worker stopped), the dialog keeps it as a "not running" option, so opening and closing the dialog does not clear it.

```html
<script type="text/javascript">
    RED.nodes.registerType('bus-consumer', {
        category: 'function',
        defaults: { name: { value: '' }, producer: { value: '' } },
        inputs: 1,
        outputs: 1,
        label: function () { return this.name || 'bus-consumer'; },
        oneditprepare: function () {
            const node = this;
            const select = $('#node-input-producer');
            const label = (id) => { const n = RED.nodes.node(id); return (n && n.name) || id; };
            $.getJSON('node-red-pubsub-bus/producers', function (producers) {
                const running = producers.filter((p) =>
                    p.entries.some((e) => e.name === 'latest' && e.type === 'acme/reading_v1'));
                select.empty().append($('<option>').val('').text('- select a producer -'));
                for (const p of running) {
                    select.append($('<option>').val(p.producerId).text(label(p.producerId)));
                }
                if (node.producer && !running.some((p) => p.producerId === node.producer)) {
                    select.append($('<option>').val(node.producer).text(label(node.producer) + ' (not running)'));
                }
                select.val(node.producer);
            });
        }
    });
</script>

<script type="text/html" data-template-name="bus-consumer">
    <div class="form-row">
        <label for="node-input-name">Name</label>
        <input type="text" id="node-input-name">
    </div>
    <div class="form-row">
        <label for="node-input-producer">Producer</label>
        <select id="node-input-producer"></select>
    </div>
</script>
```

Points to know:

- Only deployed, running producers are in the list. Add a producer node, then deploy, then open the consumer's dialog.
- A producer whose `getEntries()` returns `[]` (no value yet) does not pass the filter.
- The list holds producers of all node packages. Filter by entry name and `type` to keep only the ones your node can read.

## Producers in a worker thread

If the data lives in a [worker](../node-red-worker/README.md), attach the worker on the main thread:

```js
const path = require('path');
const { NodeRedNodeBase, nodeRedWorker, nodeRedPubsubBus } = require('@nrutils/node-red-utils');

module.exports = NodeRedNodeBase.createNode('bus-worker-producer', [nodeRedWorker, nodeRedPubsubBus], (RED, thisNode, config) => {
    const worker = thisNode.nodeRedWorker.init(path.join(__dirname, 'worker.js'), { id: thisNode.id });
    thisNode.nodeRedPubsubBus.attachWorker(worker);
});
```

Then use the worker proxy in the worker file:

```js
const pubsub = require('@nrutils/node-red-utils/node-red-pubsub-bus-workerproxy');

module.exports = function (worker, data) {
    let latest = null;
    pubsub.registerProducer(data.id, {
        getEntries: () => (latest === null ? [] : [{ name: 'latest', type: 'acme/reading_v1' }]),
        getMetadata: (name) => (name === 'latest' ? latest : null)
    });
    worker.parentPorts.subscribe('reading', (value) => {
        latest = value;
        pubsub.notifyChange(data.id, 'latest');
    });
};
```

Life of a worker producer:

- Use the node id as the producer id: pass `thisNode.id` to the worker and register with it. Producer ids are unique in the process, and consumers store this id.
- On a redeploy the old node closes first. The mixin detaches its worker, the bus removes the producer, and subscribers get `disconnect`. Then the new node starts a new worker, which registers the same id again, and subscribers get `change`.
- If a worker registers an id that is already registered, the bus does not register it. The node logs the error and shows a red status. Node-RED keeps running.
- With `nodeRedWorker`, the close handler needs no pubsub code: the mixin detaches the worker and `nodeRedWorker` stops it.
- With a raw `new Worker(...)`, the mixin also detaches it on close, but the thread keeps running. Call `worker.terminate()` in your close handler.
- `unregister()` from the proxy only stops the worker's own answers. The main thread removes a worker producer when the node closes or the worker exits.

The proxy has `publish`, `subscribe`, `registerProducer`, `notifyChange` and `getMetadata`. Each call goes to the main-thread bus over `parentPort`; `getMetadata` always returns a Promise. That Promise rejects after 5 seconds without a reply, for example when the host did not call `attachWorker`. On its first call the proxy sends a ping that `attachWorker` answers. If no answer comes within 5 seconds, the proxy logs one warning. The usual cause is a missing `attachWorker`.

[Back to node-red-utils](../README.md)
