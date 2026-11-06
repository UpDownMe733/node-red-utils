/**
 * Copyright 2024 Contributors
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

'use strict';

const fs = require('fs');
const path = require('path');

// All copies of this library in one process share this state.
// Thus one route serves the files of every copy.
// Shape: { registry: Map<nodeType, Set<path>>, routeRegistered: boolean }
const shared = globalThis[Symbol.for('node-red-utils.resourceendpoint')] ??= {};
shared.registry ??= new Map();
shared.owners ??= new Map();        // nodeType -> name of the first package that registered it

/** Name in the nearest package.json above a path, or null */
function packageNameOf(resource) {
    let dir = path.dirname(path.resolve(resource));
    for (;;) {
        try {
            return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name || null;
        } catch (_) { /* no package.json here */ }
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

/**
 * Find the whitelisted file for a request, or return null.
 * A registered file matches its base name only.
 * A registered directory matches a file inside that directory only.
 * @param {Set<string>} resources - Registered file and directory paths
 * @param {string} requestPath - The decoded path after /<nodeType>/
 * @returns {string|null}
 */
function findResource(resources, requestPath) {
    for (const resource of resources) {
        const root = path.resolve(resource);
        let stat;
        try { stat = fs.statSync(root); } catch (_) { continue; }

        if (!stat.isDirectory()) {
            if (path.basename(root) === requestPath) return root;
            continue;
        }

        // Reject a path that resolves outside the registered directory
        const candidate = path.resolve(root, requestPath);
        if (!candidate.startsWith(root + path.sep)) continue;
        try {
            if (fs.statSync(candidate).isFile()) return candidate;
        } catch (_) { /* not in this directory */ }
    }
    return null;
}

/**
 * NodeRedResourceEndpoint - Class for registering and serving static resources
 * Allows Node-RED nodes to serve static assets from a custom endpoint
 */
class NodeRedResourceEndpoint {

    /**
     * Create a new resource endpoint handler
     * @param {object} RED - The Node-RED runtime instance
     */
    constructor(RED) {
        this.RED = RED;

        // Register the route only once per process
        if (!shared.routeRegistered) {
            shared.routeRegistered = true;
            this._setupEndpoint();
        }
    }

    /**
     * Register resources for a node type
     * @param {string} nodeType - The type identifier for the node
     * @param {Array<string>|string} resources - File paths or directory paths to whitelist
     * @returns {NodeRedResourceEndpoint} this object
     */
    registerResources(nodeType, resources) {
        if (!Array.isArray(resources)) resources = [resources];
        if (!shared.registry.has(nodeType)) shared.registry.set(nodeType, new Set());
        const resourceSet = shared.registry.get(nodeType);
        for (const resource of resources) {
            if (resourceSet.has(resource)) continue;     // each node instance registers again
            resourceSet.add(resource);
            if (!fs.existsSync(resource)) {
                this.RED.log.warn(`[NodeRedResourceEndpoint] Registered path does not exist: ${resource} (type ${nodeType})`);
            }
            const owner = packageNameOf(resource);
            if (!shared.owners.has(nodeType)) shared.owners.set(nodeType, owner);
            else if (owner && shared.owners.get(nodeType) && owner !== shared.owners.get(nodeType)) {
                this.RED.log.warn(`[NodeRedResourceEndpoint] The packages "${shared.owners.get(nodeType)}" and "${owner}" ` +
                    `both register files for "${nodeType}". Both are served under node-red-resourceendpoint/${nodeType}/; ` +
                    `for the same file name, the first registered file wins.`);
            }
        }
        return this;
    }

    /**
     * Setup the HTTP endpoint to serve resources.
     * Like the core /resources/ route of Node-RED, this route has no auth check:
     * the editor loads these files with <script src>, which sends no token.
     * @private
     */
    _setupEndpoint() {
        this.RED.httpAdmin.get('/node-red-resourceendpoint/:nodeType/*', (req, res) => {
            const nodeType = req.params.nodeType;
            const requestPath = req.params[0];
            const resources = shared.registry.get(nodeType);
            const resourcePath = resources ? findResource(resources, requestPath) : null;

            if (resourcePath) {
                res.sendFile(resourcePath);
            } else {
                this.RED.log.warn(`[NodeRedResourceEndpoint] Resource not found: ${requestPath} for node type: ${nodeType}`);
                res.sendStatus(404);
            }
        });
    }
}

/**
 * Mixin that adds resource endpoint capabilities to Node-RED nodes
 * 
 * Allows nodes to serve static assets from a custom endpoint
 * Following the same functional mixin pattern used by NodeRedWorker
 * 
 * @param {class} superclass - The class to extend with resource endpoint capabilities
 * @returns {class} A new class that extends the superclass with resource endpoint functionality
 */
const nodeRedResourceEndpoint = (superclass) => class extends superclass {
    // Serve the `resources` of the createNode options before the first deploy
    static onRegisterType(RED) {
        super.onRegisterType?.(RED);
        const { nodeType, resources } = this._registration || {};
        if (resources !== undefined) new NodeRedResourceEndpoint(RED).registerResources(nodeType, resources);
    }

    constructor(RED, thisNode, config) {
        super(RED, thisNode, config);
        
        // Create a namespaced object for resource endpoint functionality
        this.nodeRedResourceEndpoint = {
            /**
             * Initialize the resource endpoint for this node
             * @param {Object} [options] - Configuration options
             * @param {string} [options.nodeType] - The type identifier for the node. If not provided, thisNode.type will be used
             * @param {Array<string>|string} [options.resources] - File paths or directory paths to whitelist
             * @returns {object} The resource endpoint interface
             */
            init: function(options = {}) {
                // Use provided nodeType or fallback to thisNode.type
                this._nodeType = options.nodeType || thisNode.type;
                
                // Get or create the static resource endpoint handler
                if (!NodeRedResourceEndpoint._instance) {
                    NodeRedResourceEndpoint._instance = new NodeRedResourceEndpoint(RED);
                }
                
                this._parent.nodeRedResourceEndpoint = this;
                
                // Register resources if provided
                if (options.resources !== undefined) {
                    this.registerResources(options.resources);
                }
                
                return this;
            },

            /**
             * Register resources for a node type
             * @param {Array<string>|string} resources - Array of file paths or directory paths to whitelist
             */
            registerResources: function(resources) {
                if (!this._nodeType) {
                    throw new Error('Resource endpoint must be initialized with a node type before registering resources');
                }
                
                // Use the class instance to register resources
                NodeRedResourceEndpoint._instance.registerResources(this._nodeType, resources);
                return this;
            },
            
            _nodeType: null,
            _parent: this
        };
        thisNode.nodeRedResourceEndpoint = this.nodeRedResourceEndpoint;
    }
    
    // Static property to hold the single instance
    static _instance = null;
};

// Export both the class and the mixin
module.exports.nodeRedResourceEndpoint = nodeRedResourceEndpoint;
module.exports.NodeRedResourceEndpoint = NodeRedResourceEndpoint;
