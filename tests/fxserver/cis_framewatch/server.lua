-- Test only. Measures the gap between Wait(0) resumes, the same way the
-- shootout's hitch counter does, and prints one CISFRAMES line every 2 s.
-- It has no dependencies, so it runs the same under oxmysql and cis_database.

local HITCH_MS = 16.6
local WINDOW_MS = 2000
local LIMITS = { 4, 8, 16.6, 33, 50, 100 }

local function nowMs()
    local ok, v = pcall(os.nanotime)
    if ok and type(v) == 'number' then
        return v / 1000000
    end
    return GetGameTimer() + 0.0
end

CreateThread(function()
    local t0 = nowMs()
    local last = t0
    local winStart = t0
    local n, hitches, maxGap, sum, hitchSum = 0, 0, 0.0, 0.0, 0.0
    local b = { 0, 0, 0, 0, 0, 0, 0 }
    while true do
        Wait(0)
        local t = nowMs()
        local gap = t - last
        last = t
        n = n + 1
        sum = sum + gap
        if gap > maxGap then maxGap = gap end
        if gap > HITCH_MS then
            hitches = hitches + 1
            hitchSum = hitchSum + gap
        end
        local i = 1
        while i <= #LIMITS and gap >= LIMITS[i] do i = i + 1 end
        b[i] = b[i] + 1
        if t - winStart >= WINDOW_MS then
            print(('CISFRAMES t=%.1f frames=%d hitches=%d hitch_ms=%.1f max=%.1f mean=%.2f b=%d,%d,%d,%d,%d,%d,%d'):format(
                (winStart - t0) / 1000, n, hitches, hitchSum, maxGap, sum / n, b[1], b[2], b[3], b[4], b[5], b[6], b[7]))
            winStart = t
            n, hitches, maxGap, sum, hitchSum = 0, 0, 0.0, 0.0, 0.0
            b = { 0, 0, 0, 0, 0, 0, 0 }
        end
    end
end)
