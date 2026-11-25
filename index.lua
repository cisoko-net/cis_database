-- Lua glue for the JavaScript engine (server.js): shutdown hooks and a boot
-- message once the engine is up. The per-frame tick is server.js's setTick.

local RESOURCE = GetCurrentResourceName()

-- exports[] resolved at call time: during a restart the JS side may be gone.
local function exp()
    return exports[RESOURCE]
end

-- txAdmin announces a stop; frameworks save every player in this same event,
-- so the engine stays open. Writes are already on disk; this only sends the
-- outbox to MariaDB early. txAdmin's own resource, monitor, fires it with
-- TriggerEvent; any other resource firing it is ignored.
AddEventHandler('txAdmin:events:serverShuttingDown', function()
    if GetInvokingResource() ~= 'monitor' then
        return
    end
    local e = exp()
    if e and e.flushReplica then
        e.flushReplica(e)
    end
end)

AddEventHandler('onResourceStop', function(res)
    if res ~= RESOURCE then
        return
    end
    -- Any resource can TriggerEvent('onResourceStop', 'cis_database'). Only a
    -- real stop has this resource in the stopping state.
    if GetResourceState(RESOURCE) ~= 'stopping' then
        return
    end
    local e = exp()
    if e and e.shutdown then
        e.shutdown(e)
    end
end)

-- Log-only readiness check: waits up to 20 s (400 x 50 ms) for server.js to
-- finish opening SQLite. It does not gate any call; the engine does that itself.
CreateThread(function()
    local n = 0
    while n < 400 do
        local ok, ready = pcall(function()
            return exp().isReady(exp()) == true
        end)
        if ok and ready == true then
            return
        end
        Wait(50)
        n = n + 1
    end
    -- Hydrate may still finish later; the engine logs "Ready." when it does.
    print('[cis_database] still starting after 20 s; calls wait until it is ready')
end)
