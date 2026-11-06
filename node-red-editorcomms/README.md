# node-red-editorcomms

Send messages between a runtime node and the same node in the editor.

## Usage

A node that draws a live chart of its numeric payloads in its edit dialog. When the dialog opens, it asks the runtime for the last 100 values. While the dialog is open, the runtime pushes each new value.

`live-chart.js`:

```js
const { NodeRedNodeBase, nodeRedEditorComms } = require('@nrutils/node-red-utils');

module.exports = NodeRedNodeBase.createNode('live-chart', [nodeRedEditorComms], (RED, thisNode, config) => {
    const comms = thisNode.nodeRedEditorComms;
    const history = [];     // the last 100 numbers

    // The edit dialog asks for the history when it opens. The return value is the answer.
    comms.subscribe('history', () => history);

    thisNode.on('input', (msg, send, done) => {
        const value = Number(msg.payload);
        if (Number.isFinite(value)) {
            history.push(value);
            if (history.length > 100) history.shift();
            comms.publish('value', value);      // to every open editor, at once
        }
        send(msg);
        done();
    });
});
```

`live-chart.html`:

```html
<script type="text/javascript" src="node-red-resourceendpoint/node-red-editorcomms/EditorCommsFrontend.js"></script>

<script type="text/javascript">
(function () {
    let open = null;    // { id, points } of the live-chart node whose edit dialog is open

    function draw() {
        const canvas = document.getElementById('live-chart-canvas');
        const min = Math.min(...open.points);
        const span = Math.max(...open.points) - min || 1;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.beginPath();
        open.points.forEach((v, i) => ctx.lineTo(i * canvas.width / 99, canvas.height * (1 - (v - min) / span)));
        ctx.stroke();
    }

    RED.nodes.registerType('live-chart', {
        category: 'function',
        color: '#c7e9c0',
        defaults: { name: { value: '' } },
        inputs: 1,
        outputs: 1,
        label: function () { return this.name || 'live-chart'; },

        // From the runtime on each message. "this" is the editor node.
        nodeRedEditorComms_subscriptions: {
            value: function (v) {
                if (!open || open.id !== this.id || !open.points) return;
                open.points.push(v);
                if (open.points.length > 100) open.points.shift();
                draw();
            }
        },

        oneditprepare: function () {
            const state = open = { id: this.id, points: null };
            this.nodeRedEditorComms.publish('history')
                .then((points) => { if (open === state) { state.points = points; draw(); } })
                .catch((err) => $('#live-chart-info').text(err.status === 404 ? 'Deploy the node first' : err.message));
        },
        oneditsave: function () { open = null; },
        oneditcancel: function () { open = null; }
    });
})();
</script>

<script type="text/html" data-template-name="live-chart">
    <div class="form-row">
        <label for="node-input-name"><i class="fa fa-tag"></i> Name</label>
        <input type="text" id="node-input-name" placeholder="Name">
    </div>
    <canvas id="live-chart-canvas" width="460" height="120"></canvas>
    <div id="live-chart-info"></div>
</script>
```

The runtime mixin must be in the `createNode` list: its `onRegisterType` serves the editor script, so without it the `<script>` tag in the HTML file gets a 404 and `nodeRedEditorComms` is missing in the editor.

Open the edit dialog and the chart shows the values so far. While the dialog is open, each new message adds a point. A node that is not deployed answers 404, and the dialog says so.

Runtime data shown in the editor must be set with `.text()` or `textContent`, never with `.html()` or `innerHTML`: a message payload can hold HTML that would run as script in the editor.

The first `<script>` tag loads the editor half of this module. The library serves its editor files through [node-red-resourceendpoint](../node-red-resourceendpoint/README.md), at `node-red-resourceendpoint/<name>/<file>` under the editor URL. Here `<name>` is `node-red-editorcomms`. The URL has no leading `/`, so it also works when the editor is not at the root of the server. Load the script one time in each node's HTML file; a second load does nothing.

## API

