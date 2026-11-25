'use strict';

// Final review 2026-11-02 #10: client/dashboard.lua ran a thread on every
// player that woke every 400 ms forever, even though the panel is for admins
// only. The key thread must start when the panel opens and end when it closes,
// so a closed panel costs nothing. client/dashboard.lua runs under a stock Lua
// with the natives it calls stubbed.
//
// Usage: node tests/repro/dash_client_idle.js (needs `lua` on PATH, else SKIP)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const driver = String.raw`
local threads, sent, keys = {}, {}, {}
function CreateThread(fn) threads[#threads + 1] = coroutine.create(fn) end
function Wait() coroutine.yield() end
function SetNuiFocus() end
function SendNUIMessage(m) sent[#sent + 1] = m.action end
function TriggerServerEvent() end
local nets = {}
function RegisterNetEvent(name, fn) nets[name] = fn end
function RegisterNUICallback() end
function RegisterCommand() end
function IsControlJustReleased(_, k) return keys[k] == true end
local function live()
    local n = 0
    for _, co in ipairs(threads) do if coroutine.status(co) ~= 'dead' then n = n + 1 end end
    return n
end
local function tick()
    for _, co in ipairs({ table.unpack(threads) }) do
        if coroutine.status(co) == 'suspended' then assert(coroutine.resume(co)) end
    end
end
load(io.read('a'), 'dashboard.lua')()
tick(); tick()
print('closed_threads=' .. live())
nets['cis_database:dashOpen']({})
nets['cis_database:dashOpen']({})
tick()
print('open_threads=' .. live())
keys[322] = true
tick(); tick()
keys[322] = false
print('closed_after=' .. sent[#sent])
print('after_close_threads=' .. live())
`;

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'dashboard.lua'), 'utf8');
const r = spawnSync('lua', ['-e', driver], { input: src, encoding: 'utf8', timeout: 20000 });
if (r.error && r.error.code === 'ENOENT') {
    console.log('SKIP lua not on PATH');
    process.exit(0);
}
const out = Object.fromEntries((r.stdout || '').trim().split(/\r?\n/).filter((l) => l.includes('=')).map((l) => l.split('=')));
const detail = JSON.stringify(out) + (r.stderr ? ' ' + r.stderr.trim() : '');
check('no thread runs while the panel was never opened', out.closed_threads === '0', detail);
check('one key thread runs while it is open, even if opened twice', out.open_threads === '1', detail);
check('Pause closes the panel', out.closed_after === 'close', detail);
check('the key thread ends when the panel closes', out.after_close_threads === '0', detail);
if (results.some((x) => !x)) process.exit(1);
console.log('dash_client_idle: all ' + results.length + ' passed');
