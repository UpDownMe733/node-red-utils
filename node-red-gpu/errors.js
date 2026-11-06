'use strict';

class GpuError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'GpuError';
        this.code = code;
    }
}

class GpuCompileError extends GpuError {
    constructor(message, diagnostics = []) {
        super(message, 'GPU_COMPILE_ERROR');
        this.name = 'GpuCompileError';
        this.diagnostics = diagnostics;
    }
}

class GpuOutOfMemoryError extends GpuError {
    constructor(message, requestedBytes) {
        super(message, 'GPU_OUT_OF_MEMORY');
        this.name = 'GpuOutOfMemoryError';
        this.requestedBytes = requestedBytes;
    }
}

class GpuDispatchError extends GpuError {
    constructor(message) {
        super(message, 'GPU_DISPATCH_FAILED');
        this.name = 'GpuDispatchError';
    }
}

class GpuDeviceLostError extends GpuError {
    constructor(message) {
        super(message, 'GPU_DEVICE_LOST');
        this.name = 'GpuDeviceLostError';
    }
}

class GpuAddonMissingError extends GpuError {
    constructor(message) {
        super(message, 'GPU_ADDON_MISSING');
        this.name = 'GpuAddonMissingError';
    }
}

module.exports = { GpuError, GpuCompileError, GpuOutOfMemoryError, GpuDispatchError, GpuDeviceLostError, GpuAddonMissingError };