| Side | `publish(type, data)` | `subscribe(type, ...)` |
| --- | --- | --- |
| Runtime | goes to this node in every open editor; no answer | `subscribe(type, handler)`: the handler's return value answers the editor's `publish` |
| Editor | goes to the runtime node with the same id; returns a Promise for the handler's return value | `subscribe(type, [nodeId], cb)`: gets the runtime's `publish` |

The runtime does not keep a published message: an editor that opens later does not get it. Publish when the value changes, and let a new editor ask for the current value, as `history` does in the example.

### Runtime: `thisNode.nodeRedEditorComms`

- `subscribe(messageType, callback)`: call `callback(payload)` when the editor publishes `messageType` for this node. The return value of `callback` (or the value of its Promise) goes back to the editor as the result of the editor's `publish`. A second `subscribe` with the same type replaces the first.
- `publish(messageType, [payload])`: send `payload` to this node in every open editor.

Both return the API object, so you can chain calls (`thisNode.nodeRedEditorComms.publish('a', 1).publish('b', 2)`).

### Editor: `node.nodeRedEditorComms`

The frontend script adds this object to every node in the editor.

- `publish(messageType, [payload])`: send to the runtime node with the same id. Returns a native `Promise` that resolves with the return value of the runtime handler (`undefined` if it returns nothing). It rejects with an `Error` that has a `status`; see [Errors](#errors).
- `subscribe(messageType, callback)`: call `callback(payload)` when the runtime node with the same id publishes `messageType`.
- `subscribe(messageType, nodeId, callback)`: the same for the runtime node `nodeId`. You need this form only to listen to another node. A second `subscribe` for the same node and type replaces the first. It returns nothing.

`nodeRedEditorComms_subscriptions` in the node definition is the short form of `subscribe`. The script registers each entry when a node is added, with `this` bound to the node. Prefer it to `subscribe()`, for the reasons in the next section.

### Limits of editor `subscribe()`

- There is no `unsubscribe`. To stop a handler, replace it with a new `subscribe` for the same type, for example with `() => {}`.
- When you delete a node in the editor, the script removes all of its handlers. If you undo the delete, the entries of `nodeRedEditorComms_subscriptions` come back, but handlers that you added with `subscribe()` do not.

## Errors

The Promise of the editor's `publish` rejects with an `Error` that has a `status`:

- 404, body `{"status":"no handler"}`: the runtime has no handler for this node and type. The usual cause is a node that is not deployed yet. A node inside a subflow also gets 404: each subflow instance gives its inner nodes new runtime ids that the editor does not know.
- 500, body `{"error":"<message>"}`: the handler threw or its Promise rejected. `err.message` is the handler's error message. The runtime node also logs `Editor message '<type>' failed: <message>` with `node.error`. It is not a flow message, so a Catch node does not get it.
- 0: the runtime cannot be reached.

Add a `.catch` to each `publish`, also when you ignore the error, so the browser does not report an unhandled rejection.

## Preview or Test button

A button in the edit dialog that tries the settings before the user clicks Done:

- Read the values from the form fields (`$('#node-input-url').val()`), not from `this`, and send them in the payload. Until Done, `this` holds the saved values.
- For an expected user error, such as a bad URL, return `{ error: 'text' }` and show it in the dialog. The request resolves, and the Node-RED log stays quiet.
- A node that is not deployed answers 404. Show "deploy first" for `err.status === 404`.

```js
// Runtime
thisNode.nodeRedEditorComms.subscribe('test-url', async ({ url }) => {
    if (!/^https?:\/\//.test(url)) return { error: 'The URL must start with http:// or https://' };
    const res = await fetch(url);           // a network failure throws: 500 and a log line
    return { status: res.status };
});
```

## Security

Any editor user with the `write` permission can POST any message type with any payload to any node id. Thus treat the payload in a runtime handler as user input: check its type and range before you use it, and do not pass it to a shell, a file path or `eval`. Users with read-only access cannot POST, but they get all messages that the runtime publishes to the editor.

[Back to node-red-utils](../README.md)
