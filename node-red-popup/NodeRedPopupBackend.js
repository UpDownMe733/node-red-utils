/**
 * Copyright 2024 Contributors
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

'use strict';

//
// Add this to the HTML file
// <script type="text/javascript" src="node-red-resourceendpoint/node-red-popup/NodeRedPopupFrontend.js"></script>
//

const path = require('path');
const { NodeRedResourceEndpoint } = require('../node-red-resourceendpoint/NodeRedResourceEndpoint.js');

/** Serve NodeRedPopupFrontend.js. Safe to call more than one time. */
function serveFrontend(RED) {
    new NodeRedResourceEndpoint(RED).registerResources('node-red-popup', path.join(__dirname, 'NodeRedPopupFrontend.js'));
}

/**
 * NodeRedPopup - Class for providing popup support in the Node-RED editor
 * Serves the PopupSupport.js file to add popup functionality to nodes
 */
class NodeRedPopup {

    /**
     * Create a new popup support handler
     * @param {object} RED - The Node-RED runtime instance
     * @param {object} node - The node instance
     */
    constructor(RED, node) {
        this.RED = RED;
        this.node = node;
        
        serveFrontend(RED);
    }
}

/**
 * Mixin that adds popup support capabilities to Node-RED nodes
 * 
 * Enables nodes to have popup elements in the editor
 * Following the same functional mixin pattern used by other mixins
 * 
 * @param {class} superclass - The class to extend with popup capabilities
 * @returns {class} A new class that extends the superclass with popup functionality
 */
const nodeRedPopup = (superclass) => class extends superclass {
    // Serve the frontend script before the first deploy
    static onRegisterType(RED) {
        super.onRegisterType?.(RED);
        serveFrontend(RED);
    }

    constructor(RED, thisNode, config) {
        super(RED, thisNode, config);

        // No methods needed on the node instance as this is just for serving the JS file
        this.nodeRedPopup = {
            _parent: this
        };
    }
};

// Export both the class and the mixin
module.exports.nodeRedPopup = nodeRedPopup;
module.exports.NodeRedPopup = NodeRedPopup;