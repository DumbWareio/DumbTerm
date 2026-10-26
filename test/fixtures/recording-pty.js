/**
 * Test fixture, preloaded into server.js with `node --require`.
 * Wraps the real node-pty so every terminal's kill() prints PTY_KILLED (synchronously, so the line
 * survives an immediate process exit) — lets tests check that shutdown really kills each pty.
 */
const fs = require('fs');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    const loaded = originalLoad.call(this, request, ...rest);
    if (request !== 'node-pty') return loaded;
    return {
        ...loaded,
        spawn(...args) {
            const term = loaded.spawn(...args);
            const kill = term.kill.bind(term);
            term.kill = (...killArgs) => {
                fs.writeSync(1, 'PTY_KILLED\n');
                return kill(...killArgs);
            };
            return term;
        },
    };
};
