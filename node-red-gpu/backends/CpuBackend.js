'use strict';

// The CPU backend ignores GLSL source entirely and calls cpuFallback instead.
// Kernels from registerJsKernel get a cpuFallback automatically. Raw kernels need their own.
// cpuFallback gets { buffers, pushConstants, specConstants, groups, groupsY, groupsZ }.

const { GpuCompileError, GpuOutOfMemoryError } = require('../errors.js');

const DTYPE_CTOR = {
    u8:  Uint8Array,
    i8:  Int8Array,
    u16: Uint16Array,
    i16: Int16Array,
    u32: Uint32Array,
    i32: Int32Array,
    f32: Float32Array,
    f64: Float64Array,
};

class CpuBackend {
    constructor() {
        this._kernels = new Map();
        this._buffers = new Set();
        this._dispatches = 0;
        this._nextId = 1;
    }

    registerKernel(name, options) {
        if (!options.cpuFallback) throw new GpuCompileError(`Kernel '${name}' requires cpuFallback for the CPU backend`);
        // Spec constant values, as the Vulkan backend sets them: the default, else 0
        const specConstants = {};
        for (const [k, v] of Object.entries(options.specConstants || {})) {
            specConstants[k] = (typeof v === 'object' ? v.default : 0) || 0;
        }
        const handle = { id: this._nextId++, name, cpuFallback: options.cpuFallback, specConstants };
        this._kernels.set(handle.id, handle);
        return handle;
    }

    createBuffer(count, dtype, _options) {
        const Ctor = DTYPE_CTOR[dtype];
        if (!Ctor) throw new TypeError(`Unknown dtype: ${dtype}`);
        let typedArray;
        try {
            typedArray = new Ctor(count);
        } catch (e) {
            throw new GpuOutOfMemoryError(`Failed to allocate ${count} × ${dtype}`, count * Ctor.BYTES_PER_ELEMENT);
        }
        const handle = { view: typedArray, count, dtype, byteLength: typedArray.byteLength };
        this._buffers.add(handle);
        return handle;
    }

    async dispatch(kernelHandle, { buffers, pushConstants, groups, groupsY, groupsZ }) {
        const views = buffers.map(b => b._handle.view);
        kernelHandle.cpuFallback({ buffers: views, pushConstants, specConstants: kernelHandle.specConstants, groups, groupsY, groupsZ });
        this._dispatches++;
    }

    // Run the kernels in order; each one sees the writes of the one before
    async dispatchChain(specs) {
        for (const s of specs) {
            await this.dispatch(s.kernelHandle, { ...s, groupsY: s.groupsY || 1, groupsZ: s.groupsZ || 1 });
        }
    }

    // There is no pipeline to rebuild: store the values for the next dispatch
    respecializeKernel(handle, specValues) {
        if (Object.keys(handle.specConstants).length === 0) {
            throw new Error(`respecializeKernel: kernel '${handle.name}' has no specialization constants`);
        }
        // Like Vulkan, a value that is not given becomes 0
        for (const k of Object.keys(handle.specConstants)) handle.specConstants[k] = specValues[k] ?? 0;
    }

    refBuffer(_handle) {
        throw new Error('CpuBackend does not support shared GPU buffers');
    }

    importBuffer(_ref) {
        throw new Error('CpuBackend does not support shared GPU buffers');
    }

    destroyBuffer(handle) {
        this._buffers.delete(handle);
    }

    destroyKernel(handle) {
        this._kernels.delete(handle.id);
    }

    destroyDevice() {
        this._buffers.clear();
        this._kernels.clear();
    }

    stats() {
        let totalBytes = 0;
        for (const b of this._buffers) totalBytes += b.byteLength;
        return {
            device: { name: 'cpu', driverVersion: 'n/a', api: 'cpu' },
            buffers: { count: this._buffers.size, totalBytes, hostVisible: this._buffers.size, deviceLocal: 0 },
            kernels: { count: this._kernels.size, cacheHits: 0, cacheMisses: 0 },
            dispatches: { submitted: this._dispatches, completed: this._dispatches, inFlight: 0, lastDurationUs: 0 },
        };
    }
}

module.exports = { CpuBackend };
