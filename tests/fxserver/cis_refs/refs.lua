-- Test only. 50000 awaited calls per mode; Lua heap (KB) max and at the end,
-- and the longest frame seen meanwhile.
local pending = {}
exports.cis_refs:register(function(id, result)
    local p = pending[id]
    pending[id] = nil
    if p then p:resolve(result) end
end)

local worst = 0
CreateThread(function()
    local last = os.nanotime()
    while true do
        Wait(0)
        local t = os.nanotime()
        local g = (t - last) / 1e6
        if g > worst then worst = g end
        last = t
    end
end)

local function run(mode)
    collectgarbage('collect')
    Wait(200)
    worst = 0
    local maxKb, t0 = 0, os.nanotime()
    local nextId = 0
    for i = 1, 50000 do
        local p = promise.new()
        if mode == 'ret' then
            local r = exports.cis_refs:ret(i)
            p:resolve(r[2])
        elseif mode == 'noop' then
            exports.cis_refs:noop()
            p:resolve(true)
        elseif mode == 'perCall' then
            exports.cis_refs:perCall(i, function(r) p:resolve(r) end)
        else
            nextId = nextId + 1
            pending[nextId] = p
            exports.cis_refs:byId(i, nextId)
        end
        Citizen.Await(p)
        if i % 500 == 0 then
            local kb = collectgarbage('count')
            if kb > maxKb then maxKb = kb end
        end
    end
    print(('CISREFS %-7s %.0f ms, heap max %.0f KB, end %.0f KB, worst frame %.1f ms'):format(mode, (os.nanotime() - t0) / 1e6, maxKb, collectgarbage('count'), worst))
end

RegisterCommand('cis_refs', function(src)
    if src ~= 0 then return end
    CreateThread(function()
        for _, m in ipairs({ 'perCall', 'byId', 'ret', 'noop', 'perCall', 'byId', 'ret', 'noop' }) do run(m) end
        print('CISREFS done')
    end)
end, true)
