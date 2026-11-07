# AI prompts: build nodes with node-red-utils

Prompts to paste into an AI coding assistant (Claude Code, Copilot, Cursor). Each prompt builds one custom node, or a small set of nodes, with the mixins in this library. Use them as they are, or change the details.

The ideas came from five points of view: a high-school robotics mentor, a business workflow developer, a home-automation maker, an industrial IoT engineer and a Node-RED educator. Pick the ones that match your use.

## How to use a prompt

1. Paste the **lead-in** below first. It tells the assistant where the API is documented.
2. Paste one prompt from the list.
3. Install the result with `npm install --install-links <path>` in `~/.node-red` and restart Node-RED.

Lead-in:

```text
I build a Node-RED custom node with the npm package @nrutils/node-red-utils.
Before you write code, read the README of each mixin I name:
node_modules/@nrutils/node-red-utils/<mixin-folder>/README.md
(node-red-base, node-red-worker, node-red-gpu, node-red-editorcomms,
node-red-pubsub-bus, node-red-resourceendpoint, node-red-popup, node-red-singleton).
Use only API names that appear in those READMEs. Use textContent, never innerHTML,
for runtime data in the editor. Add a package.json with a "node-red" section.
```

Every popup prompt expects the three `<script src="node-red-resourceendpoint/...">` lines from the popup and editorcomms READMEs. Every worker prompt expects a worker file that exports `function (worker, data)`.

---

## Robotics competition (FRC / FTC pit)

### Match clock

Mixins: `nodeRedSingleton`, `nodeRedPopup`, `nodeRedEditorComms`, `nodeRedPubsubBus`

One pit has one clock. The popup shows the countdown on the canvas. The bus offers the phase to other nodes without wires.

```text
Build a Node-RED node "match-clock".
Use NodeRedNodeBase.createNode('match-clock', [nodeRedSingleton, nodeRedPopup, nodeRedEditorComms, nodeRedPubsubBus], setup).
Keep a 150 s FRC clock. Phases: auto 15 s, teleop, endgame in the last 30 s.
Register a bus producer with one entry "phase" of type "frc/phase_v1". Call notifyChange at each phase change.
Every second call nodeRedEditorComms.publish('tick', { left, phase }).
Subscribe to 'start', 'stop' and 'get-state' for the popup buttons.
Set nru_popupConfig { width: 260, height: 120, autoCloseTime: 0 } and draw a big timer in nru_popupInit.
Add a node button that starts the clock. Show "Deploy first" on a 404.
```

### Pit sensor wall

Mixins: `nodeRedWorker`, `nodeRedPubsubBus`, `nodeRedEditorComms`, `nodeRedPopup`

A worker reads battery, arm current and motor temperature off the event loop. Many viewer nodes pick one sensor from a dropdown. The popup shows live gauges.

```text
Build two nodes.
"robot-sensor": createNode with [nodeRedWorker, nodeRedPubsubBus]. Call nodeRedWorker.init(path.join(__dirname,'sensor-worker.js'), { id: thisNode.id }) and then nodeRedPubsubBus.attachWorker(worker).
In the worker, use the pubsub workerproxy to register a producer with entry "reading" of type "robot/reading_v1". Sample every 200 ms and call notifyChange.
"sensor-wall": createNode with [nodeRedPopup, nodeRedEditorComms, nodeRedPubsubBus].
Fill the producer dropdown from GET node-red-pubsub-bus/producers, filtered by type.
On each bus 'change' event call bus.getMetadata and nodeRedEditorComms.publish('reading', value). Show "no sensor" on 'disconnect'.
Draw gauges in nru_popupInit. Turn a gauge red above a limit set in the edit dialog.
```

### Cone spotter (GPU colour threshold)

Mixins: `nodeRedWorker`, `nodeRedGpu`, `nodeRedEditorComms`

Camera frames are big. The GPU kernel does the hue test on the Pi 5, with a CPU fallback. Sliders in the editor change the colour range live.

