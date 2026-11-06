# node-red-resourceendpoint

Serve files from your node package to the editor: scripts, stylesheets, images, JSON.

## Usage

```js
const path = require('path');
const { NodeRedNodeBase, nodeRedResourceEndpoint } = require('@nrutils/node-red-utils');

module.exports = NodeRedNodeBase.createNode('chart-node', [nodeRedResourceEndpoint], (RED, thisNode, config) => {
    // the runtime code of the node
}, {
    resources: [
        path.join(__dirname, 'public'),            // every file under public/
        path.join(__dirname, 'icons', 'chart.svg') // one file
    ]
});
```

Put the paths in `resources` in the fourth argument of `createNode`. They are registered when Node-RED loads the node, before any deploy, so the editor can load the files at once. `init()` exists for paths that depend on `config`; they are served only after the first deploy. `createNode` does not pass `resources` on to `RED.nodes.registerType`; the other keys (`credentials`, `settings`) still go there. The mixin must be in the `mixins` array.

The files are now served under `node-red-resourceendpoint/chart-node/` relative to the editor URL. In the node's `.html`, use relative URLs so that `httpAdminRoot` and reverse proxies work:

```html
<script type="text/javascript" src="node-red-resourceendpoint/chart-node/chart-lib.js"></script>
<link rel="stylesheet" href="node-red-resourceendpoint/chart-node/chart.css">
<img src="node-red-resourceendpoint/chart-node/chart.svg">
```

## Example: a model list for the edit dialog

The edit dialog of an I2C sensor node fills a dropdown from a JSON file of the package, and sets the address of the selected model. This works for a new node that is not deployed yet, because the files are served from when Node-RED loads the node. [`nodeRedEditorComms`](../node-red-editorcomms/README.md) cannot do this: it needs a deployed node.

`i2c-sensor.js`:

```js
const path = require('path');
const { NodeRedNodeBase, nodeRedResourceEndpoint } = require('@nrutils/node-red-utils');

module.exports = NodeRedNodeBase.createNode('i2c-sensor', [nodeRedResourceEndpoint], (RED, thisNode, config) => {
    thisNode.on('input', (msg, send, done) => {
        msg.payload = { model: config.model, address: Number(config.address) };   // read the device here
        send(msg);
        done();
    });
}, {
    resources: [path.join(__dirname, 'editor')]     // editor/models.json and anything else in editor/
});
```

`editor/models.json`:

```json
[
    { "id": "bme280", "label": "Bosch BME280", "address": 118 },
    { "id": "sht31", "label": "Sensirion SHT31", "address": 68 }
]
```

`i2c-sensor.html`:

```html
<script type="text/javascript">
    RED.nodes.registerType('i2c-sensor', {
        category: 'input',
        color: '#e2d96e',
        defaults: { model: { value: 'bme280' }, address: { value: 118 } },
        inputs: 1,
        outputs: 1,
        label: function () { return this.model; },
        oneditprepare: function () {
            const node = this;
            const select = $('#node-input-model');
            // A file of this package: it loads also for a new node that is not deployed
            $.getJSON('node-red-resourceendpoint/i2c-sensor/models.json', function (models) {
                for (const m of models) select.append($('<option>').val(m.id).text(m.label));
                select.val(node.model).on('change', function () {
                    const model = models.find((m) => m.id === select.val());
                    if (model) $('#node-input-address').val(model.address);
                });
            });
        }
    });
</script>

<script type="text/html" data-template-name="i2c-sensor">
    <div class="form-row">
        <label for="node-input-model">Model</label>
        <select id="node-input-model"></select>
    </div>
    <div class="form-row">
        <label for="node-input-address">Address</label>
        <input type="text" id="node-input-address">
    </div>
</script>
```

## URL rules

URLs have the form `node-red-resourceendpoint/<nodeType>/<path>`.

- A registered file is served under its base name: `icons/chart.svg` above becomes `.../chart-node/chart.svg`.
- A registered directory serves every file inside it, also in subdirectories: `public/js/app.js` becomes `.../chart-node/js/app.js`.
- Anything else returns 404 and logs a warning.

## Warnings

Registration logs a warning with `RED.log.warn` when:

- a registered path does not exist, so its URLs would return 404;
- two different npm packages register files for the same `nodeType`. Both sets of files are served under the same URL prefix, and for the same file name the first registration wins. Use your node type, which is unique, as `nodeType`.

## Security

The route has no auth check, also when `adminAuth` is on.
Serve only files that are safe to make public: editor scripts, styles, images.

[Back to node-red-utils](../README.md)
