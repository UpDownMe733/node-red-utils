# node-red-utils

[![npm](https://img.shields.io/npm/v/@nrutils/node-red-utils)](https://www.npmjs.com/package/@nrutils/node-red-utils)

A toolkit for Node-RED custom nodes: worker threads, GPU compute, messages between the editor and the runtime, pub/sub between nodes, editor resources, a popup and singleton nodes.

- [`NodeRedNodeBase`](./node-red-base/README.md): builds a node from a setup function and a list of mixins. A mixin is one feature; you add it by listing it.
- [`nodeRedWorker`](./node-red-worker/README.md): runs node code in a worker thread. Wired worker nodes talk thread to thread, the same as the wires in the flow.
- [`nodeRedGpu`](./node-red-gpu/README.md) (experimental): Vulkan compute kernels in worker threads, with a CPU fallback.
- [`nodeRedEditorComms`](./node-red-editorcomms/README.md): messages between the runtime node and the same node in the editor.
- [`nodeRedPubsubBus`](./node-red-pubsub-bus/README.md): pub/sub for data that nodes share without wires.
- [`nodeRedResourceEndpoint`](./node-red-resourceendpoint/README.md): serves scripts, styles and images to the editor.
- [`nodeRedPopup`](./node-red-popup/README.md) (experimental): a resizable panel that opens when you click the node in the editor.
- [`nodeRedSingleton`](./node-red-singleton/README.md) (experimental): allows only one node of a type in the editor.

## Install

In your node package:

```bash
npm install @nrutils/node-red-utils
```

Works with Node-RED 4 and Node.js 18 or later.

## Building with AI

Use an AI coding assistant to build nodes!  Here's some [AI dreamed up paste-ready prompts](./prompts/README.md).  Not particularly useful nodes though.

## Example: a counter node

A node that counts messages, shows the count as its status, and resets the count when you click its button in the editor.

`counter.js`:

```js
const { NodeRedNodeBase, nodeRedEditorComms } = require('@nrutils/node-red-utils');

module.exports = NodeRedNodeBase.createNode('counter', [nodeRedEditorComms], (RED, thisNode, config) => {
    let count = 0;
    const show = () => thisNode.status({ text: `${count} messages` });

    // Sent by the button in counter.html
    thisNode.nodeRedEditorComms.subscribe('reset', () => {
        count = 0;
        show();
    });

    thisNode.on('input', (msg, send, done) => {
        count++;
        show();
        send(msg);
        done();
    });
});
```

`counter.html`:

```html
<script type="text/javascript" src="node-red-resourceendpoint/node-red-editorcomms/EditorCommsFrontend.js"></script>

<script type="text/javascript">
    RED.nodes.registerType('counter', {
        category: 'function',
        color: '#a6bbcf',
        defaults: { name: { value: '' } },
        inputs: 1,
        outputs: 1,
        icon: 'function.svg',
        label: function () { return this.name || 'counter'; },
        button: {
            onclick: function () {
                this.nodeRedEditorComms.publish('reset', {})
                    .catch((err) => RED.notify(err.status === 404 ? 'Deploy the node first' : err.message, 'warning'));
            }
        }
    });
</script>

<script type="text/html" data-template-name="counter">
    <div class="form-row">
        <label for="node-input-name"><i class="fa fa-tag"></i> Name</label>
        <input type="text" id="node-input-name" placeholder="Name">
    </div>
</script>
```

The first `<script>` line loads the editor side of `nodeRedEditorComms`. Copy this line exactly. The library serves the file; there is nothing to install.

## Example: a worker node

A node that hashes each payload in a worker thread, so the Node-RED event loop does not wait.

`hash-node.js`:

```js
const path = require('path');
const { NodeRedNodeBase, nodeRedWorker } = require('@nrutils/node-red-utils');

module.exports = NodeRedNodeBase.createNode('hash-node', [nodeRedWorker], (RED, thisNode, config) => {
    const worker = thisNode.nodeRedWorker.init(path.join(__dirname, 'hash-worker.js'), { rounds: 1000 });

    thisNode.on('input', (msg, send, done) => {
        worker.request('hash', String(msg.payload)).then((digest) => {
            msg.payload = digest;
            send(msg);
            done();
        }, done);
    });
});
```

`hash-worker.js`:

```js
const crypto = require('crypto');

module.exports = function (worker, data) {
    worker.handle('hash', (text) => {
        let digest = text;
        for (let i = 0; i < data.rounds; i++) digest = crypto.createHash('sha256').update(digest).digest('hex');
        return digest;
    });
};
```

## package.json

```json
{
  "name": "node-red-contrib-counter",
  "version": "0.1.0",
  "keywords": ["node-red"],
  "node-red": {
    "version": ">=4.0.0",
    "nodes": { "counter": "counter.js" }
  },
  "dependencies": { "@nrutils/node-red-utils": "^0.1.0" }
}
```

- The `.html` file sits next to the `.js` file and has the same base name.
- The type string in the HTML `registerType` equals the type in `createNode`.
- Put the library under `dependencies`, not `devDependencies`.

To load your node package into Node-RED on your own computer, run `cd ~/.node-red && npm install /path/to/your-package`, then restart Node-RED.

## Reference

Put the features you want in the array of `createNode`; they apply in that order, then `setup(RED, thisNode, config)` runs.

| Mixin | What it adds on `thisNode` | Editor script `<script src=...>` line |
| --- | --- | --- |
| `nodeRedWorker` | `nodeRedWorker`; call `init()` to start the worker | none |
| `nodeRedGpu` | nothing; the GPU API is in the worker, from `nodeRedGpuWorker()` | none |
| `nodeRedEditorComms` | `nodeRedEditorComms` | `node-red-resourceendpoint/node-red-editorcomms/EditorCommsFrontend.js` |
| `nodeRedPubsubBus` | `nodeRedPubsubBus` | none |
| `nodeRedResourceEndpoint` | `nodeRedResourceEndpoint` | none |
| `nodeRedPopup` | nothing | `node-red-resourceendpoint/node-red-popup/NodeRedPopupFrontend.js` |
| `nodeRedSingleton` | nothing | `node-red-resourceendpoint/node-red-singleton/NodeRedSingletonFrontend.js` |

A mixin with an editor script must be in the array, or the script answers 404.

Exports: `NodeRedNodeBase` and the lowercase mixins above, plus:

- `getBus()`: the pub/sub bus of the process, for code that is not a node.
- `NodeRedResourceEndpoint`: serves files without a node instance; `new NodeRedResourceEndpoint(RED).registerResources(nodeType, paths)`.

To write your own mixin, see [node-red-base](./node-red-base/README.md#write-a-mixin).

## Examples

[`examples/basic-examples`](./examples/README.md) has one small node package for each feature. Install one with `cd ~/.node-red && npm install --install-links /path/to/node-red-utils/examples/basic-examples/<name>`, then restart Node-RED.

## Troubleshooting

- The editor script gets a 404 (for example `node-red-resourceendpoint/node-red-editorcomms/EditorCommsFrontend.js`, in the browser's network tab): the mixin is not in the `createNode` array of a node type that Node-RED loaded, or the `src` of the `<script>` tag starts with `/`. Restart Node-RED after you install or change a node package.

## Contributing

Issues and pull requests are welcome on [GitHub](https://github.com/UpDownMe733/node-red-utils/issues). Run `npm test` before you send a pull request.

## License

[Apache-2.0](./LICENSE)