```text
Build a Node-RED node "cone-spotter".
Use createNode('cone-spotter', [nodeRedWorker, nodeRedGpu, nodeRedEditorComms], setup).
Start the worker with nodeRedWorker.init(path.join(__dirname,'spot-worker.js'), { hueLo, hueHi }).
Input msg.payload is { width, height, rgba } (Uint8Array). Call worker.request('spot', frame, [rgba.buffer], { timeout: 2000 }).
In the worker call nodeRedGpuWorker() from '@nrutils/node-red-utils/node-red-gpu'. Register one kernel with gpu.registerJsKernel for the hue test, use gpu.createBuffer for input and mask, run with gpu.dispatchChain, release buffers in finally, and call gpu.close() on 'close'.
Return { cx, cy, area } as msg.payload.
Use nodeRedEditorComms.subscribe('set-range') to update the hue range, and publish('preview', smallMask) to the edit dialog.
```

### Practice replay deck

Mixins: `nodeRedWorker`, `nodeRedEditorComms`, `nodeRedPopup`, `nodeRedPubsubBus`

A worker records driver-station samples in a ring buffer and plays them back on time. The popup is a small player with play, pause and scrub.

```text
Build "replay-deck".
Use createNode('replay-deck', [nodeRedWorker, nodeRedEditorComms, nodeRedPopup, nodeRedPubsubBus], setup).
Start the worker with nodeRedWorker.init(path.join(__dirname,'replay-worker.js'), { seconds: 180 }).
On input call worker.publish('sample', msg.payload) to record.
In the worker, play back with setInterval and call worker.parentPorts.publish('frame', sample).
In setup: worker.subscribe('frame', f => { thisNode.send({ payload: f }); nodeRedEditorComms.publish('frame', f); }).
Subscribe to 'play', 'pause' and 'seek' from the popup; 'seek' calls worker.request('seek', t).
Register a bus producer entry "position" of type "frc/replay_v1" so a "ghost" node can follow it.
Draw the player in nru_popupInit. Handle 'close' in the worker.
```

---

## Business workflows

### Flow spy (message spy between worker nodes)

Mixins: `nodeRedWorker`, `nodeRedPopup`, `nodeRedEditorComms`, `nodeRedPubsubBus`

Worker nodes pass messages thread to thread, so Debug cannot see them. The spy sits on the wire, counts in its own thread, and shows rate and latency per wire in a popup.

```text
Build a Node-RED node "flow-spy". It sits on a wire between two worker nodes and passes every message through unchanged.
Use createNode('flow-spy', [nodeRedWorker, nodeRedPopup, nodeRedEditorComms, nodeRedPubsubBus], setup).
Call nodeRedWorker.init(path.join(__dirname,'spy-worker.js'), { sampleMs: 500 }).
In the worker, worker.inputPorts.subscribe('default', (data, senderTrace) => ...) counts messages and bytes per senderTrace.nodeId, then forwards with worker.outputPorts.publish('default', data). Do not clone payloads. Do not use a transferList.
Keep a rolling 1 s window. Every 500 ms call worker.parentPorts.publish('stats', { perSec, bytesPerSec, p95Ms, byWire }).
Main thread: worker.subscribe('stats', s => { nodeRedEditorComms.publish('stats', s); bus.notifyChange(thisNode.id, 'stats'); }). Register a bus producer with entry "stats" of type "nru/wirestats_v1".
Add nodeRedEditorComms.subscribe('get-stats', () => last) for a new popup.
nru_popupConfig { width: 360, height: 180, autoCloseTime: 0 }. In nru_popupInit draw msgs/s and p95 latency per wire on a canvas. Show the rate in thisNode.status.
```

### Rate governor (shared API rate limit)

Mixins: `nodeRedSingleton`, `nodeRedPubsubBus`, `nodeRedEditorComms`

An ERP or CRM API has one rate limit for the whole company. One governor owns the token bucket. Other nodes ask for tokens over the bus.

```text
Build a Node-RED node "rate-governor".
Use createNode('rate-governor', [nodeRedSingleton, nodeRedPubsubBus, nodeRedEditorComms], setup). Add the module-level owner check from the singleton README.
Config: apiName, tokensPerMinute, burst.
Register a bus producer with entry "bucket" of type "nru/ratelimit_v1". getMetadata returns { tokens, queued, nextRefillMs }. Call notifyChange on every refill and grant.
Also build a client node "rate-wait": it picks a governor from a dropdown filled by GET node-red-pubsub-bus/producers, subscribes to `${id}/bucket`, holds each msg until a token is free, then sends it. First in, first out.
Use nodeRedEditorComms.publish('bucket', state) for a live bar in the governor's edit dialog.
Clear timers and the owner id in the 'close' handler.
```

### Doc crunch (CSV / PDF parse off the event loop)

