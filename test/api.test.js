'use strict';

// Checks of argument errors. These run without Node-RED.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { NodeRedNodeBase, nodeRedWorker } = require('..');

describe('createNode arguments', () => {
    it('mixins that are not an array give one clear TypeError', () => {
        assert.throws(() => NodeRedNodeBase.createNode('x', () => {}),
            { name: 'TypeError', message: 'createNode(type, mixins, setup): mixins must be an array of mixin functions; got function (anonymous)' });
    });

    it('a bad mixin gives one message that names createNode', () => {
        assert.throws(() => NodeRedNodeBase.createNode('x', [(sup) => 42], () => {}), (err) => {
            assert.equal(err.name, 'TypeError');
            assert.match(err.message, /^createNode\(type, mixins, setup\): mixins\[0\] must be a mixin function .*; it returned number, not a subclass/);
            assert.doesNotMatch(err.message, /with\(\)/);
            return true;
        });
        assert.throws(() => NodeRedNodeBase.createNode('x', [undefined], () => {}), /mixins\[0\] .*; got undefined$/);
    });

    it('a missing setup function or type is reported', () => {
        assert.throws(() => NodeRedNodeBase.createNode('x', []), /setup must be a function/);
        assert.throws(() => NodeRedNodeBase.createNode('', [], () => {}), /type must be a non-empty string/);
    });
});

describe('nodeRedWorker before and after init()', () => {
    const WorkerNode = NodeRedNodeBase.with(nodeRedWorker);
    const fakeNode = () => ({ id: 'n1', on() {}, error() {}, status() {} });
    const RED = { events: { on() {} } };

    it('publish() before init() gives a clear error', () => {
        const node = fakeNode();
        new WorkerNode(RED, node, {});
        assert.throws(() => node.nodeRedWorker.publish('x', 1), /call init\(\) before publish\(\)/);
    });

    it('a second init() throws and does not start a second worker', async () => {
        const node = fakeNode();
        new WorkerNode(RED, node, {});
        const first = node.nodeRedWorker;
        const worker = first.init(path.join(__dirname, 'fixtures', 'test-nodes', 'worker.js'), { id: 'n1' });
        try {
            assert.throws(() => node.nodeRedWorker.init(), /already called/);
            assert.throws(() => first.init(), /already called/);
            assert.equal(node.nodeRedWorker, worker);
        } finally {
            await worker.terminate();
        }
    });
});

describe('resource endpoint registration', () => {
    const { NodeRedResourceEndpoint } = require('..');
    const warnings = [];
    const RED = { httpAdmin: { get() {} }, log: { warn: (m) => warnings.push(m) } };

    it('returns the API object and warns about a missing path and a type of two packages', () => {
        const endpoint = new NodeRedResourceEndpoint(RED);
        const fixtures = path.join(__dirname, 'fixtures', 'test-nodes');
        assert.equal(endpoint.registerResources('nru-api-a', path.join(fixtures, 'public')), endpoint);
        assert.deepEqual(warnings, []);

        endpoint.registerResources('nru-api-a', path.join(fixtures, 'nothing-here.js'));
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /does not exist: .*nothing-here\.js/);

        // Same type from a second package (the repository root package)
        endpoint.registerResources('nru-api-a', path.join(__dirname, '..', 'README.md'));
        assert.equal(warnings.length, 2);
        assert.match(warnings[1], /"nru-test-nodes" and "@nrutils\/node-red-utils" both register files for "nru-api-a"/);

        // Registering a path again (each node instance does it) gives no new warning
        endpoint.registerResources('nru-api-a', path.join(fixtures, 'public'));
        assert.equal(warnings.length, 2);
    });

    it('the mixin registerResources() returns the API object, like init()', () => {
        const { nodeRedResourceEndpoint } = require('..');
        const node = { type: 'nru-api-b' };
        new (NodeRedNodeBase.with(nodeRedResourceEndpoint))(RED, node, {});
        const api = node.nodeRedResourceEndpoint.init();
        assert.equal(api.registerResources(path.join(__dirname, 'fixtures', 'test-nodes', 'public')), api);
    });
});
