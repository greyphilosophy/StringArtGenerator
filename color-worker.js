'use strict';
importScripts('color-planner.js');
self.onmessage = function (event) {
    try {
        const plan = ColorPlanner.plan(event.data, progress => self.postMessage({type: 'progress', progress}));
        self.postMessage({type: 'complete', plan});
    } catch (error) {
        self.postMessage({type: 'error', message: error.message});
    }
};