Mixins: `nodeRedWorker`, `nodeRedEditorComms`, `nodeRedResourceEndpoint`

Parsing a big file blocks every flow. A worker keeps Node-RED fast. The edit dialog shows progress and bad rows.

```text
Build a Node-RED node "doc-crunch".
Use createNode('doc-crunch', [nodeRedWorker, nodeRedEditorComms, nodeRedResourceEndpoint], setup, { resources: [path.join(__dirname,'public')] }).
Call nodeRedWorker.init(path.join(__dirname,'crunch-worker.js'), { delimiter: config.delimiter }).
On 'input' call worker.request('parse', { path: msg.payload.file, kind: msg.payload.kind }, [], { timeout: 600000 }). Set msg.payload to the rows, send, done. On rejection call done(err).
In the worker use worker.handle('parse', fn). Stream the file. Every 500 rows call worker.parentPorts.publish('progress', { done, total, badRows }).
Main thread: worker.subscribe('progress', p => nodeRedEditorComms.publish('progress', p)). Show "42%" in thisNode.status.
The edit dialog draws a progress bar and a bad-row list from public/progress.js, loaded from node-red-resourceendpoint/doc-crunch/progress.js.
```

### Approval inbox

Mixins: `nodeRedSingleton`, `nodeRedPopup`, `nodeRedEditorComms`, `nodeRedPubsubBus`

One inbox holds invoices and refunds until a person decides. The popup is the inbox panel on the canvas.

```text
Build a Node-RED node "approval-inbox" with 2 outputs: approved and rejected.
Use createNode('approval-inbox', [nodeRedSingleton, nodeRedPopup, nodeRedEditorComms, nodeRedPubsubBus], setup). Add the owner check from the singleton README.
On 'input' store { id: msg._msgid, msg, amount: msg.amount, who: msg.who, at: Date.now() } in a Map and in node context. Do not call done() until a decision is made.
Call nodeRedEditorComms.publish('pending', list) on each change. Set thisNode.status to "N waiting".
Subscribe to 'list' (returns the list) and 'decide' ({ id, ok, note }): send the held msg on output 0 or 1 with msg.approval = { note, at }, then call done().
Register a bus producer with entry "pending" (the count). Call notifyChange on change.
nru_popupConfig { width: 420, height: 260, autoCloseTime: 0 }. In nru_popupInit draw a table with Approve and Reject buttons.
```

### Dead-letter queue

Mixins: `nodeRedPubsubBus`, `nodeRedWorker`, `nodeRedEditorComms`, `nodeRedPopup`

Failed jobs are not lost. The node collects failure events over the bus, a worker keeps them on disk and retries with backoff, and the popup lets a person replay or drop them.

```text
Build a Node-RED node "dead-letter-queue".
Use createNode('dead-letter-queue', [nodeRedPubsubBus, nodeRedWorker, nodeRedEditorComms, nodeRedPopup], setup).
In setup loop over bus.listProducers() and use bus.onProducerRegistered. Subscribe to `${producerId}/errors` for every producer that has an entry "errors". On each event call bus.getMetadata and then worker.request('enqueue', item).
Also accept failed msgs on the input wire (from a Catch node).
Call nodeRedWorker.init(path.join(__dirname,'dlq-worker.js'), { file: config.file, maxRetries: config.retries }).
Worker: handle 'enqueue', 'list', 'retry' and 'drop'. Store JSON lines on disk. Exponential backoff. When a retry is due, call worker.parentPorts.publish('due', item); the main thread sends it.
Subscribe to 'list', 'replay' and 'drop' from the popup. Publish 'changed' with the counts and show them in the status.
In nru_popupInit draw a table with Replay and Drop buttons.
```

---

## Home automation and makers

### Pi motion cam

Mixins: `nodeRedWorker`, `nodeRedGpu`, `nodeRedEditorComms`, `nodeRedPopup`

Frame differencing on the GPU, a live thumbnail with motion boxes in a popup.

