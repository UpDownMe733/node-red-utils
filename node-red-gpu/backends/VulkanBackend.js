'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { GpuAddonMissingError, GpuDeviceLostError, GpuCompileError, GpuOutOfMemoryError, GpuDispatchError } = require('../errors.js');

let addon;
try {
    addon = require('../native/build/Release/gpu_addon.node');
} catch (e) {
    throw new GpuAddonMissingError(`Failed to load gpu_addon: ${e.message}`);
}

// Read at compile time: the nodeRedGpu mixin sets NODE_RED_GPU_CACHE from the Node-RED userDir
const cacheDir = () => process.env.NODE_RED_GPU_CACHE || path.join(os.homedir(), '.node-red', 'gpu-cache');

const DTYPE_CTOR = {
    u8: Uint8Array, i8: Int8Array, u16: Uint16Array, i16: Int16Array,
    u32: Uint32Array, i32: Int32Array, f32: Float32Array, f64: Float64Array,
};

const PC_ENCODERS = {
    u32: (view, off, val) => { view.setUint32(off, val, true); return 4; },
    i32: (view, off, val) => { view.setInt32(off, val, true); return 4; },
    f32: (view, off, val) => { view.setFloat32(off, val, true); return 4; },
    u64: (view, off, val) => { view.setBigUint64(off, BigInt(val), true); return 8; },
};

const PC_SIZES = { u32: 4, i32: 4, f32: 4, u64: 8 };

function compileSpirvFromGlsl(source) {
    const hash = crypto.createHash('sha256').update(source).digest('hex');
    const CACHE_DIR = cacheDir();
    const spvPath = path.join(CACHE_DIR, `${hash}.spv`);
    if (fs.existsSync(spvPath)) return { spv: fs.readFileSync(spvPath), cacheHit: true };

    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const compPath = path.join(CACHE_DIR, `${hash}.comp`);
    fs.writeFileSync(compPath, source, 'utf8');
    try {
        execFileSync('glslangValidator', ['--target-env', 'vulkan1.2', '-S', 'comp', '-o', spvPath, compPath]);
    } catch (e) {
        // glslangValidator prints its errors to stdout
        throw new GpuCompileError(`glslangValidator failed`, `${e.stdout || ''}${e.stderr || ''}` || e.message);
    } finally {
        try { fs.unlinkSync(compPath); } catch (_) {}
    }
    return { spv: fs.readFileSync(spvPath), cacheHit: false };
}

function encodePushConstants(schema, values) {
    const totalBytes = Object.values(schema).reduce((sum, t) => sum + (PC_SIZES[t] || 4), 0);
    const ab = new ArrayBuffer(totalBytes);
    const view = new DataView(ab);
    let offset = 0;
    for (const [field, type] of Object.entries(schema)) {
        const encoder = PC_ENCODERS[type];
        if (!encoder) throw new TypeError(`Unknown push constant type: ${type}`);
        offset += encoder(view, offset, values[field] ?? 0);
    }
    return ab;
}

class VulkanBackend {
    constructor() {
        let deviceInfo;
        try {
            deviceInfo = addon.openDevice();
        } catch (e) {
            throw new GpuDeviceLostError(`openDevice failed: ${e.message}`);
        }
        this._device = deviceInfo;
        this._kernels = new Map();
        this._buffers = new Set();
        this._nextId = 1;
        this._cacheHits = 0;
        this._cacheMisses = 0;
    }

    registerKernel(name, options) {
        const { source, language = 'glsl', bindings = [], pushConstants = {}, workgroupSize = 64, specConstants = {} } = options;
        let spirv;
        if (language === 'spirv') {
            spirv = source instanceof ArrayBuffer ? source : Buffer.from(source).buffer;
        } else {
            const { spv, cacheHit } = compileSpirvFromGlsl(source);
            cacheHit ? this._cacheHits++ : this._cacheMisses++;
            spirv = spv.buffer.slice(spv.byteOffset, spv.byteOffset + spv.byteLength);
        }
        const pcSize = Object.values(pushConstants).reduce((s, t) => s + (PC_SIZES[t] || 4), 0);

        // Build spec constant count and initial values buffer
        const specConstantNames = Object.keys(specConstants);
        const specCount = specConstantNames.length;
        let addonHandle;
        try {
            if (specCount > 0) {
                // Encode initial spec values (all 0 by default — caller calls respecializeKernel to update)
                const specSchema = {};
                for (const [k, v] of Object.entries(specConstants)) {
                    specSchema[k] = typeof v === 'object' ? v.dtype : (v || 'u32');
                }
                const initialValues = {};
                for (const [k, v] of Object.entries(specConstants)) {
                    initialValues[k] = (typeof v === 'object' ? v.default : 0) || 0;
                }
                const specAb = encodePushConstants(specSchema, initialValues);
                addonHandle = addon.registerKernel(spirv, bindings.length, pcSize, workgroupSize, specCount, specAb);
            } else {
                addonHandle = addon.registerKernel(spirv, bindings.length, pcSize, workgroupSize);
            }
        } catch (e) {
            throw new GpuCompileError(`registerKernel '${name}' failed: ${e.message}`);
        }

        // Build schema for spec constants (for respecializeKernel encoding)
        const specConstantSchema = {};
        for (const [k, v] of Object.entries(specConstants)) {
            specConstantSchema[k] = typeof v === 'object' ? v.dtype : (v || 'u32');
        }

        const handle = {
            id: this._nextId++,
            name,
            _addonHandle: addonHandle,
            pushConstantSchema: pushConstants,
            specConstantSchema,
            specConstantCount: specCount,
        };
        this._kernels.set(handle.id, handle);
        return handle;
    }

