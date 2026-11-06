'use strict';

const { CpuBackend } = require('./backends/CpuBackend.js');
const { Kernel } = require('./Kernel.js');
const { GpuBuffer } = require('./GpuBuffer.js');
const { transpile } = require('./transpiler/index.js');
const { GpuCompileError } = require('./errors.js');
const { logBackendOnce, fallbackMessage } = require('./log.js');
const { isMainThread } = require('worker_threads');

// JS versions of the GLSL-only math calls, so JS kernels also run on the CPU backend
const MATH_SHIMS = Object.assign(Object.create(Math), {
    clamp: (x, lo, hi) => Math.min(Math.max(x, lo), hi),
    exp2: (x) => 2 ** x,
    mix: (a, b, t) => a * (1 - t) + b * t,
    step: (edge, x) => (x < edge ? 0 : 1),
    smoothstep: (e0, e1, x) => {
        const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
        return t * t * (3 - 2 * t);
    },
    fract: (x) => x - Math.floor(x),
    mod: (x, y) => x - y * Math.floor(x / y),
});
const CASTS = {
    float: (x) => Math.fround(x),
    int: (x) => x | 0,
    uint: (x) => x >>> 0,
};

/** Rebuild the kernel source with the shims in scope, for the CPU backend. */
function makeCpuKernel(fn) {
    const source = typeof fn === 'function' ? fn.toString() : fn;
    return new Function('Math', 'float', 'int', 'uint', `return (${source});`)(MATH_SHIMS, CASTS.float, CASTS.int, CASTS.uint);
}

const BACKEND = process.env.NODE_RED_GPU_BACKEND || 'auto';

function makeBackend() {
    if (BACKEND === 'cpu') return new CpuBackend();
    if (BACKEND === 'vulkan') {
        const { VulkanBackend } = require('./backends/VulkanBackend.js');
        return new VulkanBackend();
    }
    if (BACKEND === 'auto') {
        try {
            const { VulkanBackend } = require('./backends/VulkanBackend.js');
            return new VulkanBackend();
        } catch (err) {
            // In a worker thread the nodeRedGpu mixin on the main thread has already logged the reason
            if (isMainThread) logBackendOnce(console.warn, fallbackMessage(err));
            return new CpuBackend();
        }
    }
    throw new Error(`Unknown GPU backend: ${BACKEND}`);
}