```text
Build a Node-RED node "pi-motion-cam".
Use createNode('pi-motion-cam', [nodeRedWorker, nodeRedGpu, nodeRedEditorComms, nodeRedPopup], setup).
Input msg.payload is { width, height, gray } with one byte per pixel (Uint8Array).
Call nodeRedWorker.init(path.join(__dirname,'motion-worker.js')). On input call worker.request('diff', frame, [gray.buffer], { timeout: 2000 }).
In the worker use nodeRedGpuWorker(). Register two kernels with gpu.registerJsKernel: abs-diff against the last frame, then threshold. Run them in one gpu.dispatchChain. Reuse buffers with createBuffer and releaseBuffer. Call gpu.close() on 'close'.
The handler returns { score, box, thumb } where thumb is a 64x48 gray Uint8Array.
Send msg only when score > config.threshold. Set the status to the score.
Call nodeRedEditorComms.publish('thumb', { thumb, box }) and subscribe to 'get-last'.
nru_popupConfig { width: 256, height: 192, autoCloseTime: 0 }. In nru_popupInit draw the thumb and box on a canvas.
```

### LED strip designer

Mixins: `nodeRedEditorComms`, `nodeRedPopup`, `nodeRedWorker`

Paint a pattern in a popup. A worker renders effects at a steady frame rate and sends pixel arrays out the wire.

```text
Build a Node-RED node "led-designer".
Use createNode('led-designer', [nodeRedWorker, nodeRedEditorComms, nodeRedPopup], setup).
Call nodeRedWorker.init(path.join(__dirname,'render-worker.js'), { leds: config.leds, fps: 30 }).
Popup: nru_popupConfig { width: 400, height: 120, autoCloseTime: 0 }. In nru_popupInit draw one cell per LED with a colour picker and an effect dropdown (static, fade, chase, rainbow). Each change calls node.nodeRedEditorComms.publish('set-pattern', pattern).
Runtime: nodeRedEditorComms.subscribe('set-pattern', p => worker.request('load', p)).
Worker: a timer at fps. Each tick calls worker.parentPorts.publish('frame', rgb) with a Uint8Array of 3 bytes per LED.
Main thread: worker.subscribe('frame', f => { thisNode.send({ payload: Buffer.from(f) }); nodeRedEditorComms.publish('preview', f); }).
The popup animates the strip from the 'preview' events.
```

### Sensor sparkline hub

Mixins: `nodeRedPubsubBus`, `nodeRedEditorComms`, `nodeRedPopup`

Many sensor nodes produce readings. The hub subscribes over the bus with no wires and draws a live sparkline for each.

```text
Build a Node-RED node "sensor-sparkline".
Use createNode('sensor-sparkline', [nodeRedPubsubBus, nodeRedEditorComms, nodeRedPopup], setup).
The edit dialog fills a multi-select from GET node-red-pubsub-bus/producers. Keep entries of type "acme/reading_v1" (match the pubsub example's sensor-sim). Store the ids in config.producers.
Runtime: for each id, bus.subscribe(`${id}/latest`, ev => ...). Skip 'disconnect' and show "no sensor". Pull the value with bus.getMetadata(ev.producerId, ev.desc). Keep a ring buffer of 120 points per sensor.
Call nodeRedEditorComms.publish('point', { id, value }) per event. Subscribe to 'history' and return all buffers.
nru_popupConfig { width: 360, height: 200, autoCloseTime: 0 }. In nru_popupInit request 'history' and draw one SVG polyline per sensor with min and max labels. Use setStatusText for the latest value.
Also send each reading as msg.payload with msg.topic = producer id.
```

### Audio spectrum painter

Mixins: `nodeRedWorker`, `nodeRedGpu`, `nodeRedEditorComms`, `nodeRedPopup`

A spectrum of 16-bit PCM audio on the GPU, drawn as 32 bars in a popup.

```text
Build a Node-RED node "audio-spectrum".
Use createNode('audio-spectrum', [nodeRedWorker, nodeRedGpu, nodeRedEditorComms, nodeRedPopup], setup).
Input msg.payload is a Buffer of 16-bit PCM samples, 1024 per chunk.
Call nodeRedWorker.init(path.join(__dirname,'fft-worker.js')). Send each chunk with worker.request('fft', samples, [samples.buffer], { timeout: 1000 }).
In the worker use nodeRedGpuWorker(). Register kernels with registerJsKernel for a Hann window and DFT magnitude, buffers with dtype 'f32', constants { n: 'u32' }. Run with gpu.dispatchChain. Reuse buffers. Call gpu.close() on 'close'.
Return 32 band values (log spaced). Send them as msg.payload and call nodeRedEditorComms.publish('bands', bands).
nru_popupConfig { width: 320, height: 160, autoCloseTime: 0 }. In nru_popupInit draw 32 coloured bars on a canvas.
```