    respecializeKernel(handle, specValues) {
        if (!handle.specConstantCount) {
            throw new Error(`respecializeKernel: kernel '${handle.name}' has no specialization constants`);
        }
        const ab = encodePushConstants(handle.specConstantSchema, specValues);
        try {
            addon.respecializeKernel(handle._addonHandle, ab);
        } catch (e) {
            throw new GpuCompileError(`respecializeKernel '${handle.name}' failed: ${e.message}`);
        }
    }

    createBuffer(count, dtype, _options) {
        const Ctor = DTYPE_CTOR[dtype];
        if (!Ctor) throw new TypeError(`Unknown dtype: ${dtype}`);
        const byteSize = count * Ctor.BYTES_PER_ELEMENT;
        let result;
        try {
            result = addon.createBuffer(byteSize);
        } catch (e) {
            throw new GpuOutOfMemoryError(`createBuffer failed for ${byteSize} bytes: ${e.message}`, byteSize);
        }
        const view = new Ctor(result.buffer);
        const handle = { view, count, dtype, byteLength: byteSize, _addonHandle: result.handle };
        this._buffers.add(handle);
        return handle;
    }

    async dispatch(kernelHandle, { buffers, pushConstants, groups, groupsY = 1, groupsZ = 1 }) {
        const handleArray = buffers.map(b => b._handle._addonHandle);
        const pcArrayBuffer = encodePushConstants(kernelHandle.pushConstantSchema, pushConstants || {});
        try {
            await addon.dispatch(kernelHandle._addonHandle, handleArray, pcArrayBuffer, groups, groupsY, groupsZ);
        } catch (e) {
            throw new GpuDispatchError(`dispatch failed: ${e.message}`);
        }
    }

    refBuffer(handle) {
        addon.refBuffer(handle._addonHandle);
    }

    importBuffer(ref) {
        const Ctor = DTYPE_CTOR[ref.dtype];
        if (!Ctor) throw new TypeError(`Unknown dtype: ${ref.dtype}`);
        const ab = addon.getBufferView(ref._gpuHandle);
        const view = new Ctor(ab);
        const handle = { view, count: ref.count, dtype: ref.dtype, byteLength: ref.byteLength, _addonHandle: ref._gpuHandle };
        this._buffers.add(handle);
        return handle;
    }

    async dispatchChain(specs) {
        const nativeSpecs = specs.map(s => ({
            kernel: s.kernelHandle._addonHandle,
            buffers: s.buffers.map(b => b._handle._addonHandle),
            pushConstants: encodePushConstants(s.kernelHandle.pushConstantSchema, s.pushConstants || {}),
            groupsX: s.groups,
            groupsY: s.groupsY || 1,
            groupsZ: s.groupsZ || 1,
        }));
        try {
            await addon.dispatchChain(nativeSpecs);
        } catch (e) {
            throw new GpuDispatchError(`dispatchChain failed: ${e.message}`);
        }
    }

    destroyBuffer(handle) {
        addon.destroyBuffer(handle._addonHandle);
        this._buffers.delete(handle);
    }

    destroyKernel(handle) {
        addon.destroyKernel(handle._addonHandle);
        this._kernels.delete(handle.id);
    }

    destroyDevice() {
        this._buffers.clear();
        this._kernels.clear();
        addon.destroyDevice();
    }

    stats() {
        const s = addon.stats();
        return {
            device: { name: this._device.deviceName, driverVersion: this._device.driverVersion, api: this._device.apiVersion, memoryBudgetMB: this._device.memoryBudgetMB },
            buffers: { count: s.buffersAllocated, totalBytes: s.buffersBytes, hostVisible: s.buffersAllocated, deviceLocal: 0 },
            kernels: { count: s.kernelsRegistered, cacheHits: this._cacheHits, cacheMisses: this._cacheMisses },
            dispatches: { submitted: s.dispatchesCompleted, completed: s.dispatchesCompleted, inFlight: 0, lastDurationUs: s.lastDispatchUs, lastGpuExecutionUs: s.lastGpuExecutionUs || 0 },
        };
    }
}

module.exports = { VulkanBackend };
