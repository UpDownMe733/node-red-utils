# AI prompts: build nodes with node-red-utils

Prompts to paste into an AI coding assistant (Claude Code, Cursor, Copilot agent). Each prompt describes one custom node, or a small set of nodes, built with the mixins in this library. The assistant reads the mixin READMEs and works out the API calls. Change the details to fit your use.

| # | Prompt | Level | Mixins |
|---|--------|-------|--------|
| 1 | [Message trail: show each message as a dot](#1-message-trail-show-each-message-as-a-dot) | Easy | popup, editorcomms |
| 2 | [Match clock: one countdown for the pit](#2-match-clock-one-countdown-for-the-team-area) | Easy | singleton, popup, editorcomms, pubsub-bus |
| 3 | [Approval inbox: hold messages until a person decides](#3-approval-inbox-hold-messages-until-a-person-decides) | Easy | singleton, popup, editorcomms, pubsub-bus |
| 4 | [Sensor hub: read sensors in a worker, view them anywhere](#4-sensor-hub-read-sensors-in-a-worker-view-them-anywhere) | Medium | worker, pubsub-bus, editorcomms, popup |
| 5 | [File parser: parse CSV in a worker with progress](#5-file-parser-parse-csv-in-a-worker-with-progress) | Medium | worker, editorcomms, resourceendpoint |
| 6 | [Wire monitor: count and step messages between worker nodes](#6-wire-monitor-count-and-step-messages-between-worker-nodes) | Medium | worker, popup, editorcomms |
| 7 | [LED strip designer: paint a pattern, render it in a worker](#7-led-strip-designer-paint-a-pattern-render-it-in-a-worker) | Medium | worker, editorcomms, popup |
| 8 | [Colour spotter: find a colour in camera frames on the GPU](#8-colour-spotter-find-a-colour-in-camera-frames-on-the-gpu) | Hard | worker, gpu, editorcomms |
| 9 | [GPU vs CPU speed test](#9-gpu-vs-cpu-speed-test) | Hard | worker, gpu, editorcomms, popup |
| 10 | [Modbus poll chain: three worker nodes on one wire](#10-modbus-poll-chain-three-worker-nodes-on-one-wire) | Hard | worker, resourceendpoint, pubsub-bus |
| 11 | [Store-and-forward queue: keep messages on disk until the link is up](#11-store-and-forward-queue-keep-messages-on-disk-until-the-link-is-up) | Hard | worker, popup, editorcomms, pubsub-bus |

GPU prompts run on the CPU fallback without a Vulkan GPU. The Vulkan path is tested on a Raspberry Pi 5.

## How to use a prompt

1. Make a folder for the new node package and install the library in it:

   ```sh
   mkdir my-node && cd my-node && npm init -y && npm install @nrutils/node-red-utils
   ```

2. Open your AI coding assistant in that folder. Paste the **lead-in** below, then paste one prompt from the list.
3. Install the package into Node-RED and restart it:

   ```sh
   cd ~/.node-red && npm install /path/to/my-node
   ```

Lead-in:

```text
Build a Node-RED custom node package in this folder with @nrutils/node-red-utils (already installed).
Before you write code, read node_modules/@nrutils/node-red-utils/node-red-base/README.md and the
README.md in the folder of every mixin named in my prompt (node-red-worker, node-red-gpu,
node-red-editorcomms, node-red-pubsub-bus, node-red-resourceendpoint, node-red-popup, node-red-singleton).
First reply: the file list, then every API name you will call with the README line that defines it. Then wait for "go".
Use only names that appear in those READMEs. If a name is not there, ask.
Rules: in the editor use textContent, never innerHTML, for runtime data. Popups do not auto-close.
Show "Deploy first" when an editor request gets HTTP 404. A singleton node sets singleton: true and
does the owner check from its README. A GPU worker releases buffers in finally and closes the GPU on 'close'.
Copy a Buffer into a new typed array before you transfer it. A worker that forwards messages keeps the message type.
Output: the node .js and .html, worker files, package.json with a "node-red" section, and one test flow JSON.
```

If your assistant cannot read files, paste the named READMEs after the lead-in.

---

## 1. Message trail: show each message as a dot

Mixins: `nodeRedPopup`, `nodeRedEditorComms`

A pass-through node. Each message flies across a small popup as a dot. The dot size follows the payload size.

```text
Build "msg-trail". It passes each msg through unchanged.
For each msg, send its id, payload size and time to the editor. Keep the last 20 for a new popup.
The popup animates one dot per message from left to right on a canvas. Dot radius follows size.
Show the message rate in the popup status text.
```

## 2. Match clock: one countdown for the team area

Mixins: `nodeRedSingleton`, `nodeRedPopup`, `nodeRedEditorComms`, `nodeRedPubsubBus`

One team area has one clock. The popup shows the countdown on the canvas. Other nodes read the phase over the bus, with no wire.

```text
Build "match-clock", a singleton. It keeps a 150 s FRC match clock: auto 15 s, teleop, endgame in the last 30 s.
Offer the phase as a bus producer entry "phase" of type "frc/phase_v1".
Send a tick to the editor every second. The popup shows a big timer with Start and Stop buttons.
```

## 3. Approval inbox: hold messages until a person decides

Mixins: `nodeRedSingleton`, `nodeRedPopup`, `nodeRedEditorComms`, `nodeRedPubsubBus`

One inbox holds invoices and refunds until a person decides. The popup is the inbox panel on the canvas.

```text
Build "approval-inbox", a singleton with two outputs: approved and rejected.
Hold each incoming msg with its amount and requester. Do not call done() until a decision is made.
The popup shows a table with Approve and Reject buttons and a note field.
On a decision, send the held msg on the right output with msg.approval = { note, at }.
Offer the pending count as a bus producer entry "pending". Show "N waiting" in the node status.
```

## 4. Sensor hub: read sensors in a worker, view them anywhere

Mixins: `nodeRedWorker`, `nodeRedPubsubBus`, `nodeRedEditorComms`, `nodeRedPopup`

A worker samples sensors in its own thread. Viewer nodes pick a sensor from a dropdown and draw a live sparkline. No wires between them.

```text
Build two nodes.
"sensor-source": a worker samples battery voltage, motor current and temperature every 200 ms.
The worker registers a bus producer with one entry per sensor, type "robot/reading_v1".
"sensor-view": the edit dialog lists producers of that type in a dropdown.
It subscribes to the chosen entry, keeps the last 120 values, and draws a sparkline in the popup.
Show "no sensor" when the producer goes away. Also send each reading as a msg.
```

## 5. File parser: parse CSV in a worker with progress

Mixins: `nodeRedWorker`, `nodeRedEditorComms`, `nodeRedResourceEndpoint`

A big file blocks every flow when the main thread parses it. A worker keeps Node-RED fast. The edit dialog shows progress and bad rows.

```text
Build "file-parser". msg.payload.file is a path inside a folder set in the config; reject any other path.
A worker streams the CSV and sends rows to the main thread in chunks of 500. The node sends one msg per chunk.
Every chunk, report progress and bad rows to the editor. Show the percent in the node status.
The edit dialog draws a progress bar and a bad-row list from a script served by the resource endpoint.
```

## 6. Wire monitor: count and step messages between worker nodes

Mixins: `nodeRedWorker`, `nodeRedPopup`, `nodeRedEditorComms`

Worker nodes pass messages thread to thread, so Debug cannot see them. The monitor sits on that wire. It counts, and it can hold messages and release them one at a time.

```text
Build "wire-monitor". It goes on a wire between two worker nodes and forwards every message in the worker thread.
Count messages and bytes per sender every 500 ms and show messages per second in the node status.
A Hold mode queues messages in the worker. Step and Step all buttons in the popup release them.
The popup shows the rate and the queue as stacked boxes.
```

## 7. LED strip designer: paint a pattern, render it in a worker

Mixins: `nodeRedWorker`, `nodeRedEditorComms`, `nodeRedPopup`

Paint a pattern in a popup. A worker renders effects at a steady frame rate and sends pixel arrays out the wire.

```text
Build "led-designer". Config: number of LEDs.
The popup shows one cell per LED with a colour picker and an effect dropdown: static, fade, chase, rainbow.
Each change goes to the runtime, which loads it into a worker.
The worker renders at 30 frames per second and the node sends each frame as a Buffer of 3 bytes per LED.
The popup animates the strip from a preview of each frame.
```

## 8. Colour spotter: find a colour in camera frames on the GPU

Mixins: `nodeRedWorker`, `nodeRedGpu`, `nodeRedEditorComms`

Camera frames are big. A GPU kernel does the hue test, with the CPU fallback when there is no GPU. Sliders in the edit dialog change the colour range live.

```text
Build "colour-spotter". msg.payload is { width, height, rgba } with rgba as a Uint8Array.
A worker runs one GPU kernel that marks pixels inside a hue range, then finds the centre and area of the marked pixels.
Return { cx, cy, area } as msg.payload.
Two sliders in the edit dialog set the hue range live. Send a small preview mask to the dialog.
```

## 9. GPU vs CPU speed test

Mixins: `nodeRedWorker`, `nodeRedGpu`, `nodeRedEditorComms`, `nodeRedPopup`

The same maths on the GPU and in a JS loop. Two bars race in a popup. The reply names the device that ran.

```text
Build "gpu-speed-test". msg.payload is the array size, default one million.
A worker computes y = a*x + b on the GPU with one kernel, then the same in a plain JS loop, and times both.
Report each lap to the editor as it finishes. Return { gpuMs, cpuMs, device } where device is the GPU device name from the stats.
The popup draws two growing bars and the device name.
```

## 10. Modbus poll chain: three worker nodes on one wire

Mixins: `nodeRedWorker`, `nodeRedResourceEndpoint`, `nodeRedPubsubBus`

Three wired worker nodes: poll, scale, deadband. Samples move thread to thread. The main thread does no work per sample.

```text
Build three worker nodes: "modbus-poller", "tag-scale" and "deadband".
The poller worker uses modbus-serial (add it to dependencies), polls a register map on a timer, and emits { tag, value, ts, ok }.
On a read error it sets a red node status and marks ok false; it does not exit.
The poller also offers the tags as a bus producer entry "tags" of type "plant/tags_v1"; pass the node id to the worker for this.
The poller's edit dialog loads a device list from a JSON file served by the resource endpoint.
tag-scale applies scale and offset. deadband forwards only changes larger than a limit and shows the drop count.
```

## 11. Store-and-forward queue: keep messages on disk until the link is up

Mixins: `nodeRedWorker`, `nodeRedPopup`, `nodeRedEditorComms`, `nodeRedPubsubBus`

Disk writes and retry timers run in a worker. The popup shows the backlog while the cloud link is down. A health node reads the depth over the bus.

```text
Build "store-forward" with two outputs: deliver and dropped.
A worker appends each msg to segment files in a config folder, up to a size limit. When the disk limit is reached, reject the msg.
A send loop pops a batch and the node sends it on output 1 with a batch id. A msg with msg.ack = batchId confirms it.
A missing ack within a config time puts the batch back, with growing delay. After a retry limit, send it on output 2.
On start, scan the folder and continue. Offer the depth as a bus producer entry "backlog" of type "plant/backlog_v1".
The popup shows depth, bytes and oldest age, with a Purge button.
```

---

## Add your own

Open an issue or a pull request with a new prompt. Keep the shape: a heading that says what the node does, the mixins, two plain sentences on why, and one fenced prompt under 7 lines that says what the node does, not how.

[Back to node-red-utils](../README.md)
