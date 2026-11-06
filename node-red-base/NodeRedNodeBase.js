/**
 * Copyright 2024 Contributors
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

'use strict';

/**
 * Base class for Node-RED nodes that supports mixin composition
 * 
 * This class serves as the foundation for creating Node-RED nodes
 * and provides functionality for applying multiple mixins using
 * a functional composition pattern.
 */
/** Short description of a value for error messages */
function describe(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'an array';
    if (typeof value === 'function') return `function ${value.name || '(anonymous)'}`;
    return typeof value;
}

/** Throws a TypeError unless mixin is a function that takes a class and returns a subclass of it */
function checkMixin(mixin, i, where) {
    const prefix = `${where}: mixins[${i}] must be a mixin function (superclass) => class extends superclass`;
    if (typeof mixin !== 'function') throw new TypeError(`${prefix}; got ${describe(mixin)}`);
    if (mixin.toString().startsWith('class ')) throw new TypeError(`${prefix}; got the class ${mixin.name || '(anonymous)'} itself`);
    const TestClass = function() {};
    let result;
    try {
        result = mixin(TestClass);
    } catch (e) {
        throw new TypeError(`${prefix}; calling it threw: ${e.message}`);
    }
    if (typeof result !== 'function' || !(result.prototype instanceof TestClass)) {
        throw new TypeError(`${prefix}; it returned ${describe(result)}, not a subclass of its argument`);
    }
}

class NodeRedNodeBase {

    /**
     * Applies one or more mixin functions to extend the base class
     * 
     * This method uses functional composition to progressively apply
     * each mixin function to the class, allowing multiple behaviors
     * to be combined without deep inheritance hierarchies.
     * 
     * @param {...Function} mixins - One or more mixin functions that transform classes
     * @returns {Class} - A new class with all mixins applied
     * @throws {TypeError} - If any of the provided mixins is not a function
     * 
     * @example
     * // Single mixin
     * class MyNode extends NodeRedNodeBase.with(MixinA) {}
     * 
     * @example
     * // Multiple mixins (applied left to right)
     * class MyNode extends NodeRedNodeBase.with(MixinA, MixinB, MixinC) {}
     */
    static with(...mixins) {
        mixins.forEach((mixin, i) => checkMixin(mixin, i, 'NodeRedNodeBase.with(...mixins)'));
        return mixins.reduce((currentClass, mixin) => mixin(currentClass), this);
    }

    /**
     * Creates a Node-RED node with specified mixins and custom setup
     * 
     * @param {string} nodeType - The type name to register with Node-RED
     * @param {Array} mixins - Array of mixin functions to apply
     * @param {Function} setupFn - Function for node setup (receives RED, thisNode, config)
     * @param {Object} [options] - Third argument of RED.nodes.registerType, for example { credentials, settings }.
     *   It can also hold `resources`: paths that the nodeRedResourceEndpoint mixin serves from the start.
     *   createNode does not pass `resources` on to registerType.
     * @returns {Function} - A function to be exported by the node module
     */
    static createNode(nodeType, mixins, setupFn, options) {
        const where = 'createNode(type, mixins, setup)';
        if (typeof nodeType !== 'string' || !nodeType) {
            throw new TypeError(`${where}: type must be a non-empty string; got ${describe(nodeType)}`);
        }
        if (!Array.isArray(mixins)) {
            throw new TypeError(`${where}: mixins must be an array of mixin functions; got ${describe(mixins)}`);
        }
        mixins.forEach((mixin, i) => checkMixin(mixin, i, where));
        if (typeof setupFn !== 'function') {
            throw new TypeError(`${where}: setup must be a function (RED, thisNode, config); got ${describe(setupFn)}`);
        }
        if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) {
            throw new TypeError(`${where}: options must be an object such as { credentials, settings }; got ${describe(options)}`);
        }
        const { resources, ...registerOptions } = options || {};
        return function(RED) {
            // Create the composed class with mixins
            const NodeClass = class extends NodeRedNodeBase.with(...mixins) {
                // Read by onRegisterType of the resource endpoint mixin
                static _registration = { nodeType, resources };

                constructor(RED, thisNode, config) {
                    super(RED, thisNode, config);

                    // Run the setup function. It must be synchronous; report the error of an async one.
                    const result = setupFn(RED, thisNode, config);
                    if (result && typeof result.then === 'function') {
                        result.then(undefined, (err) => thisNode.error(`setup of ${nodeType} failed: ${(err && err.message) || err}`));
                    }
                }
            };

            // Let the mixins do their one-time work before any node exists
            NodeClass.onRegisterType(RED);

            RED.nodes.registerType(nodeType, function(config) {
                RED.nodes.createNode(this, config);
                new NodeClass(RED, this, config);
            }, options && registerOptions);
        };
    }

    /**
     * Called one time when the node type is registered, before any node instance exists.
     * A mixin that overrides it must call super.onRegisterType(RED).
     * The editor mixins use it to serve their frontend scripts.
     *
     * @param {Object} RED - The Node-RED runtime object
     */
    static onRegisterType(RED) {}
    
    /**
     * Creates a new Node-RED node
     * 
     * @param {Object} RED - The Node-RED runtime object
     * @param {Object} thisNode - The node being created
     * @param {Object} config - Configuration options for the node
     */
    constructor(RED, thisNode, config) {
        // Base implementation to be extended by subclasses
    }

}

module.exports.NodeRedNodeBase = NodeRedNodeBase;