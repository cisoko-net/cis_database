-- Admin dashboard, server side: checks the ACE, then pushes an engine
-- snapshot to every open dashboard every 750 ms (only while someone watches).
local watchers = {}
local timer = nil
local res = GetCurrentResourceName()

-- The client only asks; the ACE (add_ace group.admin cis_database.dashboard
-- allow) is checked here. Console (source 0) is never a viewer.
local function allowed(src)
    if src == 0 then return false end
    return IsPlayerAceAllowed(src, 'cis_database.dashboard')
end

local function stopTimer()
    if timer then
        ClearTimeout(timer)
        timer = nil
    end
end

local function push()
    timer = nil
    local snap = exports[res]:cis_dash_snapshot()
    local any = false
    for src, _ in pairs(watchers) do
        if GetPlayerName(src) and not allowed(src) then
            -- The ACE was removed while the panel was open: close it.
            watchers[src] = nil
            exports[res]:cis_dash_watch(src, false)
            TriggerClientEvent('cis_database:dashDenied', src, 'ace')
        elseif GetPlayerName(src) then
            any = true
            TriggerClientEvent('cis_database:dashTick', src, snap)
        else
            watchers[src] = nil
            exports[res]:cis_dash_watch(src, false)
        end
    end
    if any then
        timer = SetTimeout(750, push)
    end
end

local function openFor(src)
    if not allowed(src) then
        TriggerClientEvent('cis_database:dashDenied', src, 'ace')
        return
    end
    watchers[src] = true
    exports[res]:cis_dash_watch(src, true)
    local snap = exports[res]:cis_dash_snapshot()
    TriggerClientEvent('cis_database:dashOpen', src, snap)
    if not timer then
        timer = SetTimeout(750, push)
    end
end

-- One open per player per second: each one costs an ACE check, a snapshot
-- and a client event, and any client can send it.
local lastOpen = {}

RegisterNetEvent('cis_database:dashOpen', function()
    local src = source
    local now = GetGameTimer()
    if lastOpen[src] and now - lastOpen[src] < 1000 then return end
    lastOpen[src] = now
    openFor(src)
end)

RegisterNetEvent('cis_database:dashClose', function()
    local src = source
    if src == 0 then return end
    watchers[src] = nil
    exports[res]:cis_dash_watch(src, false)
    if not next(watchers) then
        stopTimer()
    end
end)

AddEventHandler('playerDropped', function()
    local src = source
    lastOpen[src] = nil
    if not watchers[src] then return end
    watchers[src] = nil
    exports[res]:cis_dash_watch(src, false)
    if not next(watchers) then
        stopTimer()
    end
end)

AddEventHandler('onResourceStop', function(name)
    if name ~= GetCurrentResourceName() then return end
    -- Any resource can trigger this event; act only on a real stop.
    if GetResourceState(name) ~= 'stopping' then return end
    stopTimer()
    for src, _ in pairs(watchers) do
        TriggerClientEvent('cis_database:dashDenied', src, 'stop')
    end
end)
