# node-red-popup

EXPERIMENTAL. The API and the behavior can change in a minor release.

A small resizable, movable panel attached to a node in the editor. A click on the node opens or closes it. The panel unfurls from the node.

## Usage

A popup that shows the last message of the node on the canvas, without opening the edit dialog. It uses [`nodeRedEditorComms`](../node-red-editorcomms/README.md) for the runtime data.

The runtime mixin `nodeRedPopup` has no API that you call. It exists to serve the editor script `NodeRedPopupFrontend.js`, so that the `<script>` tag below can load it, also before the first deploy. Add the mixin even though you do not call anything on it:

```js
const { NodeRedNodeBase, nodeRedPopup, nodeRedEditorComms } = require('@nrutils/node-red-utils');

module.exports = NodeRedNodeBase.createNode('popup-demo', [nodeRedPopup, nodeRedEditorComms], (RED, thisNode, config) => {
    let last = null;

    // A new popup asks for the last message
    thisNode.nodeRedEditorComms.subscribe('get-last', () => last);

    thisNode.on('input', (msg, send, done) => {
        last = { payload: msg.payload, time: new Date().toLocaleTimeString() };
        thisNode.nodeRedEditorComms.publish('last', last);     // updates the popup in every open editor
        send(msg);
        done();
    });
});
```

The editor side does the work:

```html
<script type="text/javascript" src="node-red-resourceendpoint/node-red-popup/NodeRedPopupFrontend.js"></script>
<script type="text/javascript" src="node-red-resourceendpoint/node-red-editorcomms/EditorCommsFrontend.js"></script>

<script type="text/javascript">
(function () {
    function show(node, last) {
        const div = document.getElementById('nru_popup.' + node.id + '.div');
        if (!div || !last) return;      // the node is on another tab, or no message yet
        div.textContent = JSON.stringify(last.payload);     // text, never HTML
        document.getElementById('nru_popup.' + node.id + '.statusText').setStatusText(last.time);
    }

    RED.nodes.registerType('popup-demo', {
        category: 'function',
        color: '#d4c4fb',
        defaults: {
            name: { value: '' },
            nru_popupConfig: { value: { width: 200, height: 120, autoCloseTime: 0 } }
        },
        inputs: 1,
        outputs: 1,
        label: function () { return this.name || 'popup-demo'; },

        // Runs each time the editor builds the popup; "this" is the node
        nru_popupInit: function () {
            const node = this;
            node.nodeRedEditorComms.publish('get-last').then((last) => show(node, last)).catch(() => {});
        },
        nodeRedEditorComms_subscriptions: {
            last: function (last) { show(this, last); }
        }
    });
})();
</script>

<script type="text/html" data-template-name="popup-demo">
    <div class="form-row">
        <label for="node-input-name"><i class="fa fa-tag"></i> Name</label>
        <input type="text" id="node-input-name" placeholder="Name">
    </div>
</script>
```

The editor script reads two properties of the node definition. Both names start with `nru_` (for node-red-utils), so they do not collide with Node-RED's own properties or yours:

- `nru_popupConfig` in `defaults`: the size of the popup. Because it is in `defaults`, Node-RED saves it with each node.
- `nru_popupInit`: a function that the script calls after it has made the popup elements, with `this` set to the editor node. Fill the popup here.

When the editor builds the popup, it asks the runtime for the last message. After that, the runtime pushes each new message to the popup. A node that is not deployed answers 404, and the popup stays empty. Runtime data shown in the popup must be set with `textContent` or jQuery `.text()`, never with `innerHTML`: a message payload can hold HTML that would run as script in the editor.

## Configuration

A node gets a popup only if `defaults` has `nru_popupConfig`:

- `width`: pixels, for the full popup. The minimum is 100; a smaller value gives 100.
- `height`: pixels, for the full popup, with the 20 px status bar. The minimum is 50; a smaller value gives 50.
- `autoCloseTime`: milliseconds until the popup hides itself. `0` keeps it open.
- `x`, `y`: optional. The position of the popup's top left corner, in pixels from the top left corner of the node. Negative numbers are allowed. The default is `0` and `50`: under the node.

The content area (`nru_popup.<nodeId>.div`) is 12 px narrower and 32 px lower than the popup. A resize by the user cannot go below 100 x 50 either.

`width`, `height` and `autoCloseTime` must be numbers, 0 or more. `x` and `y` must be numbers. If one is not, the node gets no popup, the editor shows a warning one time for the node type, and the browser console names the bad value.

The user drags the status bar to move a popup, and drags the bottom right corner to resize it. Dots on the status bar show that it moves. A dashed line ties the popup to its node, wherever it is. The new position or size goes into the node's `nru_popupConfig`, so it is saved with the flow. A move or resize follows the zoom of the canvas.

A popup that is open stays open after a browser refresh. The browser keeps the ids of the open popups in its local storage (key `nru_popupOpen`), so this applies to that browser only. A popup with an `autoCloseTime` more than 0 starts closed.

## Elements

Each popup creates elements with these ids:

- `nru_popup.<nodeId>.div`: the content area. Put your elements here.
- `nru_popup.<nodeId>.statusText`: the status line. Call its `setStatusText(text)`; long text is cut to fit.

## Behavior

- The popup follows the editor theme (light or dark). The top edge and the dashed line take the `color` of the node type.
- With `prefers-reduced-motion`, the popup opens and closes without animation.
- The popup is rebuilt when you change tabs, add the node, or deploy. `nru_popupInit` runs each time, so make it safe to call again.
- The script draws into the editor's SVG (the node's `<g id="<nodeId>">` and `#red-ui-workspace`). If a future editor changes that structure, the popup can break. It was written for the Node-RED 4.1 editor.

[Back to node-red-utils](../README.md)
