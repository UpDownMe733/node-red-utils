# Changelog

## 0.2.0 (2026-11-10)

- `nodeRedWorker`: a throw (or a rejected Promise) in a worker `subscribe` handler goes to the new `worker.handlerError(error, type, data)`, with the data of the message. The default reports it on the node with `node.error`, so a Catch node gets it, instead of `console.error`. The next handlers of the same message still run. A worker file can replace `worker.handlerError`.
- `nodeRedPopup`: the popup unfurls from its node with a spring animation. The user moves it by its status bar; the position is saved in `nru_popupConfig` (`x`, `y`) and a dashed line ties it to the node. A resize follows the zoom of the canvas. The popup is a rounded card in the editor theme (light or dark), with the color of its node on the top edge and the tether line, dots on the status bar that show it can be moved, and a larger resize corner.

## 0.1.0

First public release.

- `NodeRedNodeBase`: mixin composition.
- `nodeRedEditorComms`: editor and backend messaging.
- `nodeRedWorker`: worker threads, with `request()` / `handle()` for one answer per message.
- `nodeRedResourceEndpoint`: static file serving for the editor, also from `resources` in the `createNode` options.
- `nodeRedPopup`: a panel that opens when you click the node in the editor. Experimental.
- `nodeRedSingleton`: one node of a type in the editor. Experimental.
- `nodeRedPubsubBus`: pub/sub between nodes; consumers pull the current value.
- `nodeRedGpu`: Vulkan compute. Experimental and optional. Without the native addon, kernels run on the CPU backend.
- Eight examples (nine nodes) in `examples/`.
