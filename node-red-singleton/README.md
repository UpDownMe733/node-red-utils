# node-red-singleton

EXPERIMENTAL. The API and the behavior can change in a minor release.

Allow only one node of a type in the editor. Useful for a node that owns a device, a port or another resource that two nodes cannot share.

The check runs only in the editor. The runtime does not check, so a flow deployed through the admin API, or a flow file edited by hand, can still hold two nodes. If two nodes would break your node, also check in the runtime, as the example below does.

## Usage

A node that receives sensor data on a fixed UDP port. Two nodes cannot bind the same port, so the editor allows one node, and the runtime checks again:

```js
const dgram = require('dgram');
const { NodeRedNodeBase, nodeRedSingleton } = require('@nrutils/node-red-utils');

const PORT = 41234;     // the sensors send here; only one socket can bind this port
let owner = null;       // id of the node that has the socket

module.exports = NodeRedNodeBase.createNode('udp-sensors', [nodeRedSingleton], (RED, thisNode, config) => {
    // A flow deployed through the admin API skips the editor check, so check here too
    if (owner) {
        thisNode.status({ fill: 'red', shape: 'ring', text: 'not started: one node only' });
        thisNode.error(`Node ${owner} has UDP port ${PORT}. Only one udp-sensors node can run.`);
        return;
    }
    owner = thisNode.id;
    const socket = dgram.createSocket('udp4');
    socket.on('message', (data, rinfo) => thisNode.send({ payload: data.toString(), sender: rinfo.address }));
    socket.on('error', (err) => thisNode.error(err));
    socket.bind(PORT);

    thisNode.on('close', (done) => {
        owner = null;
        socket.close(() => done());
    });
});
```

```html
<script type="text/javascript" src="node-red-resourceendpoint/node-red-singleton/NodeRedSingletonFrontend.js"></script>

<script type="text/javascript">
    RED.nodes.registerType('udp-sensors', {
        category: 'function',
        color: '#ffcccc',
        singleton: true,
        defaults: { name: { value: '' } },
        inputs: 0,
        outputs: 1,
        label: function () { return this.name || 'udp-sensors'; }
    });
</script>

<script type="text/html" data-template-name="udp-sensors">
    <div class="form-row">
        <label for="node-input-name"><i class="fa fa-tag"></i> Name</label>
        <input type="text" id="node-input-name" placeholder="Name">
    </div>
</script>
```

`singleton: true` goes at the top level of the definition, not in `defaults`.

## Behavior

- When one user action adds only a second node of the type (drag from the palette, quick add, paste or import of that one node), the editor shows a warning and undoes that action. Thus the new node goes away with its links, and the changed state of the workspace is as before. Redo adds it again, and the check undoes it again.
- When an import or paste adds a second node together with other nodes, the editor does not delete anything. It shows a warning that asks you to delete the extra nodes. The same warning shows when the editor loads saved flows that have two or more nodes of the type.
- The limit covers the whole editor: all flow tabs, not one tab.
- When you delete the existing node, you can add a new one.

[Back to node-red-utils](../README.md)
