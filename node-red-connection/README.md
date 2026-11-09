# node-red-connection

Open, close and reconnect one client connection for a node: a TCP socket, an MQTT client, a Modbus or OPC UA session. You give two functions, `open` and `close`. The mixin decides when to call them.

The connection is open while at least one node holds it. The first `acquire()` connects. When the last holder closes, the mixin disconnects after the deploy. When the client drops, the mixin waits and connects again.

## Why you need it

Each Node-RED client node writes its own connection code. The core nodes of Node-RED 5.0.9 show the size of this work:

- `10-mqtt.js`: `register` and `deregister` of the user nodes on the broker config node (22 lines), `connect` and `disconnect` with the `connected`, `connecting` and `closing` flags (159 lines, part of it MQTT work), and a status update for all user nodes (44 lines).
- `31-tcpin.js`: two copies of a `setupTcpClient` function with its own reconnect timer, one in the TCP in node (90 lines) and one in the TCP out node (47 lines).

This hand-written code has the same faults again and again:

| Fault in hand-written code | What the mixin does |
| --- | --- |
| A new reconnect timer starts before the old one is cleared. Two connects run. | The mixin has one timer. Only the current attempt can set it, and a disconnect clears it. |
| A late `close` or `error` event from a dead client marks the new client as connected, or stops it. | Each attempt has a generation number. The mixin ignores `lost()` and `open()` results from an old attempt. |
| The node closes during a connect. The socket connects later and stays open. | A client that arrives after the release goes to `close()` at once. The close of the node waits for it. |
| Two connects run at one time. This breaks a serial port or an MQTT broker with a fixed client id. | Only one `open()` runs at a time. The old client goes through `close()` before the next `open()`. |
| A deploy restarts the only user node. The shared connection closes and opens again. | The mixin keeps the connection while a restarted node comes back. See [Restart of a user node](#restart-of-a-user-node). |
| A user node adds a status listener on each deploy. The listeners pile up. | `acquire(node, onState)` removes `onState` when the node closes. |
| An `open()` or `close()` never finishes. The deploy waits for the close timeout of Node-RED. | The mixin waits 10 s at most, then logs a warning and goes on. |
| The `connected`, `connecting` and `closing` flags, and the `register`/`deregister` count of user nodes, do not agree with the client. | The mixin keeps the state and the holders. `acquire()` replaces `register` and `deregister`; you write no flags. |

## Usage

A TCP client in two node types. The config node `tcp-client` owns the connection. Each `tcp-send` node holds it, shows its state as the node status, and writes each `msg.payload` as one line to the socket.

`tcp.js`:

```js
const net = require('net');
const { NodeRedNodeBase, nodeRedConnection } = require('@nrutils/node-red-utils');

const looks = {
    idle:       { fill: 'grey',   shape: 'ring', text: 'idle' },
    connecting: { fill: 'yellow', shape: 'ring', text: 'connecting' },
    ready:      { fill: 'green',  shape: 'dot',  text: 'connected' },
    failed:     { fill: 'red',    shape: 'ring', text: 'failed' },
    closing:    { fill: 'grey',   shape: 'ring', text: 'closing' }
};

// Config node: owns the socket. It connects only while a tcp-send node holds it.
const tcpClient = NodeRedNodeBase.createNode('tcp-client', [nodeRedConnection], (RED, thisNode, config) => {
    thisNode.conn = thisNode.nodeRedConnection.manage({
        open: (lost) => new Promise((resolve, reject) => {
            const socket = net.connect(Number(config.port), config.host);
            socket.once('connect', () => resolve(socket));
            socket.on('error', (err) => {
                socket.destroy();   // close() does not get a socket that failed to connect
                reject(err);        // before 'connect': the attempt fails
                lost(err);          // after 'connect': the client dropped
            });
            socket.on('close', () => lost(new Error('connection closed')));
        }),
        close: (socket) => { socket.destroy(); }
    });
});

// User node: holds the connection and writes msg.payload as one line
const tcpSend = NodeRedNodeBase.createNode('tcp-send', [], (RED, thisNode, config) => {
    const client = RED.nodes.getNode(config.client);
    if (!client) {
        thisNode.status({ fill: 'red', shape: 'ring', text: 'no tcp-client' });
        return;
    }
    const conn = client.conn;
    conn.acquire(thisNode, (state, err) => {
        thisNode.status({ ...looks[state], text: looks[state].text + (err ? ': ' + err.message : '') });
    });

    thisNode.on('input', async (msg, send, done) => {
        try {
            const socket = await conn.ready({ timeout: 5000 });
            socket.write(String(msg.payload) + '\n');
            done();
        } catch (err) {
            done(err);
        }
    });
});

module.exports = function (RED) {
    tcpClient(RED);
    tcpSend(RED);
};
```

`tcp.html`:

```html
<script type="text/javascript">
    RED.nodes.registerType('tcp-client', {
        category: 'config',
        defaults: {
            host: { value: '127.0.0.1', required: true },
            port: { value: 7000, required: true, validate: RED.validators.number() }
        },
        label: function () { return this.host + ':' + this.port; }
    });

    RED.nodes.registerType('tcp-send', {
        category: 'network',
        color: '#c0c0c0',
        defaults: {
            name: { value: '' },
            client: { value: '', type: 'tcp-client', required: true }
        },
        inputs: 1,
        outputs: 0,
        icon: 'bridge.svg',
        label: function () { return this.name || 'tcp-send'; }
    });
</script>

<script type="text/html" data-template-name="tcp-client">
    <div class="form-row">
        <label for="node-config-input-host"><i class="fa fa-globe"></i> Host</label>
        <input type="text" id="node-config-input-host">
    </div>
    <div class="form-row">
        <label for="node-config-input-port"><i class="fa fa-random"></i> Port</label>
        <input type="text" id="node-config-input-port">
    </div>
</script>

<script type="text/html" data-template-name="tcp-send">
    <div class="form-row">
        <label for="node-input-client"><i class="fa fa-plug"></i> Client</label>
        <input type="text" id="node-input-client">
    </div>
    <div class="form-row">
        <label for="node-input-name"><i class="fa fa-tag"></i> Name</label>
        <input type="text" id="node-input-name" placeholder="Name">
    </div>
</script>
```

In `package.json`, set `"node-red": { "nodes": { "tcp": "tcp.js" } }`.

For a plain node without a config node, the node holds its own connection: `thisNode.nodeRedConnection.manage({ ... }).acquire(thisNode)`.

## Patterns

### Drop a message when there is no connection

`conn.client` is the client in the state `ready`, else `undefined`:

```js
thisNode.on('input', (msg, send, done) => {
    const socket = conn.client;
    if (socket) socket.write(String(msg.payload) + '\n');    // no connection: drop the message
    done();
});
```

### Set up each new client

Each reconnect gives a new client. Set it up in the `onState` function of `acquire`. For example, send the data that each new socket receives:

```js
conn.acquire(thisNode, (state) => {
    if (state === 'ready') conn.client.on('data', (data) => thisNode.send({ payload: data }));
});
```

## States

- `idle`: no node holds the connection. There is no client.
- `connecting`: `open()` runs. The first `acquire()` starts it, and each retry starts it again.
- `ready`: `open()` gave the client. `ready()` resolves with it, and `conn.client` is the client.
- `failed`: the attempt failed, or the client called `lost()`. The mixin closes the client, waits the backoff delay, and goes to `connecting`.
- `closing`: the mixin released the last holder, or the owner node closed. The mixin closes the client, then goes to `idle`. If a node acquires the connection during `closing`, the mixin connects again after `idle`.

### One open() at a time, 10 s at most

The mixin starts `open()` only when no other `open()` and no `close()` runs. When the last holder is released during `connecting`, the state stays `closing` until that `open()` finishes and its client goes through `close()`. The close of the owner node waits for this too. The mixin waits 10 s at most for an `open()` or a `close()` that does not finish. Then it logs a warning on the owner node and goes on: to `idle`, and to `connecting` again if a node holds the connection. A client that arrives later still goes to `close()`.

### Restart of a user node

A deploy of modified nodes or modified flows can restart a user node and keep its config node. The restarted node has the same id and acquires the connection again. So the mixin does not release a holder when it closes. It waits for the next `flows:started` event of Node-RED:

- If a node with the same id acquired the connection again, the connection stays open.
- If not, the mixin releases the holder. When no holder is left, it disconnects. Thus a node that the deploy removed, or that moved to another config node, leaves no open connection.

The close of the owner node closes the connection at once.

## API

`thisNode.nodeRedConnection.manage(options)` returns the connection `conn`. Call it in the setup function. Each call gives a separate connection. When this node closes, the mixin stops the retry timer of each connection, closes the clients, and waits for `close()` before the close of the node completes.

| Call | What it does |
| --- | --- |
| `options.open(lost)` | Your function. It returns the client, or a Promise for it. A throw or a rejected Promise is a failed attempt. A client that fails to connect does not go to `close()`; destroy it in `open()`. Call `lost(err)` on each event that tells of a drop, for example the socket `close` and `error` events. Some clients send `error` and no `close`. `lost()` belongs to one attempt; the mixin ignores a call from an older attempt, and more calls from the same attempt. |
| `options.close(client)` | Your function. It closes the client, sync or async. The mixin calls it one time for each client that `open()` gave. A client that arrives after a release or a close of the node also goes to `close()`. |
| `options.backoff` | Optional. Default `{ min: 1000, max: 30000 }`. The delay before a retry, in milliseconds, starts at `min` and doubles after each failed attempt, up to `max`. It goes back to `min` after `ready` and after `idle`. Each delay is a random value from half the delay to the full delay. |
| `conn.acquire(node, [onState])` | Holds the connection open for `node`. The mixin releases it after `node` closes; see [Restart of a user node](#restart-of-a-user-node). A second call for the same node does nothing. Throws after the owner node closed. `onState(state, err)` is optional. The mixin calls it at once with the current state, then at each change, and removes it when `node` closes. If it throws, the owner node logs the error. |
| `conn.ready({ timeout })` | A Promise for the client. It resolves at once in the state `ready`, or when the state becomes `ready`. It rejects after `timeout` milliseconds (default: no timeout), and when the owner node closes. The close of a user node does not cancel its pending calls, so always give a `timeout` in an input handler. |
| `conn.client` | The client in the state `ready`, else `undefined`. |

[Back to node-red-utils](../README.md)
