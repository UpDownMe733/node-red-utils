'use strict';

class Kernel {
    /**
     * @param {string[]} requiredPushConstants - names that every dispatch must pass in pushConstants
     */
    constructor(kernelHandle, backend, name, requiredPushConstants) {
        this._handle = kernelHandle;
        this._backend = backend;
        this._name = name;
        this._required = requiredPushConstants;
        this._destroyed = false;
    }

    /** Throw if pushConstants lacks a declared value: Vulkan would read 0, the CPU undefined. */
    _checkPushConstants(pushConstants) {
        const missing = this._required.filter(k => pushConstants?.[k] === undefined);
        if (missing.length > 0) {
            throw new TypeError(`Kernel '${this._name}': pushConstants has no value for ${missing.map(k => `'${k}'`).join(', ')}`);
        }
    }

    async dispatch({ buffers, pushConstants, groups, groupsY = 1, groupsZ = 1 }) {
        this._checkPushConstants(pushConstants);
        return this._backend.dispatch(this._handle, { buffers, pushConstants, groups, groupsY, groupsZ });
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._backend.destroyKernel(this._handle);
    }
}

module.exports = { Kernel };
