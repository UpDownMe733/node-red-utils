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
        let group = document.createElementNS("http://www.w3.org/2000/svg", "g");
        group.setAttribute("id", "nru_popup." + node.id + ".group");
        group.style.display = (window.popupStates[node.id] === 'open') ? 'block' : 'none';
        group.style.filter = 'drop-shadow(0 4px 8px rgba(0, 0, 0, 0.3))';

        // The body holds everything that is drawn. It unfurls from the node on open, so the
        // group keeps its own transform and display.
        const frame = document.createElementNS(SVG_NS, "g");   // the position of the popup
        frame.setAttribute("transform", `translate(${config.x}, ${config.y})`);
        const body = document.createElementNS(SVG_NS, "g");
        body.style.transformOrigin = (parseFloat(rectElement.getAttribute('width')) / 2) + "px 0px";

        // Create base elements
        let rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("id", "nru_popup." + node.id + ".rect");
        rect.setAttribute("x", "0");
        rect.setAttribute("y", "0");
        rect.setAttribute("width", width);
        rect.setAttribute("height", height);
        rect.setAttribute("fill", "#f1f1f1");
        rect.setAttribute("stroke", "#d4d4d4");
        rect.setAttribute("stroke-width", "1");
        rect.setAttribute("rx", "0");

        let foreignObject = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
        foreignObject.setAttribute("id", "nru_popup." + node.id + ".foreignObject");
        const sourceText = svgElement.querySelector('.red-ui-flow-node-status-label');
        for (const attr of sourceText.attributes) {
            foreignObject.setAttribute(attr.name, attr.value)
        };
        foreignObject.setAttribute("x", "6");
        foreignObject.setAttribute("y", "6");
        foreignObject.setAttribute("width", width - 12);
        foreignObject.setAttribute("height", height - 20 - 12); // Leave room for status bar

        let divElement = document.createElement("div");
        divElement.setAttribute("id", "nru_popup." + node.id + ".div");
        divElement.style.width = (width - 12) + "px";
        divElement.style.height = (height - 20 - 12) + "px";
        divElement.style.margin = "0";
        divElement.style.overflow = "auto";
        divElement.style.boxSizing = "border-box";
        foreignObject.appendChild(divElement);

        // Create resize handle as a small path in bottom right
        const resizeHandle = document.createElementNS("http://www.w3.org/2000/svg", "path");
        resizeHandle.setAttribute("id", "nru_popup." + node.id + ".resizeHandle");
        resizeHandle.setAttribute("d", `M${width - 6},${height} l6,-6 l0,6 z`);
        resizeHandle.setAttribute("fill", "#b3b3b3 ");
        resizeHandle.setAttribute("stroke", "#b3b3b3 ");
        resizeHandle.setAttribute("style", "cursor: se-resize");

        // Create status bar rectangle
        let statusBar = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        statusBar.setAttribute("id", "nru_popup." + node.id + ".statusBar");
        statusBar.setAttribute("x", "0");
        statusBar.setAttribute("y", (parseInt(rect.getAttribute("height")) - 20).toString());
        statusBar.setAttribute("width", width);
        statusBar.setAttribute("height", "20");  // Height of status bar
        statusBar.setAttribute("fill", "#e3e3e3");  // Light gray background
        statusBar.setAttribute("stroke", "#d4d4d4");
        statusBar.setAttribute("stroke-width", "1");
        statusBar.style.cursor = 'grab';

        // Create text element for node info
        let statusText = document.createElementNS("http://www.w3.org/2000/svg", "text");
        statusText.setAttribute("id", "nru_popup." + node.id + ".statusText");
        statusText.setAttribute("x", "6");
        statusText.setAttribute("y", (parseInt(rect.getAttribute("height")) - 6).toString());
        statusText.setAttribute("font-family", "Arial, Helvetica, sans-serif");                
        statusText.setAttribute("font-size", "10");
        statusText.setAttribute("stroke-width", "0.2"); 
        statusText.setAttribute("fill", "#222");
        statusText.style.pointerEvents = 'none';   // so that a drag on the text moves the popup
        statusText.textContent = '';
        statusText.fullText = '';
        statusText.setStatusText = function( text ) {
            const width = parseInt(rect.getAttribute('width'));
            statusText.textContent = text;
            statusText.fullText = text;
            sizeTextToFit( statusText, width);
        };

        // Add elements to group
        body.appendChild(rect);
        body.appendChild(statusBar);
        body.appendChild(statusText);
        body.appendChild(foreignObject);
        body.appendChild(resizeHandle);
        frame.appendChild(body);

        // A line that ties the popup to its node, wherever the user puts it
        const tether = document.createElementNS(SVG_NS, "line");
        tether.setAttribute("stroke", "#8c8c8c");
        tether.setAttribute("stroke-dasharray", "3 3");
        tether.style.pointerEvents = 'none';
        group.append(tether, frame);
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
        };
        placeTether();

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
            statusBar.setAttribute('width', newWidth);
            statusBar.setAttribute("y", (newHeight - 20).toString());
            statusText.setAttribute("y", (newHeight - 6).toString());
            sizeTextToFit( statusText, newWidth );
            rect.setAttribute('width', newWidth);
            rect.setAttribute('height', newHeight);
            foreignObject.setAttribute('width', newWidth - 12);
            foreignObject.setAttribute('height', newHeight - 20 - 6 - 6);  // total height - statusbar height - top padding - bottom padding
            divElement.style.width = (newWidth - 12) + 'px';
            divElement.style.height = (newHeight - 20 - 12) + 'px';
            resizeHandle.setAttribute("d", `M${newWidth - 6},${newHeight} l6,-6 l0,6 z`);
            placeTether();
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