### Home broker (in-process topic hub)

Mixins: `nodeRedSingleton`, `nodeRedPubsubBus`, `nodeRedEditorComms`, `nodeRedPopup`

One node owns a retained topic tree. Any node reads or writes a topic over the bus with no wires. The popup lists live topics.

```text
Build a Node-RED node "home-broker".
Use createNode('home-broker', [nodeRedSingleton, nodeRedPubsubBus, nodeRedEditorComms, nodeRedPopup], setup). Set singleton: true in the HTML and add the owner check from the singleton README.
Input msg.topic and msg.payload become a retained value. Register one bus producer with one entry per topic (type "home/topic_v1"); getEntries returns the current topic list. Call notifyChange(thisNode.id, topic) on each write.
Also build "home-topic-in": picks a broker and a topic from dropdowns, subscribes to `${brokerId}/${topic}`, and sends a msg on each change with the value from getMetadata.
Call nodeRedEditorComms.publish('topics', [{ topic, value, count, age }]) once per second while a popup is open.
nru_popupConfig { width: 400, height: 240, autoCloseTime: 0 }. In nru_popupInit draw a table of topic, last value, count.
```

---

## Industrial IoT edge gateway

### Modbus poll chain (streaming worker nodes)

Mixins: `nodeRedWorker`, `nodeRedResourceEndpoint`, `nodeRedPubsubBus`

Three wired worker nodes: poll, scale, deadband. Samples move thread to thread. The event loop does no work per sample.

```text
Build three Node-RED nodes: "modbus-poller", "tag-scale" and "deadband". Each uses [nodeRedWorker]. The poller also uses [nodeRedResourceEndpoint, nodeRedPubsubBus] with resources: [path.join(__dirname,'editor')].
Poller: nodeRedWorker.init(workerFile, { host, port, unitId, map, periodMs }). The worker uses modbus-serial, polls on a timer and calls worker.outputPorts.publish('sample', { tag, value, ts }). Do not use a transferList. On a read error set a red status through worker.parentPorts.publish('status', ...); do not crash the worker.
Poller worker also uses the pubsub workerproxy: registerProducer(data.id, ...) with entry "tags" of type "plant/tags_v1", notifyChange on change. Main thread calls nodeRedPubsubBus.attachWorker(worker).
tag-scale: worker.inputPorts.subscribe('sample', ...), apply config.scale and config.offset, then worker.outputPorts.publish('sample', ...).
deadband: forward only values that change by more than config.limit. Report a drop count with worker.parentPorts.publish('stats', ...), shown in the status.
Poller dialog: $.getJSON('node-red-resourceendpoint/modbus-poller/devices.json') fills a device-model dropdown that sets the register map.
```

### Alarm manager (ISA-18.2 states)

Mixins: `nodeRedSingleton`, `nodeRedPubsubBus`, `nodeRedEditorComms`, `nodeRedPopup`

One alarm state for the whole gateway. Any node reads the active alarms over the bus. The popup shows and acknowledges them.

```text
Build "alarm-manager" and "alarm-list" nodes.
Manager: createNode('alarm-manager', [nodeRedSingleton, nodeRedPubsubBus, nodeRedEditorComms, nodeRedPopup], setup). Set singleton: true in the HTML and add the owner check from the singleton README.
Input msg.alarm = { tag, limit, state } where state is "active" or "normal". Run the ISA-18.2 states: active unacked, active acked, returned unacked, normal.
Register a bus producer with entry "active" of type "plant/alarms_v1". Call notifyChange on each state change.
Subscribe to 'ack' ({ tag }) from the popup. Check the payload as user input.
nru_popupConfig { width: 420, height: 260, autoCloseTime: 0 }. In nru_popupInit draw the alarm table with an Ack button per row. Show the active count in the status.
alarm-list: a consumer. Dropdown from GET node-red-pubsub-bus/producers, subscribe to `${id}/active`, send a msg on each change with the list from getMetadata. Show "no manager" on 'disconnect'.
```

### Vibration FFT on the GPU

Mixins: `nodeRedWorker`, `nodeRedGpu`, `nodeRedEditorComms`

High-rate accelerometer blocks go to the GPU in a worker. The edit dialog shows the live spectrum and peaks.

