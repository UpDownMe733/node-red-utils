/**
 * Copyright 2024 Contributors
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

'use strict';

const path = require('path');
const { NodeRedResourceEndpoint } = require('../node-red-resourceendpoint/NodeRedResourceEndpoint.js');

/**
 * NodeRedSingleton - Mixin that ensures only one instance of a node type can exist in a flow
 * 
 * This mixin simply provides a resource endpoint for the frontend script that will 
 * actually enforces the singleton pattern in the editor.
 * 
 * @param {class} superclass - The class to extend with singleton capabilities
 * @returns {class} A new class that extends the superclass with singleton functionality
 */
const nodeRedSingleton = (superclass) => class extends superclass {
    // Serve the frontend script before the first deploy
    static onRegisterType(RED) {
        super.onRegisterType?.(RED);
        new NodeRedResourceEndpoint(RED).registerResources('node-red-singleton',
            path.join(__dirname, 'NodeRedSingletonFrontend.js'));
    }
};

module.exports.nodeRedSingleton = nodeRedSingleton;