const nodeRedGpuWorker = () => {
    const backend = makeBackend();
    const kernels = new Set();
    const buffers = new Set();
    const pool = new Map();  // byteSize → [GpuBuffer, GpuBuffer, ...]
    const DTYPE_BYTES = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, f64: 8 };
    const DTYPE_CTOR = { u8: Uint8Array, i8: Int8Array, u16: Uint16Array, i16: Int16Array, u32: Uint32Array, i32: Int32Array, f32: Float32Array, f64: Float64Array };

    function registerKernel(name, options, requiredPushConstants = Object.keys(options.pushConstants || {})) {
        const handle = backend.registerKernel(name, options);
        const kernel = new Kernel(handle, backend, name, requiredPushConstants);
        kernels.add(kernel);
        return kernel;
    }

    function registerJsKernel(name, options) {
        const { kernel: fn, buffers: bufSpec = [], constants = {}, workgroupSize = 256, specConstants = {} } = options;

        // Transpile JS kernel → GLSL 450
        const { glsl: glslSource, gpuOnlyCalls } = transpile(fn, {
            buffers: bufSpec,
            constants,
            workgroupSize,
            specConstants,
        });

        // The CPU runs threads one after another, so it cannot honor these calls
        if (backend instanceof CpuBackend && gpuOnlyCalls.size > 0) {
            throw new GpuCompileError(`Kernel '${name}' uses ${[...gpuOnlyCalls].join(', ')}, which needs the Vulkan backend. The CPU backend cannot run it.`);
        }
        const cpuKernel = makeCpuKernel(fn);

        // Build the registerKernel options from the JS kernel spec
        // Shared buffers are GLSL shared variables — they don't get Vulkan SSBO bindings
        const bindings = bufSpec.filter(b => !b.shared).map(b => b.access || 'readwrite');
        const specConstantSet = new Set(
            Array.isArray(specConstants) ? specConstants : Object.keys(specConstants)
        );
        // Spec constants live in VkSpecializationInfo, not the push_constant block
        const pushConstants = {};
        for (const [k, v] of Object.entries(constants)) {
            if (!specConstantSet.has(k)) pushConstants[k] = v;
        }
        pushConstants.count = 'u32';
        // A dispatch must pass the constants and count; countY and countZ (for 2D and 3D) may be left out
        const requiredPushConstants = Object.keys(pushConstants);
        pushConstants.countY = 'u32';
        pushConstants.countZ = 'u32';

        // Auto-generate cpuFallback from the original JS function.
        // Supports 1D, 2D, and 3D dispatch via pc.count / pc.countY / pc.countZ.
        const cpuFallback = ({ buffers: cpuBufs, pushConstants: pc, specConstants: spec }) => {
            const countX = pc.count;
            const countY = pc.countY || 1;
            const countZ = pc.countZ || 1;
            const ctx = {
                thread: { x: 0, y: 0, z: 0, localX: 0, localY: 0, localZ: 0 },
                // Spec constants are read like the other constants
                constants: { ...spec, ...pc },
            };

            // Rebuild the full buffer array, inserting locally-allocated typed arrays for
            // shared buffers (which have no backing SSBO in cpuBufs).
            let ssboBufIdx = 0;
            const allBufs = bufSpec.map(buf => {
                if (buf.shared) {
                    return new (DTYPE_CTOR[buf.dtype])(buf.count);
                }
                return cpuBufs[ssboBufIdx++];
            });

            // Find the output buffer (first readwrite or writeonly) in the full buf list
            const outIdx = bufSpec.findIndex(b => !b.shared && (b.access === 'readwrite' || b.access === 'writeonly'));
            const outBuf = outIdx >= 0 ? allBufs[outIdx] : allBufs[0];
            for (let z = 0; z < countZ; z++) {
                ctx.thread.z = z;
                for (let y = 0; y < countY; y++) {
                    ctx.thread.y = y;
                    for (let x = 0; x < countX; x++) {
                        ctx.thread.x = x;
                        const result = cpuKernel.apply(ctx, allBufs);
                        if (result !== undefined) {
                            const idx = x + y * countX + z * countX * countY;
                            outBuf[idx] = result;
                        }
                    }
                }
            }
        };

        return registerKernel(name, {
            source: glslSource,
            language: 'glsl',
            bindings,
            pushConstants,
            workgroupSize,
            cpuFallback,
            specConstants,
        }, requiredPushConstants);
    }

    function createBuffer(count, dtype, options) {
        const byteSize = count * DTYPE_BYTES[dtype];
        const pooled = pool.get(byteSize);
        if (pooled && pooled.length > 0) {
            const buf = pooled.pop();
            if (pooled.length === 0) pool.delete(byteSize);
            // Re-type the view if dtype changed
            if (buf.dtype !== dtype) {
                const Ctor = DTYPE_CTOR[dtype];
                buf._handle.view = new Ctor(buf._handle.view.buffer);
                buf._handle.dtype = dtype;
                buf._handle.count = count;
            }
            buf._destroyed = false;
            buffers.add(buf);
            return buf;
        }
        const handle = backend.createBuffer(count, dtype, options);
        const buf = new GpuBuffer(handle, backend);
        buffers.add(buf);
        return buf;
    }

    function releaseBuffer(gpuBuffer) {
        if (gpuBuffer._destroyed) return;
        gpuBuffer._destroyed = true;
        buffers.delete(gpuBuffer);
        const byteSize = gpuBuffer.byteLength;
        let list = pool.get(byteSize);
        if (!list) { list = []; pool.set(byteSize, list); }
        list.push(gpuBuffer);
    }

    function exportBuffer(gpuBuffer) {
        backend.refBuffer(gpuBuffer._handle);
        return {
            _gpuHandle: gpuBuffer._handle._addonHandle,
            dtype: gpuBuffer.dtype,
            count: gpuBuffer.count,
            byteLength: gpuBuffer.byteLength,
        };
    }

    function importBuffer(ref) {
        const handle = backend.importBuffer(ref);
        const buf = new GpuBuffer(handle, backend);
        buffers.add(buf);
        return buf;
    }

    async function dispatchChain(specs) {
        const handleSpecs = specs.map(({ kernel, ...rest }, i) => {
            if (!(kernel instanceof Kernel)) throw new TypeError(`dispatchChain: spec ${i} needs a kernel from registerKernel or registerJsKernel in 'kernel'`);
            kernel._checkPushConstants(rest.pushConstants);
            return { ...rest, kernelHandle: kernel._handle };
        });
        return backend.dispatchChain(handleSpecs);
    }

    function stats() {
        return backend.stats();
    }

    async function close() {
        for (const buf of buffers) buf.destroy();
        // Flush pooled buffers
        for (const [, list] of pool) {
            for (const buf of list) {
                buf._destroyed = false;  // un-flag so destroy() works
                buf.destroy();
            }
        }
        pool.clear();
        for (const kernel of kernels) kernel.destroy();
        backend.destroyDevice();
    }

    function respecializeKernel(kernel, specValues) {
        backend.respecializeKernel(kernel._handle, specValues);
    }

    return { registerKernel, registerJsKernel, respecializeKernel, createBuffer, releaseBuffer, exportBuffer, importBuffer, dispatchChain, stats, close };
};

module.exports = { nodeRedGpuWorker };
