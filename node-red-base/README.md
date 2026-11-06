# node-red-base

`NodeRedNodeBase` turns a list of mixins and a setup function into a Node-RED node module.

## Usage

```js
const { NodeRedNodeBase } = require('@nrutils/node-red-utils');

module.exports = NodeRedNodeBase.createNode('upper-case', [], (RED, thisNode, config) => {
    thisNode.on('input', (msg, send, done) => {
        msg.payload = String(msg.payload).toUpperCase();
        send(msg);
        done();
    });
});
```

Put mixins in the array to add features. With an empty array you get a plain node with less code than the usual `registerType` wrapper.

## Example: one node with two mixins

A vibration sensor node. Its [worker](../node-red-worker/README.md) computes the RMS of each block of samples, off the Node-RED event loop. The node shows the result in its status, on its output and, through [editor comms](../node-red-editorcomms/README.md), in its open edit dialog. The Reset button goes from the dialog to the runtime to the worker, and the answer comes back to the dialog.

`vibration.js`:

```js
const path = require('path');
const { NodeRedNodeBase, nodeRedWorker, nodeRedEditorComms } = require('@nrutils/node-red-utils');

module.exports = NodeRedNodeBase.createNode('vibration', [nodeRedWorker, nodeRedEditorComms], (RED, thisNode, config) => {
    const worker = thisNode.nodeRedWorker.init(path.join(__dirname, 'vibration-worker.js'), { rate: 1000 });
    const comms = thisNode.nodeRedEditorComms;

    // Each second from the worker: to the status, to an open edit dialog, and to the flow
    worker.subscribe('rms', ({ rms, peak }) => {
        thisNode.status({ fill: rms > 1 ? 'red' : 'green', shape: 'dot', text: `rms ${rms.toFixed(2)}` });
        comms.publish('rms', { rms, peak });
        thisNode.send({ payload: rms, peak });
    });

    // The Reset button in the dialog: editor to runtime to worker, and the answer back
    comms.subscribe('reset-peak', () => worker.request('reset-peak', null, [], { timeout: 2000 }));
});
```

`vibration-worker.js`:

```js
// Stand-in for a driver that reads a block of samples from an ADC
const readSamples = (n) => Float64Array.from({ length: n }, (_, i) => Math.sin(i / 5) + Math.random() * 0.1);

module.exports = function (worker, data) {
    let peak = 0;
    const timer = setInterval(() => {
        let sum = 0;
        for (const v of readSamples(data.rate)) {
            sum += v * v;
            peak = Math.max(peak, Math.abs(v));
        }
        worker.parentPorts.publish('rms', { rms: Math.sqrt(sum / data.rate), peak });
    }, 1000);

    // The answer to request('reset-peak'): the peak before the reset
    worker.handle('reset-peak', () => { const before = peak; peak = 0; return before; });
    worker.parentPorts.subscribe('close', () => clearInterval(timer));
};
```

`vibration.html`:

```html
<script type="text/javascript" src="node-red-resourceendpoint/node-red-editorcomms/EditorCommsFrontend.js"></script>

<script type="text/javascript">
    RED.nodes.registerType('vibration', {
        category: 'input',
        defaults: {},
        outputs: 1,
        label: function () { return 'vibration'; },
        // Only the open dialog of this node has the data-node attribute
        nodeRedEditorComms_subscriptions: {
            rms: function (v) { $('#vibration-live[data-node="' + this.id + '"]').text('rms ' + v.rms.toFixed(2) + ', peak ' + v.peak.toFixed(2)); }
        },
        oneditprepare: function () {
            const node = this;
            $('#vibration-live').attr('data-node', node.id);
            $('#vibration-reset').on('click', () => node.nodeRedEditorComms.publish('reset-peak')
                .then((before) => RED.notify('Peak before the reset: ' + before.toFixed(2)))
                .catch((err) => RED.notify(err.status === 404 ? 'Deploy the node first' : err.message, 'warning')));
        }
    });
</script>

<script type="text/html" data-template-name="vibration">
    <div class="form-row">
        <span id="vibration-live">waiting for data</span>
        <button type="button" id="vibration-reset" class="red-ui-button">Reset peak</button>
    </div>
</script>
```

## API

### `NodeRedNodeBase.createNode(nodeType, mixins, setup, [options])`

Returns `function (RED)` for `module.exports`. That function calls `onRegisterType(RED)` on the composed class one time, then registers `nodeType` with `RED.nodes.registerType(nodeType, constructor, options)`. For each node instance it:

1. calls `RED.nodes.createNode(this, config)`,
2. applies the mixins left to right,
3. calls `setup(RED, thisNode, config)`, where `thisNode` is the Node-RED node.

Register your `input` and `close` handlers, and call mixin methods such as `nodeRedWorker.init()`, before the first `await` in `setup`. `createNode` does not await `setup`; an error after an `await` is only logged with `node.error` as `setup of <type> failed: <message>`.

