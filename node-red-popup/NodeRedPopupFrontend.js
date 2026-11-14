/**
 * Copyright 2024 Contributors
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

//
//  Begin waitForWorkspaceChange
//
//  Helper function to wait for NodeRed to update the workspace because it sends out
//  'workspace:change' event BEFORE it draws stuff.
//  This just watches the workspace and resolves if no activity for xxxx ms.
//
if (!window.nru_waitForWorkspaceChanges) {

    window.nru_waitForWorkspaceChanges = function (quietPeriod = 100) { 
        return new Promise((resolve) => {

            const observer = new MutationObserver((mutations) => {
                if (timeoutId) { clearTimeout(timeoutId) }
                
                timeoutId = setTimeout(() => { // Once we've had no changes for the quiet period, clean up and resolve
                    observer.disconnect();
                    resolve();
                }, quietPeriod);
            });

            let timeoutId = null;

            const workspace = document.querySelector("#red-ui-workspace");  // Get the workspace container
            if (!workspace) {
                console.warn("nru_waitForWorkspaceChanges: Workspace element not found");
                resolve(); // Resolve immediately if we can't find the workspace
                return;
            }

            // Configure and start the observer
            observer.observe(workspace, {
                childList: true,     // Watch for added/removed nodes
                subtree: true,       // Watch all descendants
                attributes: true     // Watch for attribute changes
            });
        });
    }
}





//
//  Begin DOM Event Tracker
//
//  This is needed since NodeRED will delete our Workspace elements
//  without cleaning up events we may have added.  Modern browser garbage collectors
//  should work but we'll help it out to ensure no memory leaks by deleting any events we create.
//

if (!window.DOMEventTracker) {   // just declare the class once

    window.DOMEventTracker = class EventTracker {

        constructor() {
            this.listeners = new Map();
            this.counter = 0;
        }

        // Add an event listener and track it
        addListener(element, eventType, handler, options = false) {
            const id = this.counter++;
            element.addEventListener(eventType, handler, options);
            
            this.listeners.set(id, {
                element,
                eventType,
                handler,
                options
            });
            
            return id;
        }

        // Remove a specific listener by its ID
        removeListener(id) {
            const listener = this.listeners.get(id);
            if (listener) {
                const { element, eventType, handler, options } = listener;
                element.removeEventListener(eventType, handler, options);
                this.listeners.delete(id);
            }
        }

        // Remove all listeners
        removeAllListeners() {
            this.listeners.forEach((listener, id) => {
                const { element, eventType, handler, options } = listener;
                element.removeEventListener(eventType, handler, options);
            });
            this.listeners.clear();
        }

        // Check for and remove listeners for deleted elements
        cleanupDeletedElements() {
            this.listeners.forEach((listener, id) => {
                if (!document.contains(listener.element)) {
                    this.listeners.delete(id);
                }
            });
        }
    }

}


//
// Begin Popup Support
//

if (!window.popupInited) {

    window.popupInited = true;
    window.popupStates = {};
    // Popups that are open stay open after a browser refresh. The ids are kept in the browser's local storage.
    // Popups that close by themselves (autoCloseTime) are not kept.
    const OPEN_KEY = 'nru_popupOpen';
    const openIds = () => JSON.parse(RED.settings.getLocal(OPEN_KEY) || '[]');
    const keepOpen = (ids) => RED.settings.setLocal(OPEN_KEY, JSON.stringify(ids));
    for (const id of openIds()) window.popupStates[id] = 'open';
    RED.events.on('flows:loaded', () => keepOpen(openIds().filter(id => RED.nodes.node(id))));   // forget deleted nodes
    window.popupEventTracker = new window.DOMEventTracker();

    // Stop following the node, stop the timers and the animations of the popup, and remove the popup
    const removePopupGroup = (group) => {
        group.nru_observer?.disconnect();
        group.nru_dispose?.();
        group.remove();
    };

    const removePopups = async (workspace) => {
        window.popupEventTracker.removeAllListeners();
        RED.nodes.filterNodes( {z:workspace} ).forEach ( node => {
            const group = document.getElementById('nru_popup.' + node.id + '.group');
            if (group) removePopupGroup(group);
        });
    }

    const addPopups = async (workspace) => {
        await window.nru_waitForWorkspaceChanges(100);
        // Remove the popups of node elements that the editor removed
        const layer = document.getElementById('nru_popup.layer');
        for (const group of [...(layer?.children || [])]) {
            if (!group.nru_nodeElement?.isConnected) removePopupGroup(group);
        }
        RED.nodes.filterNodes( {z:workspace} ).forEach ( async node => {
            createPopup( node );
        });
    }

    const addPopup = async (node) => {
        await window.nru_waitForWorkspaceChanges(100);
        createPopup(node);
    }

    // Smallest popup size in pixels. Smaller sizes are made this size.
    const MIN_WIDTH = 100, MIN_HEIGHT = 70;
    // Where a popup sits under its node until the user moves it
    const DEFAULT_X = 0, DEFAULT_Y = 50;
    // Look of the card: the radius of the corners, the height of the title bar and of the status bar,
    // and the space at the right of the status bar that the text must not use (move dots and resize lines)
    let clipCount = 0;
    const CORNER = 8, HEADER_HEIGHT = 22, STATUS_HEIGHT = 20, STATUS_TEXT_MARGIN = 48;
    // The space at the right of the title bar that the title must not use (the close button)
    const TITLE_MARGIN = 30;
    const warnedTypes = new Set();
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const SVG_NS = "http://www.w3.org/2000/svg";

    // All popups are in one layer. The layer comes directly after the editor's node layer, so a popup
    // is above every node and wire. The layer is in the event layer, so it takes the canvas zoom.
    const popupLayer = (nodeElement) => {
        let layer = document.getElementById('nru_popup.layer');
        if (layer) return layer;
        const nodeLayer = nodeElement.parentNode;
        layer = document.createElementNS(SVG_NS, 'g');
        layer.setAttribute('id', 'nru_popup.layer');
        nodeLayer.parentNode.insertBefore(layer, nodeLayer.nextSibling);
        return layer;
    };

    const createPopup = async ( node ) => {

        if (!node?._def?.defaults?.nru_popupConfig?.value) return;

        // The node's own config (saved after a resize) wins over the default of the type
        const config = { ...node._def.defaults.nru_popupConfig.value, ...node.nru_popupConfig };
        config.x ??= DEFAULT_X;
        config.y ??= DEFAULT_Y;
        const problem = ['width', 'height', 'autoCloseTime', 'x', 'y']
            .find(key => !Number.isFinite(config[key]) || (config[key] < 0 && !['x', 'y'].includes(key)));
        if (problem) {
            const rule = ['x', 'y'].includes(problem) ? 'a number' : 'a number, 0 or more';
            console.error(`Popup of node ${node.id}: nru_popupConfig.${problem} must be ${rule}; got`, config[problem]);
            if (!warnedTypes.has(node.type)) {
                warnedTypes.add(node.type);
                RED.notify(`No popup for "${node.type}" nodes: nru_popupConfig.${problem} must be ${rule}.`, 'warning');
            }
            return;
        }
                
        // Exit if already added bc we are getting multiple workspace change events or something.
        // The editor can replace the element of a node on a deploy. Then the old popup is removed and a new one is made.
        const existing = document.getElementById("nru_popup." + node.id + ".group");
        if (existing) {
            if (existing.nru_nodeElement === document.getElementById(node.id)) return;
            removePopupGroup(existing);
        }

        // Just in case we got here without NodeRED being finished adding nodes to the workspace
        if (!document.getElementById(node.id)) return;

        const rectElement = document.getElementById(node.id).querySelector('rect');
        if(!rectElement) return;

        const width = Math.max(MIN_WIDTH, config.width);
        const height = Math.max(MIN_HEIGHT, config.height);
        const autoCloseTime = config.autoCloseTime;

        const svgElement = document.getElementById(node.id);
        const accent = node._def.color || '#999';       // the popup wears the color of its node
        const lineColor = `color-mix(in srgb, ${accent} 65%, #000)`;     // light node colors would not show on the canvas
        const theme = (name, fallback) => `var(--red-ui-${name}, ${fallback})`;     // follows the light and dark editor themes
        const make = (tag, attrs = {}) => {
            const element = document.createElementNS(SVG_NS, tag);
            for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
            return element;
        };

        let group = make("g", { id: "nru_popup." + node.id + ".group" });
        group.style.display = (window.popupStates[node.id] === 'open') ? 'block' : 'none';
        // A thin neutral shadow, and a soft glow in the color of the node. The glow does not change.
        group.style.filter = `drop-shadow(0 1px 1px rgba(0, 0, 0, 0.25)) drop-shadow(0 8px 18px color-mix(in srgb, ${accent} 35%, transparent))`;

        // The body holds everything that is drawn. It unfurls from the node on open, so the
        // group keeps its own transform and display.
        const frame = make("g", { transform: `translate(${config.x}, ${config.y})` });   // the position of the popup
        const clipId = 'nru_popup_clip_' + (clipCount++);     // not made from the node id: an id with a space would break url()
        const gradientId = clipId + '_header';
        const body = make("g", { "clip-path": `url(#${clipId})` });     // rounded corners
        body.style.transformOrigin = (parseFloat(rectElement.getAttribute('width')) / 2) + "px 0px";

        const clipRect = make("rect", { x: 0, y: 0, rx: CORNER });
        const clipPath = make("clipPath", { id: clipId });
        clipPath.appendChild(clipRect);

        const rect = make("rect", { id: "nru_popup." + node.id + ".rect", x: 0, y: 0, rx: CORNER });
        rect.style.fill = theme('secondary-background', '#fff');

        // The title bar shows the label of the node. It is a handle to move the popup, and it has a close button.
        const gradient = make("linearGradient", { id: gradientId, x1: 0, y1: 0, x2: 1, y2: 0 });
        const gradientStart = make("stop", { offset: 0 });
        gradientStart.style.stopColor = accent;
        const gradientEnd = make("stop", { offset: 1 });
        gradientEnd.style.stopColor = `color-mix(in srgb, ${accent} 75%, #fff)`;
        gradient.append(gradientStart, gradientEnd);
        const header = make("rect", { id: "nru_popup." + node.id + ".header", x: 0, y: 0, height: HEADER_HEIGHT, fill: `url(#${gradientId})` });
        header.style.cursor = 'grab';
        const headerLine = make("rect", { x: 0, y: HEADER_HEIGHT - 1, height: 1 });
        headerLine.style.fill = lineColor;
        headerLine.style.pointerEvents = 'none';

        const title = make("text", { id: "nru_popup." + node.id + ".title", x: 8, y: 15, "font-family": "Arial, Helvetica, sans-serif", "font-size": 11 });
        title.style.fill = theme('node-label-color', '#333');
        title.style.stroke = 'none';      // else the text takes the outline of the node and looks blurred
        title.style.pointerEvents = 'none';     // so that a drag on the title moves the popup
        title.fullText = '';
        title.setTitle = function () {
            let label;
            try {
                label = RED.utils.getNodeLabel(node, node.type);
            } catch (error) {
                label = node.name || node.type;
            }
            title.textContent = label;
            title.fullText = label;
            sizeTextToFit(title, parseFloat(rect.getAttribute('width')) - TITLE_MARGIN);
        };

        // The close button is a transparent square that catches the mouse. The cross and the circle only show it.
        const closeHover = make("circle", { r: 8, cy: HEADER_HEIGHT / 2 });
        closeHover.style.fill = 'rgba(0, 0, 0, 0.15)';
        closeHover.style.display = 'none';
        closeHover.style.pointerEvents = 'none';
        const closeCross = make("path", { d: "M-3.5,-3.5 L3.5,3.5 M3.5,-3.5 L-3.5,3.5", "stroke-width": 1.5, "stroke-linecap": "round" });
        closeCross.style.stroke = theme('node-label-color', '#333');
        closeCross.style.pointerEvents = 'none';
        const closeButton = make("rect", { id: "nru_popup." + node.id + ".close", y: 0, width: HEADER_HEIGHT, height: HEADER_HEIGHT, fill: "transparent" });
        closeButton.style.cursor = 'pointer';
        const outline = make("rect", { x: 0.5, y: 0.5, rx: CORNER, fill: "none" });
        outline.style.stroke = theme('primary-border-color', '#d4d4d4');
        outline.style.pointerEvents = 'none';    // else it takes the mouse from the status bar

        const foreignObject = make("foreignObject", { id: "nru_popup." + node.id + ".foreignObject", x: 6, y: HEADER_HEIGHT + 6 });
        const sourceText = svgElement.querySelector('.red-ui-flow-node-status-label');
        for (const attr of sourceText.attributes) {
            foreignObject.setAttribute(attr.name, attr.value)
        };
        foreignObject.setAttribute("x", "6");
        foreignObject.setAttribute("y", HEADER_HEIGHT + 6);

        let divElement = document.createElement("div");
        divElement.setAttribute("id", "nru_popup." + node.id + ".div");
        divElement.style.margin = "0";
        divElement.style.overflow = "auto";
        divElement.style.boxSizing = "border-box";
        divElement.style.color = theme('primary-text-color', '#222');
        foreignObject.appendChild(divElement);

        // The status bar is the handle to move the popup. Dots say so.
        const statusBar = make("rect", { id: "nru_popup." + node.id + ".statusBar", x: 0, height: STATUS_HEIGHT });
        statusBar.style.fill = theme('secondary-background-hover', '#e8e8e8');
        statusBar.style.stroke = theme('primary-border-color', '#d4d4d4');
        statusBar.style.cursor = 'grab';
        const moveDots = make("path", { d: "M0,-4 h0 M0,0 h0 M0,4 h0 M5,-4 h0 M5,0 h0 M5,4 h0", "stroke-width": 2, "stroke-linecap": "round" });
        moveDots.style.stroke = theme('secondary-text-color', '#555');
        moveDots.style.pointerEvents = 'none';

        // The resize handle is a square that catches the mouse; the lines on it only show where it is
        const resizeHandle = make("rect", { id: "nru_popup." + node.id + ".resizeHandle", width: 24, height: 24, fill: "transparent" });
        resizeHandle.style.stroke = 'none';
        resizeHandle.style.cursor = 'se-resize';
        const resizeLines = make("path", { "stroke-width": 1.5, "stroke-linecap": "round" });
        resizeLines.style.stroke = theme('secondary-text-color', '#555');
        resizeLines.style.pointerEvents = 'none';

        const statusText = make("text", { id: "nru_popup." + node.id + ".statusText", x: 8, "font-family": "Arial, Helvetica, sans-serif", "font-size": 10 });
        statusText.style.fill = theme('secondary-text-color', '#555');
        statusText.style.pointerEvents = 'none';   // so that a drag on the text moves the popup
        statusText.textContent = '';
        statusText.fullText = '';
        statusText.setStatusText = function( text ) {
            statusText.textContent = text;
            statusText.fullText = text;
            sizeTextToFit( statusText, parseInt(rect.getAttribute('width')) - STATUS_TEXT_MARGIN );
        };

        body.append(gradient, rect, header, headerLine, title, closeHover, closeCross, closeButton,
            statusBar, moveDots, statusText, foreignObject, outline, resizeLines, resizeHandle);
        frame.appendChild(body);

        // A curved wire ties the popup to its node, wherever the user puts it. A wide faint halo in the
        // node color lies under the wire. A dot marks each end of the wire.
        const halo = make("path", { fill: "none", "stroke-width": 6, "stroke-linecap": "round" });
        halo.style.stroke = accent;
        halo.style.opacity = 0.25;
        const tether = make("path", { fill: "none", "stroke-width": 2, "stroke-linecap": "round" });
        tether.style.stroke = lineColor;
        const anchor = make("circle", { r: 3.5 });
        anchor.style.fill = lineColor;
        const cardDot = make("circle", { r: 3 });
        cardDot.style.fill = lineColor;
        for (const element of [halo, tether, anchor, cardDot]) element.style.pointerEvents = 'none';
        group.append(clipPath, halo, tether, anchor, cardDot, frame);
        // The group is not in the node. It takes the transform of the node, and follows it when the node moves.
        const followNode = () => {
            const transform = svgElement.getAttribute('transform');
            if (transform === null) group.removeAttribute('transform');
            else group.setAttribute('transform', transform);
        };
        followNode();
        group.nru_observer = new MutationObserver(followNode);
        group.nru_observer.observe(svgElement, { attributes: true, attributeFilter: ['transform'] });
        group.nru_nodeElement = svgElement;
        popupLayer(svgElement).appendChild(group);

        // The wire starts at the bottom middle of the node, or at the top middle when the popup is above
        // the node. It ends at the nearest point of the popup. At each end it leaves the edge at a right angle.
        let popupX = config.x, popupY = config.y;
        const placeTether = () => {
            const nodeMidX = parseFloat(rectElement.getAttribute('width')) / 2;
            const nodeHeight = parseFloat(rectElement.getAttribute('height'));
            const popupWidth = parseFloat(rect.getAttribute('width'));
            const popupHeight = parseFloat(rect.getAttribute('height'));
            const above = popupY + popupHeight / 2 < nodeHeight / 2;
            const startX = nodeMidX, startY = above ? 0 : nodeHeight, startNormal = above ? -1 : 1;
            const endX = Math.min(Math.max(startX, popupX), popupX + popupWidth);
            const endY = Math.min(Math.max(startY, popupY), popupY + popupHeight);
            // The outward normal of the popup edge that the wire meets. The larger gap gives the edge.
            const gapX = endX - startX, gapY = endY - startY;
            let endNormalX = 0, endNormalY = above ? 1 : -1;
            if (Math.abs(gapY) >= Math.abs(gapX) && gapY !== 0) endNormalY = gapY > 0 ? -1 : 1;
            else if (gapX !== 0) [endNormalX, endNormalY] = [gapX > 0 ? -1 : 1, 0];
            const k = Math.min(Math.max(Math.hypot(gapX, gapY) / 2, 12), 60);     // how far the curve goes out
            const d = `M${startX},${startY} C${startX},${startY + startNormal * k} `
                + `${endX + endNormalX * k},${endY + endNormalY * k} ${endX},${endY}`;
            halo.setAttribute("d", d);
            tether.setAttribute("d", d);
            anchor.setAttribute("cx", startX);
            anchor.setAttribute("cy", startY);
            cardDot.setAttribute("cx", endX);
            cardDot.setAttribute("cy", endY);
        };

        // Put every part at the right place for a popup of this size
        const layout = (w, h) => {
            for (const element of [rect, clipRect, statusBar]) element.setAttribute('width', w);
            for (const element of [rect, clipRect]) element.setAttribute('height', h);
            outline.setAttribute('width', w - 1);
            outline.setAttribute('height', h - 1);
            header.setAttribute('width', w);
            headerLine.setAttribute('width', w);
            closeButton.setAttribute('x', w - HEADER_HEIGHT);
            closeHover.setAttribute('cx', w - HEADER_HEIGHT / 2);
            closeCross.setAttribute('transform', `translate(${w - HEADER_HEIGHT / 2}, ${HEADER_HEIGHT / 2})`);
            if (title.fullText) sizeTextToFit(title, w - TITLE_MARGIN);
            statusBar.setAttribute('y', h - STATUS_HEIGHT);
            statusText.setAttribute('y', h - 6);
            moveDots.setAttribute('transform', `translate(${w - 40}, ${h - STATUS_HEIGHT / 2})`);
            foreignObject.setAttribute('width', w - 12);
            const contentHeight = h - HEADER_HEIGHT - STATUS_HEIGHT - 12;   // total height - title bar - status bar - top and bottom padding
            foreignObject.setAttribute('height', contentHeight);
            divElement.style.width = (w - 12) + 'px';
            divElement.style.height = contentHeight + 'px';
            resizeHandle.setAttribute('x', w - 24);
            resizeHandle.setAttribute('y', h - 24);
            resizeLines.setAttribute('d', [6, 10, 14].map(k => `M${w - 4},${h - k} L${w - k},${h - 4}`).join(' '));
            placeTether();
        };
        layout(width, height);

        // The size and position go into the node, so they are saved with the flow
        const saveConfig = () => {
            node.nru_popupConfig = {
                width: parseFloat(rect.getAttribute('width')),
                height: parseFloat(rect.getAttribute('height')),
                autoCloseTime: autoCloseTime,
                x: popupX,
                y: popupY
            };
            node.changed = true;
            RED.nodes.dirty(true);
        };

        // Resize functionality
        function sizeTextToFit( svgTextObject, width ) {
            while ( svgTextObject.getBBox().width < width - 5 && svgTextObject.textContent.length !== svgTextObject.fullText.length ) {
                svgTextObject.textContent = svgTextObject.fullText.slice(0, svgTextObject.textContent.length + 1);
            }
            while ( svgTextObject.getBBox().width > width - 5 && svgTextObject.textContent !== '') {
                svgTextObject.textContent = svgTextObject.fullText.slice( 0, svgTextObject.textContent.length - 1);
            }
        }

        //---------------------------------------------------------------------------------------------
        // Event Handlers
        //---------------------------------------------------------------------------------------------

        // The wire draws itself from the node to the popup on open, and goes back on close
        let bodyAnimation = null, wireAnimations = [];
        const animateWire = (open, duration) => {
            for (const animation of wireAnimations) animation.cancel();
            wireAnimations = [];
            // A cancelled animation does not call onfinish. Clear the dasharray here, else the wire can show gaps.
            for (const path of [halo, tether]) path.style.strokeDasharray = '';
            if (reduceMotion.matches) return;
            const length = tether.getTotalLength();
            const easing = open ? 'ease-out' : 'ease-in';
            for (const path of [halo, tether]) {
                path.style.strokeDasharray = length;
                const animation = path.animate(
                    { strokeDashoffset: open ? [length, 0] : [0, length] }, { duration, easing });
                animation.onfinish = () => { path.style.strokeDasharray = ''; };
                wireAnimations.push(animation);
            }
            wireAnimations.push(cardDot.animate(
                open ? [{ opacity: 0 }, { opacity: 0, offset: 0.8 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0, offset: 0.2 }, { opacity: 0 }],
                { duration }));
        };

        const setOpen = (open) => {
            bodyAnimation?.cancel();
            window.popupStates[node.id] = open ? 'open' : 'closed';
            const ids = openIds().filter(id => id !== node.id);
            keepOpen(open && !autoCloseTime ? [...ids, node.id] : ids);
            const duration = reduceMotion.matches ? 0 : (open ? 260 : 120);
            if (open) {
                group.style.display = 'block';
                group.parentNode?.appendChild(group);  // the popup opened last is on top of the other popups
                statusText.setStatusText(statusText.fullText);  // text set while hidden is not cut to fit
                title.setTitle();
                bodyAnimation = body.animate(
                    [{ transform: 'scale(0.4)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }],
                    { duration, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' });  // overshoots, then settles
                animateWire(true, duration);
            } else {
                bodyAnimation = body.animate(
                    [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.4)', opacity: 0 }],
                    { duration, easing: 'ease-in' });
                animateWire(false, duration);
                bodyAnimation.onfinish = () => { group.style.display = 'none'; };
            }
        };

        // The tracker ids of the listeners of this popup. A removed popup removes its listeners from the tracker.
        const listenerIds = new Set();
        const listen = (element, eventType, handler) => {
            const id = window.popupEventTracker.addListener(element, eventType, handler);
            listenerIds.add(id);
            return id;
        };
        const unlisten = (id) => {
            window.popupEventTracker.removeListener(id);
            listenerIds.delete(id);
        };

        let clickTimer = null;
        let autoCloseTimeout = null;
        // A removed popup must not change the state of its node later. A new popup of the node can be open.
        group.nru_dispose = () => {
            for (const id of listenerIds) window.popupEventTracker.removeListener(id);
            listenerIds.clear();
            clearTimeout(clickTimer);
            clearTimeout(autoCloseTimeout);
            bodyAnimation?.cancel();
            for (const animation of wireAnimations) animation.cancel();
        };
        let mouseDownX = 0, mouseDownY = 0;
        const DRAG_THRESHOLD = 3;
        const handleRectElementMouseDown = (event) => {
            mouseDownX = event.clientX;
            mouseDownY = event.clientY;
        }
        const handleRectElementClick = (event) => {
            // Suppress toggle if the pointer moved far enough to count as a drag
            const dx = event.clientX - mouseDownX;
            const dy = event.clientY - mouseDownY;
            if (Math.hypot(dx, dy) > DRAG_THRESHOLD) return;

            if (clickTimer) {   // clear if double-clicked
                clearTimeout(clickTimer);
                clickTimer = null;
                return;
            }
            clickTimer = setTimeout(() => {
                const opening = window.popupStates[node.id] !== 'open';
                setOpen(opening);
                if (opening && autoCloseTime > 0) {
                    clearTimeout(autoCloseTimeout);
                    autoCloseTimeout = setTimeout(() => setOpen(false), autoCloseTime);
                }
                clickTimer = null;
            }, 250);
        }

        let startWidth, startHeight, startX, startY;
        let docResizeMouseMoveListener, docResizeMouseUpListener;
        const resizeHandleMouseDown = (event) => {

            // Get initial sizes and position
            [startWidth, startHeight] = [parseInt(rect.getAttribute('width')), parseInt(rect.getAttribute('height'))];
            ( {startX, startY} = {startX: event.clientX, startY: event.clientY} );
            resized = false;

            // Add event listeners for drag operations
            docResizeMouseMoveListener = listen(document, 'mousemove', resize);
            docResizeMouseUpListener = listen(document, 'mouseup', stopResize);
            
            event.preventDefault();
            event.stopPropagation();
        }

        let newWidth = 0, newHeight = 0, resized = false;
        const resize = (event)=> {
            resized = true;
            const scale = RED.view.scale();     // the canvas zoom
            const {dx, dy} = {dx: (event.clientX - startX) / scale, dy: (event.clientY - startY) / scale};
            newWidth = Math.max(MIN_WIDTH, startWidth + dx);
            newHeight = Math.max(MIN_HEIGHT, startHeight + dy);
            layout(newWidth, newHeight);
            sizeTextToFit( statusText, newWidth - STATUS_TEXT_MARGIN );
        }
        
        const stopResize = () => {
            unlisten(docResizeMouseMoveListener);
            unlisten(docResizeMouseUpListener);

            // A click with no drag does not change the size
            if (!resized) return;
            saveConfig();
        }

        // Drag the title bar or the status bar to move the popup
        let moveStartX, moveStartY, moveFromX, moveFromY, moved = false, grabbed = null;
        let docMoveMouseMoveListener, docMoveMouseUpListener;
        const moveMouseDown = (event) => {
            [moveStartX, moveStartY, moveFromX, moveFromY] = [event.clientX, event.clientY, popupX, popupY];
            moved = false;
            grabbed = event.currentTarget;
            grabbed.style.cursor = 'grabbing';
            docMoveMouseMoveListener = listen(document, 'mousemove', move);
            docMoveMouseUpListener = listen(document, 'mouseup', stopMove);
            event.preventDefault();
            event.stopPropagation();
        }

        const move = (event) => {
            moved = true;
            const scale = RED.view.scale();
            popupX = moveFromX + (event.clientX - moveStartX) / scale;
            popupY = moveFromY + (event.clientY - moveStartY) / scale;
            frame.setAttribute("transform", `translate(${popupX}, ${popupY})`);
            placeTether();
        }

        const stopMove = () => {
            unlisten(docMoveMouseMoveListener);
            unlisten(docMoveMouseUpListener);
            if (grabbed) grabbed.style.cursor = 'grab';
            grabbed = null;
            if (moved) saveConfig();
        }

        // A click on the close button closes the popup. The popup then does not open again after a browser refresh.
        const closeMouseDown = (event) => {
            event.preventDefault();
            event.stopPropagation();    // else Node-RED or the title bar starts a drag
        }
        const closeClick = (event) => {
            event.stopPropagation();
            clearTimeout(autoCloseTimeout);
            setOpen(false);
        }

        listen(rectElement, "mousedown", handleRectElementMouseDown);
        listen(rectElement, "click", handleRectElementClick);
        listen(resizeHandle, "mousedown", resizeHandleMouseDown);
        listen(statusBar, "mousedown", moveMouseDown);
        listen(header, "mousedown", moveMouseDown);
        listen(closeButton, "mousedown", closeMouseDown);
        listen(closeButton, "click", closeClick);
        listen(closeButton, "mouseenter", () => { closeHover.style.display = 'block'; });
        listen(closeButton, "mouseleave", () => { closeHover.style.display = 'none'; });
        title.setTitle();

        // Run the node's nru_popupInit function
        try {
            if (!node?._def?.nru_popupInit) return;
            if (typeof node._def.nru_popupInit !== 'function') {
                console.error('Popup init failed: nru_popupInit is not a function', {
                    exists: !!node._def.nru_popupInit,
                    type: typeof node._def.nru_popupInit
                });
                return;
            }
            node._def.nru_popupInit.call(node);
        } catch (error) {
            console.error('Running nru_popupInit failed with error:', error.message, {
                errorName: error.name,
                stack: error.stack,
                node: node?.id
            });
        }


    };

    // A new name or label of a node shows in the title of its popup, without a deploy
    RED.events.on('nodes:change', (node) => {
        document.getElementById('nru_popup.' + node?.id + '.title')?.setTitle?.();
    });

    // add/remove popup elements on workspace change
    RED.events.on('workspace:change', async (event) => {
        if (event?.old !== 0) { removePopups(event.old) };
        addPopups(event.workspace);
    });

    // remove the popup when its node is removed (delete, cut, undo of an add, convert to subflow)
    RED.events.on('nodes:remove', (node) => {
        const group = document.getElementById('nru_popup.' + node?.id + '.group');
        if (group) removePopupGroup(group);
    });

    // add popup elements on when new node is added
    RED.events.on('nodes:add', async (node) => {
        addPopup(node);
    });

    // Re-bind popups after deploy. Node-RED may replace a node's SVG rect
    // in place during redeploy, orphaning the click handler and removing the
    // popup group from the DOM. Neither workspace:change nor nodes:add fires
    // for unchanged nodes on the same tab, so without this the only recovery
    // was a full page refresh.
    RED.events.on('deploy', async () => {
        const active = RED.workspaces.active();
        if (!active) return;
        await removePopups(active);
        await addPopups(active);
    });

}

