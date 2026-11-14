'use strict';

// Tests of the popup editor script. The script runs in a vm with a small fake DOM and a fake RED.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'node-red-popup', 'NodeRedPopupFrontend.js'), 'utf8');

// A fake element. It keeps attributes, children, listeners and calls to animate().
class FakeElement {
    constructor(tag) {
        this.tagName = tag;
        this.attrs = new Map();
        this.children = [];
        this.parentNode = null;
        this.style = {};
        this.listeners = {};
        this.animations = [];
        this.textContent = '';
    }
    get id() { return this.attrs.get('id'); }
    get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
    setAttribute(name, value) { this.attrs.set(name, String(value)); }
    removeAttribute(name) { this.attrs.delete(name); }
    getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
    appendChild(child) {
        child.parentNode?.children.splice(child.parentNode.children.indexOf(child), 1);
        child.parentNode = this;
        this.children.push(child);
        return child;
    }
    append(...children) { for (const child of children) this.appendChild(child); }
    insertBefore(child, before) {
        if (!before) return this.appendChild(child);
        child.parentNode?.children.splice(child.parentNode.children.indexOf(child), 1);
        child.parentNode = this;
        this.children.splice(this.children.indexOf(before), 0, child);
        return child;
    }
    get nextSibling() {
        const siblings = this.parentNode?.children;
        return siblings ? siblings[siblings.indexOf(this) + 1] ?? null : null;
    }
    // The root of the fake DOM is the only element without a parent that is connected
    get isConnected() { let element = this; while (element.parentNode) element = element.parentNode; return element.isRoot === true; }
    remove() { this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
    *all() { for (const child of this.children) { yield child; yield* child.all(); } }
    querySelector(selector) {
        for (const element of this.all()) {
            if (selector.startsWith('.') ? element.getAttribute('class') === selector.slice(1) : element.tagName === selector) return element;
        }
        return null;
    }
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); }
    removeEventListener(type, handler) { this.listeners[type] = (this.listeners[type] || []).filter(h => h !== handler); }
    dispatch(type, props = {}) {
        const event = { type, currentTarget: this, preventDefault() {}, stopPropagation() {}, clientX: 0, clientY: 0, ...props };
        for (const handler of [...(this.listeners[type] || [])]) handler(event);
    }
    getBBox() { return { width: this.textContent.length * 6 }; }
    getTotalLength() { return 100; }
    animate(keyframes, options) {
        const animation = { keyframes, options, cancel() {}, onfinish: null };
        this.animations.push(animation);
        return animation;
    }
}

