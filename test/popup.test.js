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
    getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
    appendChild(child) {
        child.parentNode?.children.splice(child.parentNode.children.indexOf(child), 1);
        child.parentNode = this;
        this.children.push(child);
        return child;
    }
    append(...children) { for (const child of children) this.appendChild(child); }
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
    const root = new FakeElement('svg');
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

    const nodes = nodeOptions.map((options, index) => {
        const node = {
            id: 'n' + (index + 1), z: 't1', type: 'popup-node', name: options.name ?? 'Node ' + (index + 1),
            _def: { color: '#a6bbcf', defaults: { nru_popupConfig: { value: { width: 200, height: 120, autoCloseTime: 0, ...options.config } } } },
        };
        if (options.saved) node.nru_popupConfig = options.saved;
        const nodeGroup = new FakeElement('g');
        nodeGroup.setAttribute('id', node.id);
        const nodeRect = new FakeElement('rect');
        nodeRect.setAttribute('width', 100);
        nodeRect.setAttribute('height', 30);
        const statusLabel = new FakeElement('text');
        statusLabel.setAttribute('class', 'red-ui-flow-node-status-label');
        nodeGroup.append(nodeRect, statusLabel);
        root.appendChild(nodeGroup);
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
    class MutationObserver { observe() {} disconnect() {} }
    vm.runInNewContext(SCRIPT, { window, document, RED, MutationObserver, console: { ...console, warn() {} }, setTimeout, clearTimeout, Promise, Map, Set, JSON, Math });

    for (const handler of events['workspace:change']) await handler({ old: 0, workspace: 't1' });
    for (let i = 0; i < 5; i++) await new Promise(setImmediate);

    const part = (node, name) => document.getElementById('nru_popup.' + node.id + '.' + name);
    const wire = (node) => document.getElementById('nru_popup.' + node.id + '.group').children
        .filter(element => element.tagName === 'path');
    return { document, nodes, store, events, labels, window, media, part, wire };
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
});

// A click on the node opens its popup after the double-click delay of 250 ms
const openByClick = async (part, node) => {
    const nodeRect = part(node, 'group').parentNode.querySelector('rect');
    nodeRect.dispatch('mousedown');
    nodeRect.dispatch('click');
    await new Promise(resolve => setTimeout(resolve, 300));
};
