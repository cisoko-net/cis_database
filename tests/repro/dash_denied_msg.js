'use strict';

// Owner 2026-11-25: a player without the ACE typed /cis_db and nothing
// happened. The server sent dashDenied and the client only closed a panel that
// was never open. The server now says why it denies ('ace' for a missing or
// removed ACE, 'stop' when the resource stops), and the client tells the
// player the ACE it needs in chat and in F8 for 'ace', and stays quiet for
// 'stop'. client/dashboard.lua and server/dashboard.lua run under a stock Lua
// with stubbed natives.
// Usage: node tests/repro/dash_denied_msg.js (needs `lua` on PATH, else SKIP)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..', '..');
const clientLua = fs.readFileSync(path.join(root, 'client', 'dashboard.lua'), 'utf8');
const serverLua = fs.readFileSync(path.join(root, 'server', 'dashboard.lua'), 'utf8');
const LINE = 'no permission: needs ace cis_database.dashboard';

const clientDriver = `
local nets, chat, printed, nui = {}, {}, {}, {}
function RegisterNetEvent(name, fn) nets[name] = fn end
function RegisterNUICallback() end
function RegisterCommand() end
function CreateThread() end
function SetNuiFocus() end
function SendNUIMessage(m) nui[#nui + 1] = m.action end
function TriggerServerEvent() end
function TriggerEvent(name, msg)
    if name == 'chat:addMessage' then chat[#chat + 1] = table.concat(msg.args or {}, ' ') end
end
print = function(...) printed[#printed + 1] = table.concat({ ... }, ' ') end
load(io.read('a'), 'client/dashboard.lua')()
local function has(list, s)
    for _, v in ipairs(list) do if v:find(s, 1, true) then return 1 end end
    return 0
end
local LINE = '${LINE}'
nets['cis_database:dashDenied']('ace')
io.stdout:write('ace_chat=' .. has(chat, LINE) .. '\\n')
io.stdout:write('ace_print=' .. has(printed, LINE) .. '\\n')
chat, printed = {}, {}
nets['cis_database:dashDenied']('stop')
io.stdout:write('stop_chat=' .. #chat .. '\\n')
io.stdout:write('stop_print=' .. #printed .. '\\n')
`;

const serverDriver = `
local sent, nets, handlers = {}, {}, {}
function GetCurrentResourceName() return 'cis_database' end
function GetResourceState() return 'stopping' end
function GetGameTimer() return 0 end
local aceOf = { [2] = true, [3] = true }
function IsPlayerAceAllowed(src) return aceOf[src] == true end
function GetPlayerName(src) return 'p' .. src end
local pending
function SetTimeout(_, fn) pending = fn return 1 end
function ClearTimeout() end
function TriggerClientEvent(name, src, arg) sent[#sent + 1] = name .. ':' .. src .. ':' .. tostring(arg) end
function RegisterNetEvent(name, fn) nets[name] = fn end
function AddEventHandler(name, fn) handlers[name] = fn end
exports = setmetatable({}, { __index = function() return {
    cis_dash_snapshot = function() return {} end,
    cis_dash_watch = function() end,
} end })
load(io.read('a'), 'server/dashboard.lua')()
source = 1
nets['cis_database:dashOpen']()
io.stdout:write('open_denied=' .. tostring(sent[1]) .. '\\n')
source = 3
nets['cis_database:dashOpen']()
aceOf[3] = nil
sent = {}
if pending then pending() end
local revoked = 'none'
for _, v in ipairs(sent) do if v:find('dashDenied:3:', 1, true) then revoked = v end end
io.stdout:write('revoke_denied=' .. revoked .. '\\n')
source = 2
nets['cis_database:dashOpen']()
sent = {}
handlers['onResourceStop']('cis_database')
io.stdout:write('stop_denied=' .. tostring(sent[1]) .. '\\n')
`;

const results = [];
function check(name, ok, detail) {
    results.push(!!ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

function run(driver, src) {
    const r = spawnSync('lua', ['-e', driver], { input: src, encoding: 'utf8', timeout: 20000 });
    if (r.error && r.error.code === 'ENOENT') return null;
    const out = Object.fromEntries((r.stdout || '').trim().split(/\r?\n/).filter((l) => l.includes('=')).map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i), l.slice(i + 1)];
    }));
    return { out, detail: JSON.stringify(out) + (r.stderr ? ' ' + r.stderr.trim() : '') };
}

const c = run(clientDriver, clientLua);
if (!c) {
    console.log('SKIP lua not on PATH');
    process.exit(0);
}
check('a denied player is told the ACE in chat', c.out.ace_chat === '1', c.detail);
check('a denied player is told the ACE in F8', c.out.ace_print === '1', c.detail);
check('a resource stop closes quietly (no chat line)', c.out.stop_chat === '0', c.detail);
check('a resource stop closes quietly (no F8 line)', c.out.stop_print === '0', c.detail);

const s = run(serverDriver, serverLua);
check('the server denies a missing ACE with reason ace', s.out.open_denied === 'cis_database:dashDenied:1:ace', s.detail);
check('the server tells a player whose ACE was removed while watching, reason ace', s.out.revoke_denied === 'cis_database:dashDenied:3:ace', s.detail);
check('the server closes on stop with reason stop', s.out.stop_denied === 'cis_database:dashDenied:2:stop', s.detail);

const failed = results.filter((x) => !x).length;
console.log(failed ? failed + ' of ' + results.length + ' failed' : 'all ' + results.length + ' passed');
process.exit(failed ? 1 : 0);