// Load the script with two popup nodes on tab t1. Returns the parts that the tests look at.
const load = async ({ reduceMotion = false, nodes: nodeOptions = [{}], local = {} } = {}) => {
    // The root plays the event layer of the editor. The node <g>s are in the node layer.
    const root = new FakeElement('svg');
    root.isRoot = true;
    const nodeLayer = new FakeElement('g');
    root.appendChild(nodeLayer);
    const document = {
        createElementNS: (ns, tag) => new FakeElement(tag),
        createElement: (tag) => new FakeElement(tag),
        getElementById: (id) => [...root.all()].find(element => element.id === id) || null,
        querySelector: () => null,      // no workspace: nru_waitForWorkspaceChanges resolves at once
        contains: (element) => [...root.all()].includes(element),
        listeners: {},
    };
    document.addEventListener = FakeElement.prototype.addEventListener.bind(document);
    document.removeEventListener = FakeElement.prototype.removeEventListener.bind(document);
    document.dispatch = (type, props) => FakeElement.prototype.dispatch.call(document, type, props);

    // Make the <g> of a node, as the editor draws it: a rect and a status label
    const makeNodeElement = (id, transform) => {
        const nodeGroup = new FakeElement('g');
        nodeGroup.setAttribute('id', id);
        if (transform) nodeGroup.setAttribute('transform', transform);
        const nodeRect = new FakeElement('rect');
        nodeRect.setAttribute('width', 100);
        nodeRect.setAttribute('height', 30);
        const statusLabel = new FakeElement('text');
        statusLabel.setAttribute('class', 'red-ui-flow-node-status-label');
        nodeGroup.append(nodeRect, statusLabel);
        return nodeGroup;
    };

    const nodes = nodeOptions.map((options, index) => {
        const node = {
            id: 'n' + (index + 1), z: 't1', type: 'popup-node', name: options.name ?? 'Node ' + (index + 1),
            _def: { color: '#a6bbcf', defaults: { nru_popupConfig: { value: { width: 200, height: 120, autoCloseTime: 0, ...options.config } } } },
        };
        if (options.saved) node.nru_popupConfig = options.saved;
        nodeLayer.appendChild(makeNodeElement(node.id, options.transform));
        return node;
    });

    const store = { ...local };
    const events = {};
    const labels = {};
    const RED = {
        settings: { getLocal: (key) => store[key], setLocal: (key, value) => { store[key] = value; } },
        events: { on: (name, handler) => { (events[name] ??= []).push(handler); } },
        nodes: {
            filterNodes: ({ z }) => nodes.filter(node => node.z === z),
            node: (id) => nodes.find(node => node.id === id),
            dirty() {},
        },
        view: { scale: () => 1 },
        utils: { getNodeLabel: (node, fallback) => { if (labels.throw) throw new Error('no label'); return labels[node.id] ?? node.name ?? fallback; } },
        notify() {},
        workspaces: { active: () => 't1' },
    };
    const media = { matches: reduceMotion };
    const window = { matchMedia: () => media };
    // Each observer is kept, so that a test can change an attribute and call the callback
    const observers = [];
    class MutationObserver {
        constructor(callback) { this.callback = callback; this.target = null; this.connected = false; observers.push(this); }
        observe(target, options) { this.target = target; this.options = options; this.connected = true; }
        disconnect() { this.connected = false; }
    }
    const context = { window, document, RED, MutationObserver, console: { ...console, warn() {} }, setTimeout, clearTimeout, Promise, Map, Set, JSON, Math };
    vm.runInNewContext(SCRIPT, context);
    const reload = () => vm.runInNewContext(SCRIPT, context);

    for (const handler of events['workspace:change']) await handler({ old: 0, workspace: 't1' });
    for (let i = 0; i < 5; i++) await new Promise(setImmediate);

    const part = (node, name) => document.getElementById('nru_popup.' + node.id + '.' + name);
    const wire = (node) => document.getElementById('nru_popup.' + node.id + '.group').children
        .filter(element => element.tagName === 'path');
    return { document, root, nodeLayer, observers, makeNodeElement, nodes, store, events, labels, window, media, part, wire, reload };
};

