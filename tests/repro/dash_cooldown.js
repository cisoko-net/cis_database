'use strict';

// Security review E7: server/dashboard.lua answered every
// 'cis_database:dashOpen' with an ACE check, an engine snapshot and a client
// event, so a client could spam it. Each player now gets one open per second;
// calls inside that second are dropped. dashboard.lua runs under a stock Lua
// with stubbed natives.
// Usage: node tests/repro/dash_cooldown.js (needs `lua` on PATH, else SKIP)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dash = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'dashboard.lua'), 'utf8');

const driver = `
local ace, sent, nets, drops, now, checks, snaps = { [1] = true }, {}, {}, nil, 0, 0, 0
function GetCurrentResourceName() return 'cis_database' end
function GetGameTimer() return now end
function IsPlayerAceAllowed(src) checks = checks + 1 return ace[src] == true end
function GetPlayerName(src) return 'p' .. src end
function SetTimeout() return 1 end
function ClearTimeout() end
function TriggerClientEvent(name, src) sent[#sent + 1] = name .. ':' .. src end
function RegisterNetEvent(name, fn) nets[name] = fn end
function AddEventHandler(name, fn) if name == 'playerDropped' then drops = fn end end
exports = setmetatable({}, { __index = function() return {
    cis_dash_snapshot = function() snaps = snaps + 1 return {} end,
    cis_dash_watch = function() end,
} end })
local function count(name)
    local n = 0
    for _, v in ipairs(sent) do if v == name then n = n + 1 end end
    return n
end
load(io.read('a'), 'dashboard.lua')()
source = 1
for _ = 1, 50 do nets['cis_database:dashOpen']() end
print('opens_burst=' .. count('cis_database:dashOpen:1'))
print('snaps_burst=' .. snaps)
source = 2
for _ = 1, 50 do nets['cis_database:dashOpen']() end
print('denied_burst=' .. count('cis_database:dashDenied:2'))
print('checks_burst=' .. checks)
now = 1001
source = 1
nets['cis_database:dashOpen']()
print('opens_later=' .. count('cis_database:dashOpen:1'))
source = 2
drops()
now = 1002
nets['cis_database:dashOpen']()
print('denied_after_drop=' .. count('cis_database:dashDenied:2'))
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
check('50 opens in one second answer once', out.opens_burst === '1' && out.snaps_burst === '1', detail);
check('50 denied opens answer once', out.denied_burst === '1', detail);
check('the ACE is checked once per player per second', out.checks_burst === '2', detail);
check('an open a second later is answered', out.opens_later === '2', detail);
check('a dropped player\'s cooldown is forgotten', out.denied_after_drop === '2', detail);

const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