```text
Build a Node-RED node "vibration-fft".
Use createNode('vibration-fft', [nodeRedWorker, nodeRedGpu, nodeRedEditorComms], setup).
Call nodeRedWorker.init(path.join(__dirname,'fft-worker.js'), { size: config.size }).
Worker: const gpu = nodeRedGpuWorker(). Register a Hann window kernel and a radix-2 butterfly kernel with gpu.registerJsKernel (for loops only). Run all stages in one gpu.dispatchChain. Use createBuffer and releaseBuffer in a finally block.
worker.handle('fft', ({ samples, rate }, transferList) => ...). Push the output ArrayBuffer to transferList.
Node: msg.payload is a Float32Array block. Call worker.request('fft', { samples, rate }, [samples.buffer], { timeout: 2000 }). Send { peaks: top 5 [hz, mag], rms } as msg.payload. On rejection call done(err).
Once per second call nodeRedEditorComms.publish('spectrum', bins). Subscribe to 'last' for a new dialog. Draw the spectrum on a canvas in oneditprepare.
On 'close' call gpu.close().
```

### Store-and-forward queue

Mixins: `nodeRedWorker`, `nodeRedPopup`, `nodeRedEditorComms`, `nodeRedPubsubBus`

Disk writes and retry timers run in a worker. The popup shows the backlog while the cloud link is down. A health node reads the depth over the bus.

```text
Build a Node-RED node "store-forward".
Use createNode('store-forward', [nodeRedWorker, nodeRedPopup, nodeRedEditorComms, nodeRedPubsubBus], setup).
Call nodeRedWorker.init(path.join(__dirname,'queue-worker.js'), { dir: config.dir, maxBytes: config.maxBytes }) and nodeRedPubsubBus.attachWorker(worker).
Input: worker.request('enqueue', msg.payload, [], { timeout: 3000 }). On rejection call done(err) (back-pressure when the disk is full).
Worker: append records to segment files on disk. A send loop pops a batch and calls worker.parentPorts.publish('deliver', batch). The node sends the batch on output 1. A msg with msg.ack = batchId on the input calls worker.publish('ack', batchId); a missing ack within config.ackMs puts the batch back.
In the worker use the pubsub workerproxy: register entry "backlog" of type "plant/backlog_v1", notifyChange on change.
Once per second publish { depth, bytes, oldestAgeMs, link } with nodeRedEditorComms. Subscribe to 'purge' from the popup.
nru_popupConfig { width: 320, height: 160, autoCloseTime: 0 }. Draw the numbers and a Purge button in nru_popupInit. Show the depth in the status.
```

---

## Teaching and demos

### Message comet

Mixins: `nodeRedPopup`, `nodeRedEditorComms`

A pass-through node. Each message flies across a small popup as a dot. Dot size follows payload size.

```text
Build a Node-RED node "msg-comet". It passes each msg through unchanged.
Use createNode('msg-comet', [nodeRedPopup, nodeRedEditorComms], setup).
On 'input' call nodeRedEditorComms.publish('msg', { id: msg._msgid, size: JSON.stringify(msg.payload).length, time: Date.now() }), then send(msg) and done().
Subscribe to 'get-recent' and return the last 20 events.
nru_popupConfig { width: 320, height: 140, autoCloseTime: 0 }. In nru_popupInit call publish('get-recent'), then animate one dot per event from left to right on a canvas. Dot radius follows size.
Use setStatusText for "N msg/s".
```

### Thread map

Mixins: `nodeRedSingleton`, `nodeRedPubsubBus`, `nodeRedEditorComms`, `nodeRedPopup`

One map shows every worker thread and its load. Each worker node offers its load as a bus producer, so the map finds them without wires.

```text
Build "thread-map" and a helper file "load-producer.js".
load-producer.js is required inside any worker file. It uses require('@nrutils/node-red-utils/node-red-pubsub-bus-workerproxy'), calls registerProducer(data.id, ...) with entry { name: 'load', type: 'demo/load_v1' }, measures busy percent from event-loop lag, and calls notifyChange once per second. The host node must call nodeRedPubsubBus.attachWorker(worker).
thread-map: createNode('thread-map', [nodeRedSingleton, nodeRedPubsubBus, nodeRedEditorComms, nodeRedPopup], setup). Set singleton: true in the HTML and add the owner check from the singleton README.
Use bus.listProducers() and bus.onProducerRegistered to find producers with entry 'load'. For each one bus.subscribe(`${id}/load`, ...) and pull with getMetadata. Treat 'disconnect' as a stopped thread.
Publish the table with nodeRedEditorComms.publish('threads', rows). Subscribe to 'get-threads'.
nru_popupConfig { width: 360, height: 220, autoCloseTime: 0 }. In nru_popupInit draw one bar per thread, labelled with RED.nodes.node(id).name.
Also change the library's worker example to require load-producer.js, so the map has something to show.
```

