'use strict';

// Security review N5: any resource can TriggerEvent('onResourceStop',
// 'cis_database'). server/dashboard.lua then stopped its push timer and sent
// every admin watching /cis_db a dashDenied, closing their panel, while the
// resource ran on. The handler now acts only when cis_database is really
// stopping, as index.lua and server.js do (stop_spoof.js). dashboard.lua runs
// under a stock Lua with stubbed natives.
// Usage: node tests/repro/dash_stop_spoof.js (needs `lua` on PATH, else SKIP)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dash = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'dashboard.lua'), 'utf8');

const driver = `
local sent, nets, stop, state, timers, cleared = {}, {}, nil, 'started', 0, 0
function GetCurrentResourceName() return 'cis_database' end
function GetResourceState(name) return state end
function GetGameTimer() return 0 end
function IsPlayerAceAllowed() return true end
function GetPlayerName(src) return 'p' .. src end
function SetTimeout() timers = timers + 1 return timers end
function ClearTimeout() cleared = cleared + 1 end
function TriggerClientEvent(name, src) sent[#sent + 1] = name .. ':' .. src end
function RegisterNetEvent(name, fn) nets[name] = fn end
function AddEventHandler(name, fn) if name == 'onResourceStop' then stop = fn end end
exports = setmetatable({}, { __index = function() return {
    cis_dash_snapshot = function() return {} end,
    cis_dash_watch = function() end,
} end })
local function count(name)
    local n = 0
    for _, v in ipairs(sent) do if v == name then n = n + 1 end end
    return n
end
load(io.read('a'), 'dashboard.lua')()
source = 1
nets['cis_database:dashOpen']()
stop('cis_database')
print('denied_spoof=' .. count('cis_database:dashDenied:1'))
print('cleared_spoof=' .. cleared)
state = 'stopping'
stop('cis_database')
print('denied_real=' .. count('cis_database:dashDenied:1'))
`;

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

const r = spawnSync('lua', ['-e', driver], { input: dash, encoding: 'utf8', timeout: 20000 });
if (r.error && r.error.code === 'ENOENT') {
    console.log('SKIP lua not on PATH');
    process.exit(0);
}
const out = Object.fromEntries((r.stdout || '').trim().split(/\r?\n/).filter((l) => l.includes('=')).map((l) => l.split('=')));
const detail = JSON.stringify(out) + (r.stderr ? ' ' + r.stderr.trim() : '');
check('a spoofed onResourceStop leaves the watching admin\'s panel open', out.denied_spoof === '0', detail);
check('it leaves the push timer running', out.cleared_spoof === '0', detail);
check('a real stop closes the panel', out.denied_real === '1', detail);

const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
