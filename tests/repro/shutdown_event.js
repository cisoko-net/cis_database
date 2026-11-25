'use strict';

// Security review E1, and the bug it led to. index.lua listened for
// 'txAdmin:serverShuttingDown', which no txAdmin fires: txAdmin's monitor
// resource fires 'txAdmin:events:serverShuttingDown' with TriggerEvent
// (monitor/resource/sv_main.lua:388 on the box), so the early outbox flush
// never ran. Any resource could also fire the old name. index.lua now
// listens for the real event and only when monitor fired it
// (GetInvokingResource names the TriggerEvent caller: citizenfx/fivem
// ResourceScriptFunctions.cpp, GET_INVOKING_RESOURCE, GetInvokingScriptRuntime).
// index.lua runs under a stock Lua with stubbed natives.
// Usage: node tests/repro/shutdown_event.js (needs `lua` on PATH, else SKIP)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const index = fs.readFileSync(path.join(__dirname, '..', '..', 'index.lua'), 'utf8');

const driver = `
local handlers, flushed, invoker = {}, 0, nil
function GetCurrentResourceName() return 'cis_database' end
function GetInvokingResource() return invoker end
function GetResourceState() return 'started' end
function CreateThread() end
function AddEventHandler(name, fn) handlers[name] = handlers[name] or {} table.insert(handlers[name], fn) end
exports = setmetatable({}, { __index = function() return { flushReplica = function() flushed = flushed + 1 end } end })
load(io.read('a'), 'index.lua')()
local function fire(name, who)
    invoker = who
    local before = flushed
    for _, fn in ipairs(handlers[name] or {}) do fn({ delay = 5000, author = 'txAdmin', message = 'x' }) end
    return flushed - before
end
local function check(name, ok)
    print((ok and 'PASS ' or 'FAIL ') .. name)
end
check('txAdmin (monitor) shutdown notice flushes the outbox', fire('txAdmin:events:serverShuttingDown', 'monitor') == 1)
check('another resource firing the txAdmin event is ignored', fire('txAdmin:events:serverShuttingDown', 'other_script') == 0)
check('the event with no invoker is ignored', fire('txAdmin:events:serverShuttingDown', nil) == 0)
check('the old event name no longer flushes', fire('txAdmin:serverShuttingDown', 'other_script') == 0)
`;

const r = spawnSync('lua', ['-e', driver], { input: index, encoding: 'utf8', timeout: 20000 });
if (r.error && r.error.code === 'ENOENT') {
    console.log('SKIP lua not on PATH');
    process.exit(0);
}
const out = (r.stdout || '') + (r.stderr || '');
process.stdout.write(out);
const lines = out.split('\n').filter((l) => /^(PASS|FAIL) /.test(l));
const failed = lines.filter((l) => l.startsWith('FAIL')).length + (r.status !== 0 ? 1 : 0);
console.log(failed || lines.length !== 4 ? (failed || 1) + ' of ' + Math.max(lines.length, 4) + ' failed' : 'all 4 passed');
process.exit(failed || lines.length !== 4 ? 1 : 0);