### Topic explorer

Mixins: `nodeRedPubsubBus`, `nodeRedEditorComms`, `nodeRedResourceEndpoint`, `nodeRedSingleton`

Shows what pub/sub means. Producers on the left, subscribers on the right, an edge flashes on each event.

```text
Build "topic-explorer".
Use createNode('topic-explorer', [nodeRedPubsubBus, nodeRedEditorComms, nodeRedResourceEndpoint, nodeRedSingleton], setup, { resources: [path.join(__dirname,'editor')] }).
The runtime builds a snapshot from bus.listProducers(), bus.listTopics() and bus.listSubscribers(topic). Use bus.onProducerRegistered and subscribe to each `${producerId}/${entry.name}` topic.
Record each event { producerId, desc, kind, at } where kind is change, connect or disconnect. Call nodeRedEditorComms.publish('event', ev). Subscribe to 'snapshot' and return the graph. Never publish metadata values larger than 200 chars.
In oneditprepare call publish('snapshot'), draw an SVG graph from editor/graph.js (served at node-red-resourceendpoint/topic-explorer/graph.js), and flash an edge for 500 ms on each 'event'.
Show "Deploy first" on err.status === 404.
```

### GPU vs CPU race

Mixins: `nodeRedWorker`, `nodeRedGpu`, `nodeRedEditorComms`, `nodeRedPopup`

The same maths on the GPU and in a JS loop. Two bars race in a popup. The reply names the backend that ran.

```text
Build "gpu-race".
Use createNode('gpu-race', [nodeRedWorker, nodeRedGpu, nodeRedEditorComms, nodeRedPopup], setup).
On input call worker.request('race', { size: Number(msg.payload) || 1e6 }, [], { timeout: 30000 }).
Worker: const { nodeRedGpuWorker } = require('@nrutils/node-red-utils/node-red-gpu'). Register one kernel with gpu.registerJsKernel('scale', { buffers, constants, kernel }) that computes y = a*x + b. Run it with createBuffer and dispatchChain, timed with performance.now(). Then run the same loop on a Float32Array and time it.
After each lane call worker.parentPorts.publish('lap', { lane: 'gpu' | 'cpu', ms }). Return { gpuMs, cpuMs, backend: gpu.stats().backend }. Release buffers in finally, gpu.close() on 'close'.
Node: worker.subscribe('lap', l => nodeRedEditorComms.publish('lap', l)). Send the reply as msg.payload.
nru_popupConfig { width: 320, height: 120, autoCloseTime: 0 }. In nru_popupInit draw two growing bars and the backend name.
```

### Step gate (single-step messages between workers)

Mixins: `nodeRedWorker`, `nodeRedEditorComms`, `nodeRedPopup`

The gate holds messages that move thread to thread. A Step button in the popup releases one at a time.

```text
Build "step-gate".
Use createNode('step-gate', [nodeRedWorker, nodeRedEditorComms, nodeRedPopup], setup).
Worker: worker.inputPorts.subscribe('default', (data, senderTrace) => queue.push({ data, from: senderTrace.nodeId })). After each push call worker.parentPorts.publish('queue', { length, from }).
worker.handle('step', () => { const item = queue.shift(); if (item) worker.outputPorts.publish('default', item.data); return queue.length; }). Add 'step-all'. Do not use a transferList.
Node: nodeRedEditorComms.subscribe('step', () => worker.request('step', null, [], { timeout: 2000 })), same for 'step-all'. worker.subscribe('queue', q => { thisNode.status({ text: q.length + ' waiting' }); nodeRedEditorComms.publish('queue', q); }).
nru_popupConfig { width: 240, height: 200, autoCloseTime: 0 }. In nru_popupInit show the queue as stacked boxes with Step and Step all buttons. Show "Deploy first" on 404.
```

---

## Add your own

Open an issue or a pull request with a new prompt. Keep the shape: mixins, two sentences on why, one fenced prompt under 12 lines that uses only names from the READMEs.

[Back to node-red-utils](../README.md)
