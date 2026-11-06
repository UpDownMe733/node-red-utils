# node-red-gpu (experimental)

Run compute kernels on the GPU through Vulkan, from a [worker thread](../node-red-worker/README.md). You write the kernel in a small subset of JavaScript, or in GLSL.

This module is experimental and its API can change. It is tested on a Raspberry Pi 5 (V3D GPU). The native Vulkan addon is optional and not built on install. Without it, kernels run on the CPU backend, which needs no GPU.

## Usage

An edge filter for gray images: a blur kernel, then a Sobel kernel. The node starts a worker and hands it the image:

```js
const path = require('path');
const { NodeRedNodeBase, nodeRedWorker, nodeRedGpu } = require('@nrutils/node-red-utils');

// msg.payload is { width, height, pixels }: a Buffer with one gray byte per pixel
module.exports = NodeRedNodeBase.createNode('gpu-edges', [nodeRedWorker, nodeRedGpu], (RED, thisNode, config) => {
    const worker = thisNode.nodeRedWorker.init(path.join(__dirname, 'edge-worker.js'));

    thisNode.on('input', (msg, send, done) => {
        worker.request('edges', msg.payload, [], { timeout: 5000 }).then((edges) => {
            msg.payload = { ...msg.payload, pixels: Buffer.from(edges.buffer) };
            send(msg);
            done();
        }, done);
    });
});
```

The worker owns the GPU context:

```js
// edge-worker.js
const { nodeRedGpuWorker } = require('@nrutils/node-red-utils/node-red-gpu');

module.exports = function (worker) {
    const gpu = nodeRedGpuWorker();
    const options = {
        buffers: [{ name: 'src', dtype: 'f32', access: 'readonly' }, { name: 'dst', dtype: 'f32', access: 'writeonly' }],
        constants: { width: 'u32', height: 'u32' },
        workgroupSize: [16, 16]     // 2D: one thread per pixel; return writes dst[y * count + x]
    };
    const blur = gpu.registerJsKernel('blur', { ...options, kernel: function (src, dst) {
        const x = this.thread.x;
        const y = this.thread.y;
        const w = this.constants.width;
        if (x < 1 || y < 1 || x + 1 >= w || y + 1 >= this.constants.height) return src[y * w + x];
        let sum = 0.0;
        for (let dy = 0; dy < 3; dy++) {
            for (let dx = 0; dx < 3; dx++) sum += src[(y + dy - 1) * w + x + dx - 1];
        }
        return sum / 9.0;
    } });
    const edges = gpu.registerJsKernel('edges', { ...options, kernel: function (src, dst) {
        const x = this.thread.x;
        const y = this.thread.y;
        const w = this.constants.width;
        if (x < 1 || y < 1 || x + 1 >= w || y + 1 >= this.constants.height) return 0.0;
        const i = y * w + x;
        const gx = src[i - w + 1] + 2.0 * src[i + 1] + src[i + w + 1] - src[i - w - 1] - 2.0 * src[i - 1] - src[i + w - 1];
        const gy = src[i + w - 1] + 2.0 * src[i + w] + src[i + w + 1] - src[i - w - 1] - 2.0 * src[i - w] - src[i - w + 1];
        return Math.sqrt(gx * gx + gy * gy);
    } });

    worker.handle('edges', async ({ width, height, pixels }, transferList) => {
        // Released buffers are reused by the next request of the same size
        const [a, b, c] = [0, 1, 2].map(() => gpu.createBuffer(width * height, 'f32'));
        try {
            a.view.set(pixels);     // bytes to f32
            const pushConstants = { count: width, countY: height, width, height };
            const groups = Math.ceil(width / 16);
            const groupsY = Math.ceil(height / 16);
            // One submit: edges reads what blur wrote
            await gpu.dispatchChain([
                { kernel: blur, buffers: [a, b], pushConstants, groups, groupsY },
                { kernel: edges, buffers: [b, c], pushConstants, groups, groupsY }
            ]);
            const out = Uint8ClampedArray.from(c.view);
            transferList.push(out.buffer);  // moved to the main thread, not copied
            return out;
        } finally {
            [a, b, c].forEach((buf) => gpu.releaseBuffer(buf));
        }
    });
    worker.parentPorts.subscribe('close', () => gpu.close());
};
```

The two kernels run in one `dispatchChain`, and the blurred image stays in buffer `b` between them. After each request the three buffers go back to the pool, so the next image of the same size reuses them. Without the Vulkan addon, the same kernels run on the CPU backend.

