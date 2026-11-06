'use strict';

class GpuBuffer {
    constructor(bufferHandle, backend) {
        this._handle = bufferHandle;
        this._backend = backend;
        this._destroyed = false;
    }

    get view() { return this._handle.view; }
    get count() { return this._handle.count; }
    get dtype() { return this._handle.dtype; }
    get byteLength() { return this._handle.byteLength; }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._backend.destroyBuffer(this._handle);
    }

    detach() {
        const ab = this._handle.view.buffer;
        this._handle.view = null;
        this.destroy();
        return ab;
    }
}

module.exports = { GpuBuffer };
