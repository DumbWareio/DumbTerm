/**
 * Test fixture, preloaded into server.js with `node --require`.
 * Replaces node-pty with a module whose spawn() throws, reproducing native spawn failures
 * such as node-pty 1.1.0's macOS "posix_spawnp failed" without depending on the host.
 */
const Module = require('module');

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'node-pty') {
        return {
            spawn() {
                throw new Error('posix_spawnp failed.');
            },
        };
    }
    return originalLoad.call(this, request, ...rest);
};