describe('popup editor script', () => {
    it('gives each popup a title bar, a title and a close button', async () => {
        const { nodes, part } = await load({ nodes: [{ name: 'Temperature' }, { name: 'Pressure' }] });
        for (const node of nodes) {
            for (const name of ['header', 'title', 'close', 'statusBar', 'resizeHandle']) assert.ok(part(node, name), `${node.id}.${name}`);
        }
        assert.equal(part(nodes[0], 'title').textContent, 'Temperature');
        assert.equal(part(nodes[1], 'title').textContent, 'Pressure');
    });

    it('puts the content area under the title bar', async () => {
        const { nodes, part } = await load();
        assert.equal(part(nodes[0], 'foreignObject').getAttribute('y'), '28');
        assert.equal(part(nodes[0], 'foreignObject').getAttribute('height'), String(120 - 22 - 20 - 12));
    });

    it('makes a popup lower than 70 px 70 px high', async () => {
        const { nodes, part } = await load({ nodes: [{ config: { height: 40 } }] });
        assert.equal(part(nodes[0], 'rect').getAttribute('height'), '70');
    });

    it('setTitle() uses the label of the node and falls back to the name', async () => {
        const { nodes, part, labels } = await load({ nodes: [{ name: 'Alarms' }] });
        const title = part(nodes[0], 'title');
        labels.n1 = 'Alarm level';
        title.setTitle();
        assert.equal(title.textContent, 'Alarm level');
        labels.throw = true;
        title.setTitle();
        assert.equal(title.textContent, 'Alarms');
    });

    it('updates the title on nodes:change', async () => {
        const { nodes, part, labels, events } = await load();
        labels.n1 = 'Renamed';
        for (const handler of events['nodes:change']) handler(nodes[0]);
        assert.equal(part(nodes[0], 'title').textContent, 'Renamed');
    });

    it('registers one nodes:change handler for all popups', async () => {
        const { nodes, events, reload } = await load({ nodes: [{}, {}] });
        assert.equal(events['nodes:change'].length, 1);
        for (const handler of events['nodes:add']) await handler(nodes[1]);
        for (const handler of events['deploy']) await handler();
        reload();
        assert.equal(events['nodes:change'].length, 1);
    });

    it('a click on the close button closes the popup and removes its id from local storage', async () => {
        const { nodes, part, store, window } = await load({ local: { nru_popupOpen: '["n1"]' } });
        assert.equal(part(nodes[0], 'group').style.display, 'block');
        part(nodes[0], 'close').dispatch('click');
        assert.equal(window.popupStates.n1, 'closed');
        assert.deepEqual(JSON.parse(store.nru_popupOpen), []);
    });

    it('a drag on the title bar moves the popup and saves x and y', async () => {
        const { nodes, part, document } = await load();
        part(nodes[0], 'header').dispatch('mousedown', { clientX: 10, clientY: 10 });
        document.dispatch('mousemove', { clientX: 40, clientY: 25 });
        document.dispatch('mouseup');
        assert.equal(nodes[0].nru_popupConfig.x, 30);
        assert.equal(nodes[0].nru_popupConfig.y, 65);
    });

    it('starts the wire at the bottom middle of the node when the popup is below', async () => {
        const { nodes, wire } = await load({ nodes: [{ config: { x: 0, y: 50 } }] });
        const paths = wire(nodes[0]);
        assert.equal(paths.length, 2);
        assert.match(paths[1].getAttribute('d'), /^M50,30 C/);
        assert.equal(paths[0].getAttribute('d'), paths[1].getAttribute('d'));
    });

    it('starts the wire at the top middle of the node when the popup is above', async () => {
        const { nodes, wire } = await load({ nodes: [{ config: { x: 150, y: -150 } }] });
        assert.match(wire(nodes[0])[1].getAttribute('d'), /^M50,0 C/);
    });

    it('draws the wire in on open', async () => {
        const { nodes, part, wire } = await load();
        part(nodes[0], 'close').dispatch('click');     // closed first, so that a click on the node opens it
        const before = wire(nodes[0])[1].animations.length;
        await openByClick(part, nodes[0]);
        assert.ok(wire(nodes[0])[1].animations.length > before);
    });

    it('does not animate the wire with reduced motion', async () => {
        const { nodes, part, wire } = await load({ reduceMotion: true });
        await openByClick(part, nodes[0]);
        assert.equal(wire(nodes[0])[1].animations.length, 0);
        assert.equal(wire(nodes[0])[0].animations.length, 0);
    });

    it('a drag on the status bar moves the popup, saves x and y, and sets the cursor back to grab', async () => {
        const { nodes, part, document } = await load();
        const statusBar = part(nodes[0], 'statusBar');
        statusBar.dispatch('mousedown', { clientX: 10, clientY: 10 });
        assert.equal(statusBar.style.cursor, 'grabbing');
        document.dispatch('mousemove', { clientX: 40, clientY: 25 });
        document.dispatch('mouseup');
        assert.equal(statusBar.style.cursor, 'grab');
        assert.equal(nodes[0].nru_popupConfig.x, 30);
        assert.equal(nodes[0].nru_popupConfig.y, 65);
    });

    it('sets the cursor of the title bar back to grab after a drag', async () => {
        const { nodes, part, document } = await load();
        const header = part(nodes[0], 'header');
        header.dispatch('mousedown', { clientX: 10, clientY: 10 });
        assert.equal(header.style.cursor, 'grabbing');
        document.dispatch('mouseup');
        assert.equal(header.style.cursor, 'grab');
    });

    it('the wire follows the popup during a drag', async () => {
        const { nodes, part, document, wire } = await load();
        const before = wire(nodes[0])[1].getAttribute('d');
        part(nodes[0], 'header').dispatch('mousedown', { clientX: 10, clientY: 10 });
        document.dispatch('mousemove', { clientX: 80, clientY: 60 });
        const after = wire(nodes[0])[1].getAttribute('d');
        document.dispatch('mouseup');
        assert.notEqual(after, before);
        assert.equal(wire(nodes[0])[0].getAttribute('d'), after);
    });

    it('a mousedown on the close button stops the event and does not start a move', async () => {
        const { nodes, part, document } = await load();
        let stopped = false, prevented = false;
        part(nodes[0], 'close').dispatch('mousedown', {
            clientX: 10, clientY: 10, stopPropagation() { stopped = true; }, preventDefault() { prevented = true; },
        });
        document.dispatch('mousemove', { clientX: 80, clientY: 60 });
        document.dispatch('mouseup');
        assert.ok(stopped);
        assert.ok(prevented);
        assert.equal(nodes[0].nru_popupConfig, undefined);
    });

    it('shows the hover circle of the close button on mouseenter and hides it on mouseleave', async () => {
        const { nodes, part } = await load();
        const hover = [...part(nodes[0], 'group').all()].find(element => element.tagName === 'circle' && element.getAttribute('r') === '8');
        assert.equal(hover.getAttribute('r'), '8');
        assert.equal(hover.style.display, 'none');
        part(nodes[0], 'close').dispatch('mouseenter');
        assert.equal(hover.style.display, 'block');
        part(nodes[0], 'close').dispatch('mouseleave');
        assert.equal(hover.style.display, 'none');
    });

    it('a click on the close button stops the auto close timer', async () => {
        const { nodes, part, wire } = await load({ nodes: [{ config: { autoCloseTime: 400 } }] });
        await openByClick(part, nodes[0]);              // opens at 250 ms; the timer closes it at 650 ms
        part(nodes[0], 'close').dispatch('click');
        const count = wire(nodes[0])[1].animations.length;
        await new Promise(resolve => setTimeout(resolve, 500));
        assert.equal(wire(nodes[0])[1].animations.length, count, 'the old timer closed the popup again');
    });

    it('retracts the wire in 120 ms on close', async () => {
        const { nodes, part, wire } = await load({ local: { nru_popupOpen: '["n1"]' } });
        part(nodes[0], 'close').dispatch('click');
        for (const path of wire(nodes[0])) assert.equal(path.animations.at(-1).options.duration, 120);
        const cardDot = part(nodes[0], 'group').children.filter(element => element.tagName === 'circle').at(-1);
        assert.equal(cardDot.animations.at(-1).options.duration, 120);
    });

    it('clears the dasharray of the wire when the animation finishes', async () => {
        const { nodes, part, wire } = await load();
        await openByClick(part, nodes[0]);
        for (const path of wire(nodes[0])) {
            assert.equal(path.style.strokeDasharray, 100);
            path.animations.at(-1).onfinish();
            assert.equal(path.style.strokeDasharray, '');
        }
    });

    it('clears the dasharray of the wire when an animation is cancelled with reduced motion', async () => {
        const { nodes, part, wire, media } = await load();
        await openByClick(part, nodes[0]);
        media.matches = true;
        part(nodes[0], 'close').dispatch('click');
        for (const path of wire(nodes[0])) assert.equal(path.style.strokeDasharray, '');
    });

    it('gives the popup a glow in the node colour', async () => {
        const { nodes, part } = await load();
        assert.match(part(nodes[0], 'group').style.filter, /color-mix\(in srgb, #a6bbcf 35%, transparent\)/);
    });

    it('does not resize the popup lower than 70 px', async () => {
        const { nodes, part, document } = await load();
        part(nodes[0], 'resizeHandle').dispatch('mousedown', { clientX: 0, clientY: 0 });
        document.dispatch('mousemove', { clientX: 0, clientY: -200 });
        document.dispatch('mouseup');
        assert.equal(part(nodes[0], 'rect').getAttribute('height'), '70');
        assert.equal(nodes[0].nru_popupConfig.height, 70);
    });

    describe('popup layer', () => {
        const layerOf = (document) => document.getElementById('nru_popup.layer');

        it('puts each popup in the popup layer, directly after the node layer', async () => {
            const { nodes, part, document, root, nodeLayer } = await load({ nodes: [{}, {}] });
            const layer = layerOf(document);
            assert.ok(layer);
            assert.equal(layer.parentNode, root);
            assert.equal(nodeLayer.nextSibling, layer);
            for (const node of nodes) {
                assert.equal(part(node, 'group').parentNode, layer);
                assert.ok(!document.getElementById(node.id).children.includes(part(node, 'group')));
            }
        });

        it('keeps the layer after the node layer when the editor re-orders or adds node elements', async () => {
            const { nodes, part, document, nodeLayer, makeNodeElement } = await load({ nodes: [{}, {}] });
            nodeLayer.insertBefore(document.getElementById('n2'), document.getElementById('n1'));
            nodeLayer.appendChild(makeNodeElement('n3'));
            const layer = layerOf(document);
            assert.equal(nodeLayer.nextSibling, layer);
            assert.deepEqual(layer.children, [part(nodes[0], 'group'), part(nodes[1], 'group')]);
        });

        it('takes the transform of the node and follows the node when it moves', async () => {
            const { nodes, part, document, observers } = await load({ nodes: [{ transform: 'translate(100,200)' }] });
            const group = part(nodes[0], 'group');
            assert.equal(group.getAttribute('transform'), 'translate(100,200)');
            const nodeElement = document.getElementById('n1');
            const observer = observers.find(o => o.target === nodeElement && o.connected);
            assert.deepEqual([...observer.options.attributeFilter], ['transform']);
            nodeElement.setAttribute('transform', 'translate(300,50)');
            observer.callback([]);
            assert.equal(group.getAttribute('transform'), 'translate(300,50)');
        });

        it('puts the popup opened last at the end of the layer and does not move the node elements', async () => {
            const { nodes, part, document, nodeLayer } = await load({ nodes: [{}, {}] });
            const nodeOrder = [...nodeLayer.children];
            await openByClick(part, nodes[1]);
            await openByClick(part, nodes[0]);
            assert.equal(layerOf(document).children.at(-1), part(nodes[0], 'group'));
            await openByClick(part, nodes[0]);      // close n1
            await openByClick(part, nodes[0]);      // open n1 again: it stays last
            assert.equal(layerOf(document).children.at(-1), part(nodes[0], 'group'));
            await openByClick(part, nodes[1]);      // close n2
            await openByClick(part, nodes[1]);      // open n2 again: now it is last
            assert.equal(layerOf(document).children.at(-1), part(nodes[1], 'group'));
            assert.deepEqual(nodeLayer.children, nodeOrder);
        });

        it('removes the popup and stops the observer on nodes:remove', async () => {
            const { nodes, part, document, events, observers } = await load({ nodes: [{}, {}] });
            const group = part(nodes[0], 'group');
            const observer = observers.find(o => o.target === document.getElementById('n1'));
            for (const handler of events['nodes:remove']) handler(nodes[0]);
            assert.equal(part(nodes[0], 'group'), null);
            assert.equal(group.parentNode, null);
            assert.equal(observer.connected, false);
            assert.ok(part(nodes[1], 'group'));
        });

        it('removes the popups and stops the observers on a change of the tab', async () => {
            const { nodes, part, document, events, observers } = await load({ nodes: [{}, {}] });
            for (const handler of events['workspace:change']) await handler({ old: 't1', workspace: 't2' });
            for (let i = 0; i < 5; i++) await new Promise(setImmediate);
            for (const node of nodes) assert.equal(part(node, 'group'), null);
            assert.deepEqual(layerOf(document).children, []);
            assert.ok(observers.every(o => !o.connected));
        });

        it('removes a popup whose node element is gone when popups are added', async () => {
            const { nodes, part, document, events, observers } = await load({ nodes: [{}, {}] });
            const group = part(nodes[1], 'group');
            const observer = observers.find(o => o.target === document.getElementById('n2'));
            document.getElementById('n2').remove();
            nodes.pop();        // the editor removed n2 without nodes:remove
            for (const handler of events['deploy']) await handler();
            assert.equal(group.parentNode, null);
            assert.equal(observer.connected, false);
            assert.deepEqual(layerOf(document).children, [part(nodes[0], 'group')]);
        });

        it('makes a new popup on deploy when the editor replaced the node element', async () => {
            const { nodes, part, document, events, nodeLayer, makeNodeElement } = await load();
            const oldGroup = part(nodes[0], 'group');
            document.getElementById('n1').remove();
            const newElement = nodeLayer.appendChild(makeNodeElement('n1', 'translate(5,6)'));
            for (const handler of events['deploy']) await handler();
            const group = part(nodes[0], 'group');
            assert.notEqual(group, oldGroup);
            assert.equal(group.nru_nodeElement, newElement);
            assert.equal(group.getAttribute('transform'), 'translate(5,6)');
            assert.deepEqual(layerOf(document).children, [group]);
        });

        it('makes a new popup when the node element is replaced and the old popup is still there', async () => {
            const { nodes, part, document, events, nodeLayer, makeNodeElement, observers } = await load();
            const oldGroup = part(nodes[0], 'group');
            const oldObserver = observers.find(o => o.target === document.getElementById('n1'));
            document.getElementById('n1').remove();
            const newElement = nodeLayer.appendChild(makeNodeElement('n1'));
            for (const handler of events['nodes:add']) await handler(nodes[0]);
            assert.equal(oldGroup.parentNode, null);
            assert.equal(oldObserver.connected, false);
            assert.equal(part(nodes[0], 'group').nru_nodeElement, newElement);
        });

        it('stops the auto close timer of a popup that a deploy removes', async () => {
            const { nodes, part, events, window } = await load({ nodes: [{ config: { autoCloseTime: 200 } }] });
            await openByClick(part, nodes[0]);          // opens at 250 ms; the timer closes it at 450 ms
            for (const handler of events['deploy']) await handler();
            await new Promise(resolve => setTimeout(resolve, 300));
            assert.equal(window.popupStates.n1, 'open', 'the timer of the removed popup closed it');
            assert.equal(part(nodes[0], 'group').style.display, 'block');
        });

        it('stops the click timer of a popup that nodes:remove removes', async () => {
            const { nodes, part, events, window, store } = await load();
            const nodeRect = part(nodes[0], 'group').nru_nodeElement.querySelector('rect');
            nodeRect.dispatch('mousedown');
            nodeRect.dispatch('click');                 // the popup would open at 250 ms
            for (const handler of events['nodes:remove']) handler(nodes[0]);
            await new Promise(resolve => setTimeout(resolve, 300));
            assert.equal(window.popupStates.n1, undefined);
            assert.equal(store.nru_popupOpen, undefined);
        });

        it('puts a popup that stays open after a refresh in the layer', async () => {
            const { nodes, part, document } = await load({ local: { nru_popupOpen: '["n1"]' } });
            assert.equal(part(nodes[0], 'group').parentNode, layerOf(document));
            assert.equal(part(nodes[0], 'group').style.display, 'block');
        });
    });
});

// A click on the node opens its popup after the double-click delay of 250 ms
const openByClick = async (part, node) => {
    const nodeRect = part(node, 'group').nru_nodeElement.querySelector('rect');
    nodeRect.dispatch('mousedown');
    nodeRect.dispatch('click');
    await new Promise(resolve => setTimeout(resolve, 300));
};
