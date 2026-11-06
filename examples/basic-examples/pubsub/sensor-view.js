'use strict';

const { NodeRedNodeBase, nodeRedPubsubBus } = require('@nrutils/node-red-utils');

// Consumer: shows the latest reading of the selected sensor-sim and adds it to each msg.
module.exports = NodeRedNodeBase.createNode('sensor-view', [nodeRedPubsubBus], (RED, thisNode, config) => {
    const bus = thisNode.nodeRedPubsubBus;
    let reading = null;

    const noSensor = () => {
        reading = null;
        thisNode.status({ fill: 'grey', shape: 'ring', text: 'no sensor' });
    };
    noSensor();

    if (config.producer) {
        bus.subscribe(`${config.producer}/reading`, async (event) => {
            if (event.kind === 'disconnect') return noSensor();     // the sensor-sim closed
            try {
                const value = await bus.getMetadata(event.producerId, event.desc);
                if (value === null) return noSensor();
                reading = value;
                thisNode.status({ fill: 'green', shape: 'dot', text: String(value) });
            } catch (err) {     // the worker did not reply, or it stopped during the request
                noSensor();
            }
        });
    }

    thisNode.on('input', (msg, send, done) => {
        msg.reading = reading;
        send(msg);
        done();
    });
});
