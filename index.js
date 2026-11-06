/**
 * Copyright 2024 Contributors
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

'use strict';

const NodeRedNodeBase =             require('./node-red-base/NodeRedNodeBase.js');

const NodeRedEditorComms =          require('./node-red-editorcomms/EditorCommsBackend.js');

const NodeRedResourceEndpoint =     require('./node-red-resourceendpoint/NodeRedResourceEndpoint.js');

const NodeRedWorker =               require('./node-red-worker/NodeRedWorker.js');
const NodeRedWorkerRuntime =        require('./node-red-worker/NodeRedWorkerRuntime.js');

const NodeRedPopup =                require('./node-red-popup/NodeRedPopupBackend.js');
const NodeRedSingleton =            require('./node-red-singleton/NodeRedSingletonBackend.js');

const NodeRedPubsubBus =            require('./node-red-pubsub-bus/NodeRedPubsubBus.js');

module.exports = {

    NodeRedNodeBase:                NodeRedNodeBase.NodeRedNodeBase,

    nodeRedEditorComms:             NodeRedEditorComms.nodeRedEditorComms,
    NodeRedEditorComms:             NodeRedEditorComms.NodeRedEditorComms,

    nodeRedResourceEndpoint:        NodeRedResourceEndpoint.nodeRedResourceEndpoint,
    NodeRedResourceEndpoint:        NodeRedResourceEndpoint.NodeRedResourceEndpoint,
    
    nodeRedWorker:                  NodeRedWorker.nodeRedWorker,
    NodeRedWorker:                  NodeRedWorker.NodeRedWorker,
    NodeRedWorkerRuntime:           NodeRedWorkerRuntime.NodeRedWorkerRuntime,

    nodeRedPopup:                   NodeRedPopup.nodeRedPopup,
    NodeRedPopup:                   NodeRedPopup.NodeRedPopup,

    nodeRedSingleton:               NodeRedSingleton.nodeRedSingleton,

    nodeRedPubsubBus:               NodeRedPubsubBus.nodeRedPubsubBus,
    getBus:                         NodeRedPubsubBus.getBus,
    NodeRedPubsubBus:               NodeRedPubsubBus.NodeRedPubsubBus,

    // Loaded on first use, so that nodes without GPU code do not load the GPU module and acorn
    get nodeRedGpu()                { return require('./node-red-gpu/index.js').nodeRedGpu; },
    get nodeRedGpuWorker()          { return require('./node-red-gpu/index.js').nodeRedGpuWorker; },

};