`request()` is described in [node-red-worker](../node-red-worker/README.md#usage). If the kernel throws, or the worker stops, the request rejects and `done(err)` reports it.

The `nodeRedGpu` mixin on the main thread checks that Vulkan loads and logs one line per process: the device name, or the reason for the CPU fallback. If you force the Vulkan backend and it fails, the node shows a red status and logs the error. The mixin also points the SPIR-V cache at the Node-RED user directory (see [Build the Vulkan addon](#build-the-vulkan-addon-linux)).

### Constants and push constants

The word "constants" has two sides:

- At registration, `constants` declares the names and types: `constants: { width: 'u32', height: 'u32' }`. The kernel reads them as `this.constants.width`.
- At dispatch, `pushConstants` gives the values: `pushConstants: { count: width, countY: height, width, height }`. The name comes from Vulkan, which sends them to the GPU as push constants.

A JS kernel also has the push constants `count`, `countY` and `countZ` (see [JS kernels](#js-kernels)). Every dispatch must give `count` and each declared constant. If one is missing, `dispatch` and `dispatchChain` throw an error that names it. `countY` and `countZ` can be left out. A raw kernel must get every name in its `pushConstants`. Specialization constants (`specConstants`) are not passed at dispatch; see `respecializeKernel`.

## Backends

Set `NODE_RED_GPU_BACKEND` before you start Node-RED:

- `auto` (default): try Vulkan, else use the CPU and log a warning with the reason.
- `vulkan`: Vulkan or an error.
- `cpu`: always the CPU.

The CPU backend calls a JavaScript function for each kernel. `registerJsKernel` makes that function from your kernel. A raw `registerKernel` call needs a `cpuFallback` function; without one, it throws on the CPU backend. `cpuFallback` gets `{ buffers, pushConstants, specConstants, groups, groupsY, groupsZ }`, where `buffers` are typed arrays.

## Raw GLSL kernels

```js
const ADD_GLSL = `#version 450
layout(local_size_x = 256) in;
layout(std430, binding = 0) readonly  buffer A { uint a[]; };
layout(std430, binding = 1) readonly  buffer B { uint b[]; };
layout(std430, binding = 2) writeonly buffer O { uint o[]; };
layout(push_constant) uniform P { uint count; } p;
void main() {
    uint i = gl_GlobalInvocationID.x;
    if (i < p.count) o[i] = a[i] + b[i];
}`;

const add = gpu.registerKernel('add', {
    source: ADD_GLSL,
    language: 'glsl',               // or 'spirv' with a SPIR-V binary
    bindings: ['readonly', 'readonly', 'writeonly'],
    pushConstants: { count: 'u32' },
    workgroupSize: 256,
    cpuFallback({ buffers: [a, b, out], pushConstants: p }) {
        for (let i = 0; i < p.count; i++) out[i] = a[i] + b[i];
    }
});
```

## API

`nodeRedGpuWorker()` returns a GPU context for the current thread. Names in `[ ]` are optional.

- `registerJsKernel(name, { kernel, [buffers], [constants], [specConstants], [workgroupSize] })`: transpile a JS kernel to GLSL and register it. Returns a kernel.
- `registerKernel(name, { source, [language], [bindings], [pushConstants], [specConstants], [workgroupSize], [cpuFallback] })`: register a GLSL or SPIR-V kernel. Returns a kernel. `language` is `'glsl'` if you leave it out. The CPU backend needs `cpuFallback`.
- `createBuffer(count, dtype)`: returns a buffer. It reuses a released buffer of the same byte size if one exists. The contents are not cleared, so a reused buffer holds old data. Call `buffer.view.fill(0)` if the kernel needs zeros.
- `releaseBuffer(buffer)`: give a buffer back for reuse.
- `stats()`: device, buffer, kernel and dispatch counters.
- `close()`: destroy all buffers and kernels of this context. Call it on `close` in the worker.

- `dispatchChain([{ kernel, buffers, [pushConstants], groups, [groupsY], [groupsZ] }])`: run several kernels in order. `kernel` is a kernel from `registerKernel` or `registerJsKernel`. Each kernel sees the writes of the kernel before it. With Vulkan this is one queue submit with memory barriers between the kernels.
- `respecializeKernel(kernel, values)`: set new specialization constant values. A constant that is not in `values` becomes 0. With Vulkan this rebuilds the pipeline; the CPU backend keeps the values for the next dispatch. Throws if the kernel has no specialization constants.

These need the Vulkan backend:

- `exportBuffer(buffer)` and `importBuffer(ref)`: pass a buffer to another worker without a copy. The ref is a plain object that you can publish.

A kernel has `dispatch({ buffers, [pushConstants], groups, [groupsY], [groupsZ] })`, which returns a Promise, and `destroy()`.

A buffer has `view` (a typed array; with Vulkan it maps GPU memory), `count`, `dtype`, `byteLength`, `destroy()`, and `detach()`, which returns the `ArrayBuffer` and destroys the buffer.

Data types: `u8` `u16` `u32` `i8` `i16` `i32` `f32` `f64`.

## JS kernels

The kernel is a `function`, named or anonymous, with one parameter per buffer, in the order of `buffers`. Give each parameter the same name as its buffer. `registerJsKernel` throws a `GpuCompileError` on both backends for these mistakes, so a kernel that registers on the CPU backend also compiles on the GPU:

- An arrow function. It has no `this`, so use `function`.
- A variable from outside the function. The CPU backend rebuilds the kernel from its source, and the GPU cannot see JavaScript variables. Pass values in `this.constants`.
- A buffer, constant or local variable with a GLSL keyword or built-in name, such as `output`, `out`, `in`, `input`, `texture`, `mix`, `min`, `vec3` or a name that starts with `gl_`. The error names the identifier.

Inside the kernel you can use:

- `this.thread.x`, `.y`, `.z`, `.localX`, `.localY`, `.localZ`, and `this.constants.<name>`.
- `let` and `const`, `for`, `if`/`else`, the ternary operator, arithmetic, bitwise and comparison operators, `buf[index]` reads and writes.
- `return value` to write to the output buffer (the first buffer with `writeonly` or `readwrite` access), at index `x + y * count + z * count * countY`.
- `Math.abs`, `ceil`, `floor`, `round`, `sign`, `min`, `max`, `sqrt`, `pow`, `exp`, `log`, `log2`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`.

You cannot use `while`, nested functions, objects, arrays, strings, classes, `async` or `require`.

The transpiler also accepts GLSL-only calls:

- `float()`, `int()`, `uint()` and `Math.clamp`, `exp2`, `mix`, `step`, `smoothstep`, `fract`, `mod`. The CPU backend runs them with small JavaScript versions. Integer division stays different: in JavaScript `uint(v) / 2` gives a fraction, in GLSL it rounds down.
- `atomicAdd()` and the other atomics, and `barrier()`. They need the Vulkan backend. On the CPU backend, `registerJsKernel` throws a `GpuCompileError` that names the call.

Buffer options:

```js
{ name: 'data', dtype: 'f32' }                                   // readwrite storage buffer
{ name: 'data', dtype: 'f32', access: 'readonly' }               // or 'writeonly'
{ name: 'tile', dtype: 'f32', shared: true, count: 256 }         // workgroup shared memory
```

The context adds the push constants `count`, `countY` and `countZ`. Threads with `x >= count`, `y >= countY` or `z >= countZ` do not run; a `countY` or `countZ` of 0 counts as 1. For a 2D kernel, set `workgroupSize: [16, 16]` and pass `count`, `countY`, `groups` and `groupsY` to `dispatch`. `return v` then writes to index `y * count + x` of the output buffer, on the GPU and on the CPU.

## Build the Vulkan addon (Linux)

These steps are for Debian, Ubuntu and Raspberry Pi OS.

```bash
# build
sudo apt install g++ make python3 libvulkan-dev
# runtime
sudo apt install mesa-vulkan-drivers glslang-tools vulkan-tools

cd node_modules/@nrutils/node-red-utils/node-red-gpu/native
npx node-gyp rebuild
```

- `glslangValidator` (from `glslang-tools`) must be on the `PATH`. It compiles GLSL to SPIR-V at kernel registration.
- `node-addon-api` must be in `node_modules`. It is an optional dependency of this package, so `npm install` puts it there unless you install with `--omit=optional`.
- Run `vulkaninfo --summary` to check the GPU. If you see only `llvmpipe`, the driver cannot reach the GPU; check the permissions on `/dev/dri/renderD*`. The addon picks a hardware device and uses `llvmpipe` only if there is no other.
- Compiled SPIR-V is cached in `gpu-cache/` in the Node-RED user directory (the `-u` option; `~/.node-red` by default). The `nodeRedGpu` mixin sets `NODE_RED_GPU_CACHE` from `RED.settings.userDir`, and worker threads read it from there. Set `NODE_RED_GPU_CACHE` yourself to use another directory. Outside Node-RED the default is `~/.node-red/gpu-cache/`.

From a clone of this repository, `npm run test:gpu` runs a raw GLSL kernel and a JS kernel on the selected backend.

## How it works

All workers in the process share one Vulkan device. Buffer handles are valid in every worker, which is what makes `exportBuffer` work. On GPUs with unified memory, such as the Pi 5, `view` maps the GPU memory, so there is no copy between JavaScript and the GPU. Dispatches run off the JavaScript thread.

[Back to node-red-utils](../README.md)
