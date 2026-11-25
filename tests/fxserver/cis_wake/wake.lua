-- Test only. Times Citizen.Await on each answer path of wake.js.
local function stats(t)
    table.sort(t)
    local s = 0
    for i = 1, #t do s = s + t[i] end
    return ('min=%.3f p10=%.3f mean=%.3fms p50=%.3f p90=%.3f max=%.3f'):format(t[1], t[math.floor(#t * 0.1) + 1], s / #t, t[math.floor(#t * 0.5) + 1], t[math.floor(#t * 0.9) + 1], t[#t])
end

RegisterCommand('cis_wake', function(src)
    if src ~= 0 then return end
    CreateThread(function()
        local p0 = promise.new()
        exports.cis_wake:workerInfo(function(s) p0:resolve(s) end)
        print('CISWAKE worker ' .. tostring(Citizen.Await(p0)))
        for _, mode in ipairs({ 'sync', 'micro', 'io', 'worker' }) do
            local t = {}
            for i = 1, 100 do
                local a = os.nanotime()
                local p = promise.new()
                exports.cis_wake:later(mode, function() p:resolve(true) end)
                Citizen.Await(p)
                t[#t + 1] = (os.nanotime() - a) / 1e6
            end
            print(('CISWAKE lua %-9s %s'):format(mode, stats(t)))
            Wait(100)
        end
        for _, mode in ipairs({ 'immediate', 'timeout0', 'io', 'worker', 'workersql' }) do
            local t = {}
            for i = 1, 50 do
                local p = promise.new()
                exports.cis_wake:jsLate(mode, function(ms) p:resolve(ms) end)
                t[#t + 1] = Citizen.Await(p)
            end
            print(('CISWAKE js  %-9s %s'):format(mode, stats(t)))
        end
        print('CISWAKE done')
    end)
end, true)

RegisterCommand('cis_wake2', function(src)
    if src ~= 0 then return end
    CreateThread(function()
        local p0 = promise.new()
        exports.cis_wake:wakeInfo(function(s) p0:resolve(s) end)
        print('CISWAKE2 wakers ' .. tostring(Citizen.Await(p0)))
        for _, busy in ipairs({ false, true }) do
            for _, mode in ipairs({ 'io', 'mc', 'udp', 'tcp' }) do
                local t = {}
                for i = 1, 60 do
                    local p = promise.new()
                    exports.cis_wake:wakeLate(mode, busy, function(ms) p:resolve(ms) end)
                    t[#t + 1] = Citizen.Await(p)
                    if busy then Wait(0) end
                end
                print(('CISWAKE2 %-4s busy=%-5s %s'):format(mode, tostring(busy), stats(t)))
            end
        end
        print('CISWAKE2 done')
    end)
end, true)

RegisterCommand('cis_wake3', function(src)
    if src ~= 0 then return end
    CreateThread(function()
        for _, mode in ipairs({ 'io', 'fsync', 'fsyncow', 'fsync', 'fsyncow' }) do
            local t = {}
            for i = 1, 200 do
                local p = promise.new()
                exports.cis_wake:wakeLate(mode, false, function(ms) p:resolve(ms) end)
                t[#t + 1] = Citizen.Await(p)
            end
            print(('CISWAKE3 %-6s %s'):format(mode, stats(t)))
        end
        local t = {}
        for i = 1, 200 do
            local p = promise.new()
            exports.cis_wake:fsyncSyncMs(function(ms) p:resolve(ms) end)
            t[#t + 1] = Citizen.Await(p)
        end
        print(('CISWAKE3 %-6s %s'):format('fsync-blocking', stats(t)))
        print('CISWAKE3 done')
    end)
end, true)