`options` is optional. It is the third argument of `RED.nodes.registerType`, for example `{ credentials }` or `{ settings }`. See [Credentials and settings](#credentials-and-settings). One more key, `resources`, is for the [`nodeRedResourceEndpoint`](../node-red-resourceendpoint/README.md) mixin: an array of file and directory paths that it serves from when Node-RED loads the node. `createNode` does not pass `resources` on to `registerType`. Without the mixin in `mixins`, `resources` does nothing.

`mixins` is always an array; use `[]` for none. `createNode()` and `with()` check their arguments and throw one `TypeError` that names the function and the bad argument, for example `createNode(type, mixins, setup): mixins must be an array of mixin functions; got function (anonymous)`. A common mistake is to pass a class, such as `NodeRedWorker`, instead of the mixin `nodeRedWorker`.

### `NodeRedNodeBase.with(...mixins)`

Returns a class that extends `NodeRedNodeBase` with the mixins applied. `createNode` uses it. You only need it to compose classes yourself, for example in a node that cannot use `createNode` (see [Adding the library to an existing node](#adding-the-library-to-an-existing-node)). If you do, call `MyClass.onRegisterType(RED)` one time before `RED.nodes.registerType`. Without that call, the editor scripts of `nodeRedEditorComms`, `nodeRedPopup` and `nodeRedSingleton` are not served until a node starts.

### `static onRegisterType(RED)`

`createNode` calls this one time, before any node instance exists. `nodeRedEditorComms`, `nodeRedPopup` and `nodeRedSingleton` override it to serve their editor scripts before the first deploy. `nodeRedResourceEndpoint`, `nodeRedPubsubBus` and `nodeRedWorker` override it too, for their own one-time work. A mixin that needs one-time work can override it too; call `super.onRegisterType(RED)` first.

## Credentials and settings

The fourth argument of `createNode` goes to `registerType` as its options, for example `{ credentials: { token: { type: 'password' } } }`. Node-RED then stores the credentials outside the flow file and puts them on `thisNode.credentials`. The HTML file needs the same `credentials` definition and an input with the id `node-input-<name>`. Use the credential inside the node. Do not copy it onto `msg`.

## Config nodes

A config node holds settings that several nodes share, such as a server address. Make it with `createNode` and give it the category `config` in the HTML file; the ids in its template start with `node-config-input-`. A consumer node stores the config node's id and reads it with `RED.nodes.getNode(id)`, which returns `null` when no config node is selected. Both types can go in one file:

```js
const server = NodeRedNodeBase.createNode('my-server', [], (RED, thisNode, config) => {
    thisNode.host = config.host;
}, { credentials: { password: { type: 'password' } } });

const query = NodeRedNodeBase.createNode('my-query', [], (RED, thisNode, config) => {
    const serverNode = RED.nodes.getNode(config.server);
    thisNode.on('input', (msg, send, done) => {
        if (!serverNode) return done(new Error('no server configured'));
        // use serverNode.host and serverNode.credentials.password here
        send(msg);
        done();
    });
});

module.exports = function (RED) {
    server(RED);
    query(RED);
};
```

In the HTML file, `server: { value: '', type: 'my-server' }` in the consumer's `defaults` gives a config node picker. `package.json` lists the file one time; the HTML of both types goes in the `.html` file with the same name.

## Adding the library to an existing node

A node that you already have, or that must keep its own constructor, does not need `createNode`. Compose the class with `with()` and create it in your constructor:

```js
const { NodeRedNodeBase, nodeRedWorker } = require('@nrutils/node-red-utils');

module.exports = function (RED) {
    const Base = NodeRedNodeBase.with(nodeRedWorker);
    Base.onRegisterType(RED);                 // one time, before registerType

    function MyNode(config) {
        RED.nodes.createNode(this, config);   // as before
        new Base(RED, this, config);          // adds thisNode.nodeRedWorker and so on
        // your existing code
    }

    RED.nodes.registerType('my-node', MyNode, { credentials: { token: { type: 'password' } } });
};
```

Steps: pick the mixins, call `with()` and `onRegisterType(RED)` once in the module function, call `new Base(RED, this, config)` after `RED.nodes.createNode` in the node constructor. The rest of the node stays as it is. The mixins add their API to `this` (the node) as `this.nodeRedWorker`, `this.nodeRedEditorComms` and so on. For editor mixins, also add the script tag to the HTML file (see the README of each mixin).

## Write a mixin

A mixin is a function that takes a class and returns a subclass. Its constructor gets `(RED, thisNode, config)`.

```js
const { NodeRedNodeBase } = require('@nrutils/node-red-utils');

const heartbeat = (superclass) => class extends superclass {
    constructor(RED, thisNode, config) {
        super(RED, thisNode, config);
        let timer = null;

        thisNode.heartbeat = {
            start(ms) {
                clearInterval(timer);
                timer = setInterval(() => thisNode.send({ payload: Date.now() }), ms);
            }
        };

        thisNode.on('close', () => clearInterval(timer));
    }
};

module.exports = NodeRedNodeBase.createNode('heartbeat', [heartbeat], (RED, thisNode, config) => {
    thisNode.heartbeat.start(Number(config.interval) || 1000);
});
```

Follow the same rules as the built-in mixins:

- Put the API on `thisNode` under one name. `setup` receives `thisNode`, not the mixin instance.
- Release timers, handlers and workers in `thisNode.on('close')`. Node-RED closes a node when a deploy replaces or removes it.
- `with()` and `createNode()` call each mixin with a dummy class to check it, so a mixin function may be called more than once. Do no work in the arrow function itself; do it in the constructor.

[Back to node-red-utils](../README.md)
