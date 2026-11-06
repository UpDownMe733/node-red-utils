# Examples

Seven small examples, one per feature, and one bigger example. They all appear in the palette category "node-red-utils examples".

- `simple-node`: the smallest node built with `NodeRedNodeBase`. It wraps `msg.payload` with a timestamp.
- `editor-comms`: counts messages and sends the count to the editor with `nodeRedEditorComms`. The node button asks the runtime for the total.
- `worker`: runs a CPU-heavy loop in a worker thread with `nodeRedWorker`. Each message is a `request()` to the worker. Several messages can be in the worker at the same time; each result goes out on its original `msg`.
- `popup`: shows the last message in a popup on the node (`nodeRedPopup` plus `nodeRedEditorComms`). Click the node to open it.
- `singleton`: a node type that `nodeRedSingleton` limits to one instance in the editor.
- `worker-editor` (the bigger example): a rate meter. A worker thread counts messages per second over 5 seconds. The node status shows the rate, the edit dialog shows it live with `nodeRedEditorComms`, and a Reset button in the dialog asks the runtime, which asks the worker with `request()`, and shows the total before the reset. If the node is not deployed yet, the button shows a warning.
- `pubsub`: two nodes that share a reading over the pub/sub bus with `nodeRedPubsubBus`. `sensor-sim` makes a random reading every 500 ms in a worker thread and offers it as a producer. `sensor-view` picks a running sensor from a dropdown, shows its latest reading in the status and adds it to each message as `msg.reading`. If the sensor stops, it shows "no sensor".
- `resourceendpoint`: serves the fixed `public/` folder of its own package with `nodeRedResourceEndpoint`, from when Node-RED loads the node (no deploy needed). Open `node-red-resourceendpoint/resourceendpoint-node/hello.txt` under the editor URL to see it.

## Install one

Clone the repository, then install the example into your Node-RED user directory:

```bash
cd ~/.node-red
npm install --install-links /path/to/node-red-utils/examples/basic-examples/<name>
```

Restart Node-RED. `--install-links` copies the example into `~/.node-red/node_modules` instead of linking it. Each example depends on the published `@nrutils/node-red-utils` package, which npm installs next to it.

To remove one, run `npm uninstall` with the `name` from the example's `package.json`, for example `npm uninstall node-red-utils-example-simple-node`.

[Back to node-red-utils](../README.md)
