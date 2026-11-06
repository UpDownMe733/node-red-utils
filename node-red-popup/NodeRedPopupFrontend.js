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
            const existingGroup = document.getElementById('nru_popup.' + node.id + '.group');
            if (existingGroup) { 
                window.popupStates[node.id] = existingGroup.style.display === 'none' ? 'closed' : 'open';
                existingGroup.remove() 
            }
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
    const warnedTypes = new Set();

    const createPopup = async ( node ) => {

        if (!node?._def?.defaults?.nru_popupConfig?.value) return;

        // The node's own config (saved after a resize) wins over the default of the type
        const config = { ...node._def.defaults.nru_popupConfig.value, ...node.nru_popupConfig };
        const problem = ['width', 'height', 'autoCloseTime']
            .find(key => typeof config[key] !== 'number' || !(config[key] >= 0));
        if (problem) {
            console.error(`Popup of node ${node.id}: nru_popupConfig.${problem} must be a number, 0 or more; got`, config[problem]);
            if (!warnedTypes.has(node.type)) {
                warnedTypes.add(node.type);
                RED.notify(`No popup for "${node.type}" nodes: nru_popupConfig.${problem} must be a number, 0 or more.`, 'warning');
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
        group.setAttribute("transform", "translate(0, 50)");
        group.style.display = (window.popupStates[node.id] === 'open') ? 'block' : 'none';

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

        // Create text element for node info
        let statusText = document.createElementNS("http://www.w3.org/2000/svg", "text");
        statusText.setAttribute("id", "nru_popup." + node.id + ".statusText");
        statusText.setAttribute("x", "6");
        statusText.setAttribute("y", (parseInt(rect.getAttribute("height")) - 6).toString());
        statusText.setAttribute("font-family", "Arial, Helvetica, sans-serif");                
        statusText.setAttribute("font-size", "10");
        statusText.setAttribute("stroke-width", "0.2"); 
        statusText.setAttribute("fill", "#222");
        statusText.textContent = '';
        statusText.fullText = '';
        statusText.setStatusText = function( text ) {
            const width = parseInt(rect.getAttribute('width'));
            statusText.textContent = text;
            statusText.fullText = text;
            sizeTextToFit( statusText, width);
        };

        // Add elements to group
        group.appendChild(rect);
        group.appendChild(statusBar);
        group.appendChild(statusText);
        group.appendChild(foreignObject);
        group.appendChild(resizeHandle);
        svgElement.appendChild(group);

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
                const isHidden = group.style.display === 'none';
                group.style.display = isHidden ? 'block' : 'none';
                // Save the popup state
                window.popupStates[node.id] = isHidden ? 'open' : 'closed';
                if (isHidden) {
                    svgElement.parentNode.appendChild(svgElement);
                    if (autoCloseTime > 0) {
                        clearTimeout(autoCloseTimeout);
                        autoCloseTimeout = setTimeout(() => { group.style.display = 'none';}, autoCloseTime);
                    }
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
            const {dx, dy} = {dx: event.clientX - startX, dy: event.clientY - startY};
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
        }
        
        const stopResize = () => {
            window.popupEventTracker.removeListener(docResizeMouseMoveListener);
            window.popupEventTracker.removeListener(docResizeMouseUpListener);

            // A click with no drag does not change the size
            if (!resized) return;
            node.nru_popupConfig = {
                width: newWidth, 
                height: newHeight,
                autoCloseTime: autoCloseTime
            };
            node.changed = true;
            RED.nodes.dirty(true);
        }

        window.popupEventTracker.addListener(rectElement, "mousedown", handleRectElementMouseDown);
        window.popupEventTracker.addListener(rectElement, "click", handleRectElementClick);
        window.popupEventTracker.addListener(resizeHandle, "mousedown", resizeHandleMouseDown);

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

