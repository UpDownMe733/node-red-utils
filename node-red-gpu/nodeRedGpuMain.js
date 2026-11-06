'use strict';

const path = require('path');
const { logBackendOnce, fallbackMessage } = require('./log.js');

const BACKEND = process.env.NODE_RED_GPU_BACKEND || 'auto';

const nodeRedGpu = (superclass) => class extends superclass {
    constructor(RED, thisNode, config) {
        super(RED, thisNode, config);

        // Keep the SPIR-V cache in the userDir (-u). Worker threads get a copy of process.env.
        if (!process.env.NODE_RED_GPU_CACHE && RED.settings?.userDir) {
            process.env.NODE_RED_GPU_CACHE = path.join(RED.settings.userDir, 'gpu-cache');
        }

        let initError = null;
        try {
            if (BACKEND === 'vulkan' || BACKEND === 'auto') {
                const { VulkanBackend } = require('./backends/VulkanBackend.js');
                const vb = new VulkanBackend();
                logBackendOnce((m) => RED.log.info(m), `node-red-gpu: using Vulkan device "${vb._device.deviceName}"`);
                vb.destroyDevice();
            }
        } catch (err) {
            if (BACKEND === 'vulkan') initError = err;
            else logBackendOnce((m) => RED.log.warn(m), fallbackMessage(err));
        }

        if (initError) {
            thisNode.status({ fill: 'red', shape: 'dot', text: initError.message });
            thisNode.error(initError);
        }

        thisNode.on('close', (done) => done());
    }
};

module.exports = { nodeRedGpu };
