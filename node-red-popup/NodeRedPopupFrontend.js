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

    const removePopups = async (workspace) => {
        window.popupEventTracker.removeAllListeners();
        RED.nodes.filterNodes( {z:workspace} ).forEach ( node => {
            document.getElementById('nru_popup.' + node.id + '.group')?.remove();
        });
    }

    const addPopups = async (workspace) => {
        await window.nru_waitForWorkspaceChanges(100);
        RED.nodes.filterNodes( {z:workspace} ).forEach ( async node => {
            createPopup( node );
        });
    }

    const addPopup = async (node) => {
        await window.nru_waitForWorkspaceChanges(100);
        createPopup(node);
    }

    // Smallest popup size in pixels. Smaller sizes are made this size.
    const MIN_WIDTH = 100, MIN_HEIGHT = 50;
    // Where a popup sits under its node until the user moves it
    const DEFAULT_X = 0, DEFAULT_Y = 50;
    // Look of the card: the radius of the corners, the height of the status bar, and the space
    // at the right of the status bar that the text must not use (move dots and resize lines)
    let clipCount = 0;
    const CORNER = 8, STATUS_HEIGHT = 20, STATUS_TEXT_MARGIN = 48;
    const warnedTypes = new Set();
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const SVG_NS = "http://www.w3.org/2000/svg";

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
                
        // Exit if already added bc we are getting multiple workspace change events or something
        if (document.getElementById("nru_popup." + node.id + ".group") ) return;

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
        group.style.filter = 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.25)) drop-shadow(0 8px 14px rgba(0, 0, 0, 0.2))';

        // The body holds everything that is drawn. It unfurls from the node on open, so the
        // group keeps its own transform and display.
        const frame = make("g", { transform: `translate(${config.x}, ${config.y})` });   // the position of the popup
        const clipId = 'nru_popup_clip_' + (clipCount++);     // not made from the node id: an id with a space would break url()
        const body = make("g", { "clip-path": `url(#${clipId})` });     // rounded corners
        body.style.transformOrigin = (parseFloat(rectElement.getAttribute('width')) / 2) + "px 0px";

        const clipRect = make("rect", { x: 0, y: 0, rx: CORNER });
        const clipPath = make("clipPath", { id: clipId });
        clipPath.appendChild(clipRect);

        const rect = make("rect", { id: "nru_popup." + node.id + ".rect", x: 0, y: 0, rx: CORNER });
        rect.style.fill = theme('secondary-background', '#fff');
        const accentBar = make("rect", { x: 0, y: 0, height: 4 });
        accentBar.style.fill = lineColor;
        const outline = make("rect", { x: 0.5, y: 0.5, rx: CORNER, fill: "none" });
        outline.style.stroke = theme('primary-border-color', '#d4d4d4');
        outline.style.pointerEvents = 'none';    // else it takes the mouse from the status bar

        const foreignObject = make("foreignObject", { id: "nru_popup." + node.id + ".foreignObject", x: 6, y: 6 });
        const sourceText = svgElement.querySelector('.red-ui-flow-node-status-label');
        for (const attr of sourceText.attributes) {
            foreignObject.setAttribute(attr.name, attr.value)
        };
        foreignObject.setAttribute("x", "6");
        foreignObject.setAttribute("y", "6");

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

        body.append(rect, accentBar, statusBar, moveDots, statusText, foreignObject, outline, resizeLines, resizeHandle);
        frame.appendChild(body);

        // A line that ties the popup to its node, wherever the user puts it, and a dot where it starts
        const tether = make("line", { "stroke-dasharray": "3 3", "stroke-width": 1.5 });
        tether.style.stroke = lineColor;
        const anchor = make("circle", { r: 3.5 });
        anchor.style.fill = lineColor;
        tether.style.pointerEvents = anchor.style.pointerEvents = 'none';
        group.append(clipPath, tether, anchor, frame);
        svgElement.appendChild(group);

        // The tether runs from the bottom middle of the node to the nearest point of the popup
        let popupX = config.x, popupY = config.y;
        const placeTether = () => {
            const nodeMidX = parseFloat(rectElement.getAttribute('width')) / 2;
            const nodeBottom = parseFloat(rectElement.getAttribute('height'));
            const popupWidth = parseFloat(rect.getAttribute('width'));
            const popupHeight = parseFloat(rect.getAttribute('height'));
            tether.setAttribute("x1", nodeMidX);
            tether.setAttribute("y1", nodeBottom);
            tether.setAttribute("x2", Math.min(Math.max(nodeMidX, popupX), popupX + popupWidth));
            tether.setAttribute("y2", Math.min(Math.max(nodeBottom, popupY), popupY + popupHeight));
            anchor.setAttribute("cx", nodeMidX);
            anchor.setAttribute("cy", nodeBottom);
        };

        // Put every part at the right place for a popup of this size
        const layout = (w, h) => {
            for (const element of [rect, clipRect, statusBar]) element.setAttribute('width', w);
            for (const element of [rect, clipRect]) element.setAttribute('height', h);
            outline.setAttribute('width', w - 1);
            outline.setAttribute('height', h - 1);
            accentBar.setAttribute('width', w);
            statusBar.setAttribute('y', h - STATUS_HEIGHT);
            statusText.setAttribute('y', h - 6);
            moveDots.setAttribute('transform', `translate(${w - 40}, ${h - STATUS_HEIGHT / 2})`);
            foreignObject.setAttribute('width', w - 12);
            foreignObject.setAttribute('height', h - STATUS_HEIGHT - 12);   // total height - status bar - top and bottom padding
            divElement.style.width = (w - 12) + 'px';
            divElement.style.height = (h - STATUS_HEIGHT - 12) + 'px';
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

        let bodyAnimation = null;
        const setOpen = (open) => {
            bodyAnimation?.cancel();
            window.popupStates[node.id] = open ? 'open' : 'closed';
            const ids = openIds().filter(id => id !== node.id);
            keepOpen(open && !autoCloseTime ? [...ids, node.id] : ids);
            const duration = reduceMotion.matches ? 0 : (open ? 260 : 120);
            if (open) {
                group.style.display = 'block';
                svgElement.parentNode.appendChild(svgElement);  // bring to front
                statusText.setStatusText(statusText.fullText);  // text set while hidden is not cut to fit
                bodyAnimation = body.animate(
                    [{ transform: 'scale(0.4)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }],
                    { duration, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' });  // overshoots, then settles
            } else {
                bodyAnimation = body.animate(
                    [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.4)', opacity: 0 }],
                    { duration, easing: 'ease-in' });
                bodyAnimation.onfinish = () => { group.style.display = 'none'; };
            }
        };

        let clickTimer = null;
        let autoCloseTimeout = null;
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
            docResizeMouseMoveListener = window.popupEventTracker.addListener(document, 'mousemove', resize);
            docResizeMouseUpListener = window.popupEventTracker.addListener(document, 'mouseup', stopResize);
            
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
            window.popupEventTracker.removeListener(docResizeMouseMoveListener);
            window.popupEventTracker.removeListener(docResizeMouseUpListener);

            // A click with no drag does not change the size
            if (!resized) return;
            saveConfig();
        }

        // Drag the status bar to move the popup
        let moveStartX, moveStartY, moveFromX, moveFromY, moved = false;
        let docMoveMouseMoveListener, docMoveMouseUpListener;
        const statusBarMouseDown = (event) => {
            [moveStartX, moveStartY, moveFromX, moveFromY] = [event.clientX, event.clientY, popupX, popupY];
            moved = false;
            statusBar.style.cursor = 'grabbing';
            docMoveMouseMoveListener = window.popupEventTracker.addListener(document, 'mousemove', move);
            docMoveMouseUpListener = window.popupEventTracker.addListener(document, 'mouseup', stopMove);
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
            window.popupEventTracker.removeListener(docMoveMouseMoveListener);
            window.popupEventTracker.removeListener(docMoveMouseUpListener);
            statusBar.style.cursor = 'grab';
            if (moved) saveConfig();
        }

        window.popupEventTracker.addListener(rectElement, "mousedown", handleRectElementMouseDown);
        window.popupEventTracker.addListener(rectElement, "click", handleRectElementClick);
        window.popupEventTracker.addListener(resizeHandle, "mousedown", resizeHandleMouseDown);
        window.popupEventTracker.addListener(statusBar, "mousedown", statusBarMouseDown);

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

    // add/remove popup elements on workspace change
    RED.events.on('workspace:change', async (event) => {
        if (event?.old !== 0) { removePopups(event.old) };
        addPopups(event.workspace);
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

