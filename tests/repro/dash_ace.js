'use strict';

// Security review E3: server/dashboard.lua checked the ACE only when a player
// opened the panel. Once an admin's ACE was removed, push() kept sending them
// engine snapshots every 750 ms. push() now checks the ACE on every tick and
// closes the panel for a player who lost it. dashboard.lua runs under a stock
// Lua with stubbed natives.
// Usage: node tests/repro/dash_ace.js (needs `lua` on PATH, else SKIP)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dash = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'dashboard.lua'), 'utf8');
const clientLua = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'dashboard.lua'), 'utf8');

const driver = `
local ace, sent, watch, nets, timers = { [1] = true }, {}, {}, {}, {}
function GetCurrentResourceName() return 'cis_database' end
function GetGameTimer() return 0 end
function IsPlayerAceAllowed(src, name) return ace[src] == true end
function GetPlayerName(src) return 'p' .. src end
function SetTimeout(ms, fn) timers[#timers + 1] = fn return #timers end
function ClearTimeout(id) timers[id] = false end
function TriggerClientEvent(name, src) sent[#sent + 1] = name .. ':' .. src end
function RegisterNetEvent(name, fn) nets[name] = fn end
function AddEventHandler() end
exports = setmetatable({}, { __index = function() return {
    cis_dash_snapshot = function() return {} end,
    cis_dash_watch = function(_, src, on) watch[src] = on end,
} end })
local function tick()
    for i = 1, #timers do
        local fn = timers[i]
        if fn then timers[i] = false fn() return true end
    end
    return false
end
local function count(name)
    local n = 0
    for _, v in ipairs(sent) do if v == name then n = n + 1 end end
    return n
end
load(io.read('a'), 'dashboard.lua')()
source = 1
nets['cis_database:dashOpen']()
tick()
print('ticks_with_ace=' .. count('cis_database:dashTick:1'))
ace[1] = nil
sent = {}
tick()
tick()
print('ticks_after_revoke=' .. count('cis_database:dashTick:1'))
print('denied_after_revoke=' .. count('cis_database:dashDenied:1'))
print('watch_after_revoke=' .. tostring(watch[1]))
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
check('an allowed viewer gets ticks', out.ticks_with_ace === '1', detail);
check('no tick after the ACE is removed', out.ticks_after_revoke === '0', detail);
check('the viewer is told the panel is closed', out.denied_after_revoke === '1', detail);
check('the viewer stops being watched', out.watch_after_revoke === 'false', detail);
const denied = clientLua.slice(clientLua.indexOf("RegisterNetEvent('cis_database:dashDenied'"));
check('the client hides an open panel on dashDenied', /SendNUIMessage\(\{ action = 'close' \}\)/.test(denied.slice(0, denied.indexOf('\nend)'))));

const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
