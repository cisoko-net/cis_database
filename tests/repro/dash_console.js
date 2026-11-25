'use strict';

// The console (source 0) holds every ACE, so the ACE check alone would let it
// open the dashboard; server/dashboard.lua refuses source 0 first. dashboard.lua
// runs under a stock Lua with stubbed natives. mutations.json M14 removes the
// refusal.
// Usage: node tests/repro/dash_console.js (needs `lua` on PATH, else SKIP)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dash = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'dashboard.lua'), 'utf8');
const driver = `
local sent, watch, nets, timers = {}, {}, {}, {}
function GetCurrentResourceName() return 'cis_database' end
function GetGameTimer() return 0 end
function IsPlayerAceAllowed(src, name) return true end
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
load(io.read('a'), 'dashboard.lua')()
source = 0
nets['cis_database:dashOpen']()
local opened, denied = 0, 0
for _, v in ipairs(sent) do
    if v == 'cis_database:dashOpen:0' then opened = opened + 1 end
    if v == 'cis_database:dashDenied:0' then denied = denied + 1 end
end
print('opened=' .. opened)
print('denied=' .. denied)
print('watched=' .. tostring(watch[0]))
`;

const r = spawnSync('lua', ['-e', driver], { input: dash, encoding: 'utf8', timeout: 20000 });
if (r.error && r.error.code === 'ENOENT') {
    console.log('SKIP lua not on PATH');
    process.exit(0);
}
const out = Object.fromEntries((r.stdout || '').trim().split(/\r?\n/).filter((l) => l.includes('=')).map((l) => l.split('=')));
const ok = out.opened === '0' && out.denied === '1' && out.watched === 'nil';
console.log((ok ? 'PASS ' : 'FAIL ') + 'the console cannot open the dashboard  ' + JSON.stringify(out) + (r.stderr ? ' ' + r.stderr.trim() : ''));
process.exit(ok ? 0 : 1);
