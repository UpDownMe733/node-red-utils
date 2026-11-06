# Changelog

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
