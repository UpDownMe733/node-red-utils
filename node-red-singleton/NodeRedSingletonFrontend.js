/**
 * Copyright 2024 Contributors
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

//
//  NodeRedSingletonFrontend.js
//
//  Frontend handler for Node-RED singleton nodes.
//  A node type with "singleton: true" in its definition can have one node in the editor.
//  - A new node that one user action added alone (palette drop, quick add, paste of one node):
//    the script undoes that action, so links, groups and the changed state come back too.
//  - Other duplicates (an import of several nodes, a saved flow with two nodes):
//    the script does not delete them. It shows a warning.
//

if (!window.NodeRedSingletonInitialized) {
    window.NodeRedSingletonInitialized = true;

    const instances = {};       // node type -> Set of node ids in the editor
    const warned = new Set();   // node types with a warning in the current operation

    // The node ids that a history event adds, also inside a "multi" event
    const addedIds = (ev) => !ev ? [] : [...(ev.t === 'add' && ev.nodes) || [], ...(ev.events || []).flatMap(addedIds)];

    function check(node) {
        const ids = instances[node.type];
        if (!ids || ids.size < 2 || !ids.has(node.id)) return;

        const added = addedIds(RED.history.peek());
        if (added.length === 1 && added[0] === node.id) {
            RED.history.pop();
            RED.view.redraw(true);
            RED.notify(`Only one "${node.type}" node is allowed. The new node was removed.`, 'warning');
        } else if (!warned.has(node.type)) {
            warned.add(node.type);
            setTimeout(() => warned.delete(node.type), 0);
            RED.notify(`Only one "${node.type}" node is allowed, but the flows have ${ids.size}. Delete the extra nodes.`, 'warning');
        }
    }

    RED.events.on('nodes:add', (node) => {
        if (!node || !node.type || RED.nodes.getType(node.type)?.singleton !== true) return;
        const ids = instances[node.type] ??= new Set();
        ids.add(node.id);
        // Wait until the editor has recorded the action in its history
        if (ids.size > 1) setTimeout(() => check(node), 0);
    });

    RED.events.on('nodes:remove', (node) => {
        if (node && node.type) instances[node.type]?.delete(node.id);
    });
}
