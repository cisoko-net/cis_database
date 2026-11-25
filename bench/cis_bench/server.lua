-- cis_bench: one real-server benchmark for any oxmysql-compatible driver.
--
-- The same file runs on every pass; bench/run_bench.sh only swaps the
-- @<driver>/lib/MySQL.lua include and the convars. Every workload uses the
-- driver the way game resources do: MySQL.*.await from Lua threads, from many
-- threads at once, with the server ticking. Latency is measured around each
-- call in the calling coroutine. Server frames are measured by a Wait(0)
-- thread in this resource, against the idle frame time of the same boot.
--
-- Writes are deterministic: a thread only SETs rows it owns, shared rows only
-- take increments, and inserts are counted, not identified. The final
-- checksums must be identical for every driver and every run, and for
-- cis_database also identical in MariaDB once its outbox is empty.

local DRIVER = GetConvar('cis_bench_driver', 'unknown')
-- Several cis_database builds can be compared in one run; the label tells
-- their result files apart. It defaults to the driver name.
local LABEL = GetConvar('cis_bench_label', DRIVER)
local RUN = GetConvar('cis_bench_run', '1')
local SCALE = tonumber(GetConvar('cis_bench_scale', '1')) or 1
-- 'seed' stops after the bulk import (for quick bulk-path runs).
local ONLY = GetConvar('cis_bench_only', '')
local RESULT_FILE = ('results_%s_%s.json'):format(LABEL, RUN)

local PLAYERS = math.floor(20000 * SCALE)
local VEHICLES_PER = 2
local LAT_N = math.floor(2000 * SCALE)

local function now()
    return os.nanotime()
end

local function log(fmt, ...)
    print(('[cis_bench] ' .. fmt):format(...))
end

-- ---------------------------------------------------------------- frames

local frameGaps = nil
local frameThreshold = 66.7
-- Each long frame with this resource's Lua heap (KB) at the frame before and
-- after it: a large drop means a Lua GC cycle ran in that frame.
local longFrames = nil

CreateThread(function()
    local last = now()
    local lastKb = collectgarbage('count')
    while true do
        Wait(0)
        local t = now()
        local kb = collectgarbage('count')
        local gaps = frameGaps
        if gaps then
            local g = (t - last) / 1e6
            gaps[#gaps + 1] = g
            if g > frameThreshold and longFrames and #longFrames < 40 then
                longFrames[#longFrames + 1] = { gap_ms = g, heap_kb_before = lastKb, heap_kb_after = kb }
            end
        end
        last = t
        lastKb = kb
    end
end)

local function pct(sorted, p)
    local n = #sorted
    if n == 0 then return 0 end
    local i = math.floor(p * (n - 1)) + 1
    return sorted[i]
end

local function frameStart()
    frameGaps = {}
    longFrames = {}
end

local function frameStop()
    local gaps = frameGaps or {}
    local longs = longFrames or {}
    frameGaps = nil
    longFrames = nil
    local sorted = {}
    local sum, over, long = 0, 0, 0
    for i = 1, #gaps do
        local g = gaps[i]
        sorted[i] = g
        sum = sum + g
        if g > frameThreshold then
            long = long + 1
            over = over + (g - frameThreshold)
        end
    end
    table.sort(sorted)
    local n = #sorted
    return {
        frames = n,
        mean_ms = n > 0 and sum / n or 0,
        p99_ms = pct(sorted, 0.99),
        max_ms = sorted[n] or 0,
        long = long,
        over_ms = over,
        threshold_ms = frameThreshold,
        long_frames = longs,
    }
end

local function describeLong(f)
    local parts = {}
    for i = 1, math.min(#f.long_frames, 8) do
        local x = f.long_frames[i]
        parts[#parts + 1] = ('%.0fms heap %.0f->%.0fKB'):format(x.gap_ms, x.heap_kb_before, x.heap_kb_after)
    end
    return table.concat(parts, ', ')
end

-- ---------------------------------------------------------------- stats

local function latency(samples)
    local sorted = {}
    local sum = 0
    for i = 1, #samples do
        sorted[i] = samples[i]
        sum = sum + samples[i]
    end
    table.sort(sorted)
    local n = #sorted
    return {
        n = n,
        mean_us = n > 0 and sum / n or 0,
        p50_us = pct(sorted, 0.50),
        p95_us = pct(sorted, 0.95),
        p99_us = pct(sorted, 0.99),
        max_us = sorted[n] or 0,
    }
end

-- Park-Miller: the same sequence for a seed on every driver.
local function rng(seed)
    local s = seed % 2147483647
    if s <= 0 then s = s + 2147483646 end
    return function(n)
        s = (s * 16807) % 2147483647
        return (s % n) + 1
    end
end

local function cid(i) return ('C%07d'):format(i) end
local function license(i) return ('license:%040d'):format(i) end
local function plate(i, k) return ('P%06dX%d'):format(i, k) end

local JOBS = { 'unemployed', 'unemployed', 'unemployed', 'police', 'ambulance', 'mechanic', 'taxi', 'realestate' }

local function charinfo(i)
    return json.encode({ firstname = 'First' .. i, lastname = 'Last' .. i, birthdate = '1990-01-01', gender = i % 2, nationality = 'American', phone = ('555%07d'):format(i), account = ('US%010d'):format(i) })
end

local function metadata(i, hunger)
    return json.encode({ hunger = hunger, thirst = 100 - (hunger % 40), stress = i % 30, armor = 0, isdead = false, inlaststand = false, jailitems = {}, status = {}, phone = {}, fitbit = {}, commandbinds = {}, bloodtype = 'O+', walletid = ('W%07d'):format(i), criminalrecord = { hasRecord = false }, licences = { driver = true, business = false, weapon = false } })
end

local function inventory(i, n)
    local items = {}
    for k = 1, 12 do
        items[#items + 1] = { slot = k, name = (k % 3 == 0) and 'water' or ((k % 3 == 1) and 'bread' or 'phone'), count = ((i + k + n) % 20) + 1, metadata = {} }
    end
    return json.encode(items)
end

-- ---------------------------------------------------------------- schema

local function schema()
    for _, t in ipairs({ 'cbench_players', 'cbench_vehicles', 'cbench_bank_tx', 'cbench_messages', 'cbench_sat_log' }) do
        MySQL.query.await('DROP TABLE IF EXISTS ' .. t)
    end
    MySQL.query.await([[CREATE TABLE cbench_players (
        citizenid VARCHAR(16) NOT NULL,
        license VARCHAR(64) NOT NULL,
        name VARCHAR(64) NOT NULL,
        jobname VARCHAR(32) NOT NULL DEFAULT 'unemployed',
        money INT NOT NULL DEFAULT 0,
        bank INT NOT NULL DEFAULT 0,
        charinfo LONGTEXT,
        job LONGTEXT,
        metadata LONGTEXT,
        inventory LONGTEXT,
        position VARCHAR(128),
        last_updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (citizenid),
        UNIQUE KEY license (license),
        KEY jobname (jobname)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4]])
    MySQL.query.await([[CREATE TABLE cbench_vehicles (
        id INT NOT NULL AUTO_INCREMENT,
        citizenid VARCHAR(16) NOT NULL,
        plate VARCHAR(12) NOT NULL,
        vehicle VARCHAR(32) NOT NULL,
        mods LONGTEXT,
        garage VARCHAR(32) DEFAULT 'pillboxgarage',
        fuel INT NOT NULL DEFAULT 100,
        engine FLOAT NOT NULL DEFAULT 1000,
        body FLOAT NOT NULL DEFAULT 1000,
        state INT NOT NULL DEFAULT 1,
        PRIMARY KEY (id),
        UNIQUE KEY plate (plate),
        KEY citizenid (citizenid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4]])
    MySQL.query.await([[CREATE TABLE cbench_bank_tx (
        id INT NOT NULL AUTO_INCREMENT,
        citizenid VARCHAR(16) NOT NULL,
        amount INT NOT NULL,
        reason VARCHAR(64) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY citizenid (citizenid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4]])
    MySQL.query.await([[CREATE TABLE cbench_messages (
        id INT NOT NULL AUTO_INCREMENT,
        sender VARCHAR(16) NOT NULL,
        receiver VARCHAR(16) NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY receiver (receiver)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4]])
    MySQL.query.await([[CREATE TABLE cbench_sat_log (
        id INT NOT NULL AUTO_INCREMENT,
        citizenid VARCHAR(16) NOT NULL,
        action VARCHAR(32) NOT NULL,
        PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4]])
end

-- Bulk import in multi-row INSERTs of 250 rows, the way a migration or a
-- framework installer loads data.
local function seed()
    local B = 250
    for base = 1, PLAYERS, B do
        local last = math.min(PLAYERS, base + B - 1)
        local rows, vals = {}, {}
        local vrows, vvals = {}, {}
        for i = base, last do
            rows[#rows + 1] = '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            local job = JOBS[(i % #JOBS) + 1]
            local v = vals
            v[#v + 1] = cid(i); v[#v + 1] = license(i); v[#v + 1] = 'First' .. i .. ' Last' .. i
            v[#v + 1] = job; v[#v + 1] = 500 + (i % 1000); v[#v + 1] = 10000 + (i % 50000)
            v[#v + 1] = charinfo(i); v[#v + 1] = json.encode({ name = job, label = job, grade = { level = i % 4 } })
            v[#v + 1] = metadata(i, 100); v[#v + 1] = inventory(i, 0); v[#v + 1] = '{"x":0.0,"y":0.0,"z":0.0}'
            for k = 1, VEHICLES_PER do
                vrows[#vrows + 1] = '(?, ?, ?, ?)'
                vvals[#vvals + 1] = cid(i); vvals[#vvals + 1] = plate(i, k); vvals[#vvals + 1] = (k == 1) and 'sultan' or 'asea'; vvals[#vvals + 1] = '{"color1":1,"color2":2}'
            end
        end
        MySQL.query.await('INSERT INTO cbench_players (citizenid, license, name, jobname, money, bank, charinfo, job, metadata, inventory, position) VALUES ' .. table.concat(rows, ','), vals)
        MySQL.query.await('INSERT INTO cbench_vehicles (citizenid, plate, vehicle, mods) VALUES ' .. table.concat(vrows, ','), vvals)
    end
    -- History tables start with some rows, as on a live server.
    for base = 1, math.floor(PLAYERS / 2), B do
        local last = math.min(math.floor(PLAYERS / 2), base + B - 1)
        local trows, tvals, mrows, mvals = {}, {}, {}, {}
        for i = base, last do
            trows[#trows + 1] = '(?, ?, ?)'
            tvals[#tvals + 1] = cid(i); tvals[#tvals + 1] = 100 + i % 900; tvals[#tvals + 1] = 'paycheck'
            mrows[#mrows + 1] = '(?, ?, ?)'
            mvals[#mvals + 1] = cid(i); mvals[#mvals + 1] = cid((i % PLAYERS) + 1); mvals[#mvals + 1] = 'hello ' .. i
        end
        MySQL.query.await('INSERT INTO cbench_bank_tx (citizenid, amount, reason) VALUES ' .. table.concat(trows, ','), tvals)
        MySQL.query.await('INSERT INTO cbench_messages (sender, receiver, message) VALUES ' .. table.concat(mrows, ','), mvals)
    end
end

-- ---------------------------------------------------------------- operations

-- One call of each kind a game server makes all day. own(i) = rows the
-- caller may SET; shared rows only get increments.
local OPS = {}

OPS.read_player = function(i)
    return MySQL.single.await('SELECT citizenid, license, name, money, bank, charinfo, job, metadata, position FROM cbench_players WHERE citizenid = ?', { cid(i) })
end
OPS.read_by_license = function(i)
    return MySQL.single.await('SELECT citizenid, name, charinfo, money FROM cbench_players WHERE license = ? LIMIT 1', { license(i) })
end
OPS.read_vehicles = function(i)
    return MySQL.query.await('SELECT plate, vehicle, mods, garage, fuel, engine, body, state FROM cbench_vehicles WHERE citizenid = ?', { cid(i) })
end
OPS.read_inventory = function(i)
    return MySQL.scalar.await('SELECT inventory FROM cbench_players WHERE citizenid = ?', { cid(i) })
end
OPS.read_messages = function(i)
    return MySQL.query.await('SELECT sender, message, created_at FROM cbench_messages WHERE receiver = ? ORDER BY id DESC LIMIT 20', { cid(i) })
end
OPS.read_bank_log = function(i)
    return MySQL.query.await('SELECT amount, reason, created_at FROM cbench_bank_tx WHERE citizenid = ? ORDER BY id DESC LIMIT 10', { cid(i) })
end
OPS.count_police = function()
    return MySQL.scalar.await('SELECT COUNT(*) FROM cbench_players WHERE jobname = ?', { 'police' })
end
OPS.json_hunger = function(i)
    return MySQL.scalar.await("SELECT JSON_EXTRACT(metadata, '$.hunger') FROM cbench_players WHERE citizenid = ?", { cid(i) })
end
OPS.richest = function()
    return MySQL.query.await('SELECT citizenid, name, bank FROM cbench_players ORDER BY bank DESC LIMIT 10')
end
OPS.in_list = function(i)
    return MySQL.query.await('SELECT citizenid, money FROM cbench_players WHERE citizenid IN (?)', { { cid(i), cid(i + 1), cid(i + 2), cid(i + 3), cid(i + 4) } })
end
OPS.save_player = function(i, n)
    return MySQL.update.await('UPDATE cbench_players SET money = ?, charinfo = ?, metadata = ?, position = ?, last_updated = CURRENT_TIMESTAMP WHERE citizenid = ?',
        { 500 + n, charinfo(i), metadata(i, n % 100), ('{"x":%d.0,"y":%d.0,"z":30.0}'):format(n, i), cid(i) })
end
OPS.save_inventory = function(i, n)
    return MySQL.update.await('UPDATE cbench_players SET inventory = ? WHERE citizenid = ?', { inventory(i, n), cid(i) })
end
OPS.bank_transfer = function(i, n)
    local to = (i * 7 + n) % PLAYERS + 1
    return MySQL.transaction.await({
        { query = 'UPDATE cbench_players SET bank = bank - ? WHERE citizenid = ?', values = { 25, cid(i) } },
        { query = 'UPDATE cbench_players SET bank = bank + ? WHERE citizenid = ?', values = { 25, cid(to) } },
        { query = 'INSERT INTO cbench_bank_tx (citizenid, amount, reason) VALUES (?, ?, ?)', values = { cid(i), -25, 'transfer' } },
    })
end
OPS.send_message = function(i, n)
    return MySQL.insert.await('INSERT INTO cbench_messages (sender, receiver, message) VALUES (?, ?, ?)', { cid(i), cid((i + n) % PLAYERS + 1), 'msg ' .. n })
end
OPS.vehicle_update = function(i, n)
    return MySQL.update.await('UPDATE cbench_vehicles SET fuel = ?, engine = ?, body = ? WHERE plate = ?', { n % 100, 1000 - (n % 50), 1000 - (n % 70), plate(i, 1) })
end
OPS.pay_salary = function(i)
    return MySQL.update.await('UPDATE cbench_players SET bank = bank + ? WHERE citizenid = ?', { 150, cid(i) })
end

-- 80 % reads / 20 % writes, weighted like a busy RP server.
local MIX = {
    { 'read_player', 25 }, { 'read_vehicles', 14 }, { 'read_inventory', 16 }, { 'read_messages', 12 },
    { 'read_bank_log', 10 }, { 'count_police', 3 },
    { 'save_player', 6 }, { 'save_inventory', 5 }, { 'bank_transfer', 4 }, { 'send_message', 3 }, { 'vehicle_update', 2 },
}
local MIX_TOTAL = 0
for _, m in ipairs(MIX) do MIX_TOTAL = MIX_TOTAL + m[2] end

local function pick(r)
    local x = r(MIX_TOTAL)
    for _, m in ipairs(MIX) do
        x = x - m[2]
        if x <= 0 then return m[1] end
    end
    return MIX[1][1]
end

local errors = 0
local errorSample = nil

local function timed(name, fn, ...)
    local t0 = now()
    local ok, err = pcall(fn, ...)
    local dt = (now() - t0) / 1000
    if not ok then
        errors = errors + 1
        errorSample = errorSample or (name .. ': ' .. tostring(err))
    end
    return dt, ok
end

-- ---------------------------------------------------------------- workloads

local results = { driver = DRIVER, label = LABEL, run = tonumber(RUN), scale = SCALE, players = PLAYERS }

-- 1. Sequential latency: one thread, one call at a time.
local function latencySuite()
    local list = {
        { 'read_player', function(k) return OPS.read_player((k * 37) % PLAYERS + 1) end },
        { 'read_by_license', function(k) return OPS.read_by_license((k * 41) % PLAYERS + 1) end },
        { 'read_vehicles', function(k) return OPS.read_vehicles((k * 43) % PLAYERS + 1) end },
        { 'read_messages', function(k) return OPS.read_messages((k * 47) % PLAYERS + 1) end },
        { 'json_hunger', function(k) return OPS.json_hunger((k * 53) % PLAYERS + 1) end },
        { 'in_list', function(k) return OPS.in_list((k * 59) % (PLAYERS - 5) + 1) end },
        { 'count_police', function() return OPS.count_police() end },
        { 'richest', function() return OPS.richest() end },
        { 'save_player', function(k) return OPS.save_player((k * 61) % PLAYERS + 1, k) end },
        { 'save_inventory', function(k) return OPS.save_inventory((k * 67) % PLAYERS + 1, k) end },
        { 'send_message', function(k) return OPS.send_message((k * 71) % PLAYERS + 1, k) end },
        { 'bank_transfer', function(k) return OPS.bank_transfer((k * 73) % PLAYERS + 1, k) end },
    }
    local out = {}
    for _, item in ipairs(list) do
        local n = (item[1] == 'count_police' or item[1] == 'richest') and math.floor(LAT_N / 4) or LAT_N
        local samples = {}
        frameStart()
        for k = 1, n do
            samples[#samples + 1] = timed(item[1], item[2], k)
        end
        local f = frameStop()
        local s = latency(samples)
        s.frames = f
        out[item[1]] = s
        log('latency %-16s n=%d mean=%.1fus p50=%.1f p99=%.1f max=%.1f', item[1], s.n, s.mean_us, s.p50_us, s.p99_us, s.max_us)
        Wait(0)
    end
    return out
end

-- 2. A live server: `players` threads, each a player doing `actions` calls
-- picked from MIX with think time between them.
local function liveServer(players, actions, thinkMs)
    local perOp = {}
    local left = players
    local t0 = now()
    frameStart()
    for p = 1, players do
        CreateThread(function()
            local r = rng(p * 7919 + players)
            local me = (p * 97) % PLAYERS + 1
            Wait(r(thinkMs))
            for n = 1, actions do
                local op = pick(r)
                local dt = timed(op, OPS[op], me, n)
                local s = perOp[op]
                if not s then s = {}; perOp[op] = s end
                s[#s + 1] = dt
                Wait(r(thinkMs))
            end
            left = left - 1
        end)
    end
    while left > 0 do Wait(0) end
    local wall = (now() - t0) / 1e9
    local f = frameStop()
    local all = {}
    local ops = {}
    for op, samples in pairs(perOp) do
        ops[op] = latency(samples)
        for i = 1, #samples do all[#all + 1] = samples[i] end
    end
    local info = { players = players, actions = actions, think_ms = thinkMs, wall_s = wall, qps = #all / wall, all = latency(all), ops = ops, frames = f }
    log('live %d players: %.0f calls/s mean=%.1fus p99=%.1fus | frames long=%d max=%.1fms %s', players, info.qps, info.all.mean_us, info.all.p99_us, f.long, f.max_ms, describeLong(f))
    return info
end

-- 3. Join storm: `n` players connect in the same second. Each join is the
-- handful of reads a framework and its scripts run for a new player.
local function joinStorm(n)
    local samples = {}
    local left = n
    local t0 = now()
    frameStart()
    for p = 1, n do
        CreateThread(function()
            local i = (p * 131) % PLAYERS + 1
            local a = now()
            local ok = pcall(function()
                OPS.read_by_license(i)
                OPS.read_player(i)
                OPS.read_vehicles(i)
                OPS.read_inventory(i)
                OPS.read_messages(i)
                OPS.read_bank_log(i)
                MySQL.update.await('UPDATE cbench_players SET last_updated = CURRENT_TIMESTAMP WHERE citizenid = ?', { cid(i) })
            end)
            if not ok then errors = errors + 1 end
            samples[#samples + 1] = (now() - a) / 1000
            left = left - 1
        end)
    end
    while left > 0 do Wait(0) end
    local info = { joins = n, wall_ms = (now() - t0) / 1e6, per_join = latency(samples), frames = frameStop() }
    log('join storm %d: all joined in %.1f ms, p99 join %.1f us | frames long=%d max=%.1fms %s', n, info.wall_ms, info.per_join.p99_us, info.frames.long, info.frames.max_ms, describeLong(info.frames))
    return info
end

-- 4. Save storm: every online player saved at once (txAdmin restart warning,
-- a framework's periodic save-all).
local function saveStorm(n)
    local samples = {}
    local left = n
    local t0 = now()
    frameStart()
    for p = 1, n do
        CreateThread(function()
            local i = (p * 151) % PLAYERS + 1
            local a = now()
            local ok = pcall(function()
                OPS.save_player(i, 1000 + p)
                OPS.save_inventory(i, 1000 + p)
                OPS.vehicle_update(i, 1000 + p)
            end)
            if not ok then errors = errors + 1 end
            samples[#samples + 1] = (now() - a) / 1000
            left = left - 1
        end)
    end
    while left > 0 do Wait(0) end
    local info = { saves = n, wall_ms = (now() - t0) / 1e6, per_save = latency(samples), frames = frameStop() }
    log('save storm %d: all saved in %.1f ms, p99 save %.1f us | frames long=%d max=%.1fms %s', n, info.wall_ms, info.per_save.p99_us, info.frames.long, info.frames.max_ms, describeLong(info.frames))
    return info
end

-- 5. Payday: one script pays every player in a loop (sequential awaits).
local function payday(n)
    local t0 = now()
    frameStart()
    local samples = {}
    for p = 1, n do
        samples[#samples + 1] = timed('pay_salary', OPS.pay_salary, (p * 163) % PLAYERS + 1)
    end
    local info = { paid = n, wall_ms = (now() - t0) / 1e6, per_call = latency(samples), frames = frameStop() }
    log('payday %d: %.1f ms | frames long=%d max=%.1fms %s', n, info.wall_ms, info.frames.long, info.frames.max_ms, describeLong(info.frames))
    return info
end

-- 6. Saturation: `threads` threads call back to back for `seconds`.
-- Reads hit the main tables; writes go to cbench_sat_log, which is left out
-- of the checksums because the count depends on speed.
local function saturation(threads, seconds)
    local count = 0
    local stopAt = now() + seconds * 1e9
    local left = threads
    local samples = {}
    frameStart()
    local t0 = now()
    for t = 1, threads do
        CreateThread(function()
            local r = rng(t * 104729)
            while now() < stopAt do
                local x = r(100)
                local i = r(PLAYERS)
                local dt
                if x <= 80 then
                    local op = (x <= 40) and 'read_player' or ((x <= 60) and 'read_inventory' or 'read_vehicles')
                    dt = timed(op, OPS[op], i)
                else
                    dt = timed('sat_insert', function() return MySQL.insert.await('INSERT INTO cbench_sat_log (citizenid, action) VALUES (?, ?)', { cid(i), 'sat' }) end)
                end
                count = count + 1
                if count % 8 == 0 then samples[#samples + 1] = dt end
            end
            left = left - 1
        end)
    end
    while left > 0 do Wait(0) end
    local wall = (now() - t0) / 1e9
    local info = { threads = threads, seconds = wall, calls = count, qps = count / wall, sampled = latency(samples), frames = frameStop() }
    log('saturation %d threads: %.0f calls/s | frames long=%d max=%.1fms %s', threads, info.qps, info.frames.long, info.frames.max_ms, describeLong(info.frames))
    return info
end

local function checksums()
    local p = MySQL.single.await('SELECT COUNT(*) AS n, SUM(money) AS money, SUM(bank) AS bank, SUM(LENGTH(inventory)) AS inv, SUM(LENGTH(metadata)) AS meta, SUM(LENGTH(position)) AS pos FROM cbench_players')
    local v = MySQL.single.await('SELECT COUNT(*) AS n, SUM(fuel) AS fuel, SUM(engine) AS engine, SUM(body) AS body FROM cbench_vehicles')
    local t = MySQL.single.await('SELECT COUNT(*) AS n, SUM(amount) AS amount FROM cbench_bank_tx')
    local m = MySQL.single.await('SELECT COUNT(*) AS n, SUM(LENGTH(message)) AS len FROM cbench_messages')
    local function num(x) return tonumber(x) or 0 end
    return {
        players = { n = num(p.n), money = num(p.money), bank = num(p.bank), inv = num(p.inv), meta = num(p.meta), pos = num(p.pos) },
        vehicles = { n = num(v.n), fuel = num(v.fuel), engine = num(v.engine), body = num(v.body) },
        bank_tx = { n = num(t.n), amount = num(t.amount) },
        messages = { n = num(m.n), len = num(m.len) },
    }
end

-- cis_database's own counters (slice, wake, checkpoint) for one phase:
-- probe(true) returns them and starts the next phase from zero.
local function engineStats(name)
    if DRIVER ~= 'cis_database' or GetResourceState('cis_database') ~= 'started' then return end
    local ok, p = pcall(function() return exports.cis_database:probe(true) end)
    if not ok or type(p) ~= 'table' then return end
    results.engine = results.engine or {}
    results.engine[name] = p
    log('engine %-10s slice_max=%sms wake_avg=%sms wake_max=%sms queued=%s ckpt_n=%s copy_max=%sms fsync_n=%s fsync_avg=%sms fsync_max=%sms', name,
        tostring(p.slice_max_ms), tostring(p.wake_avg_ms), tostring(p.wake_max_ms), tostring(p.queued_total), tostring(p.ckpt_n), tostring(p.ckpt_copy_max_ms),
        tostring(p.fsync_n), tostring(p.fsync_avg_ms), tostring(p.fsync_max_ms))
end

local function save()
    SaveResourceFile(GetCurrentResourceName(), RESULT_FILE, json.encode(results), -1)
end

local function run()
    while GetResourceState(GetCurrentResourceName()) ~= 'started' do Wait(50) end
    MySQL.ready.await()
    -- Let the rest of the server finish starting.
    Wait(5000)
    log('start driver=%s label=%s run=%s players=%d', DRIVER, LABEL, RUN, PLAYERS)

    local t0 = now()
    schema()
    engineStats('schema')
    frameStart()
    local s0 = now()
    seed()
    local seedFrames = frameStop()
    results.seed = { players = PLAYERS, vehicles = PLAYERS * VEHICLES_PER, ms = (now() - t0) / 1e6, insert_ms = (now() - s0) / 1e6, frames = seedFrames }
    log('seed %d players + %d vehicles in %.0f ms | frames long=%d max=%.1fms', PLAYERS, PLAYERS * VEHICLES_PER, results.seed.ms, seedFrames.long, seedFrames.max_ms)
    engineStats('seed')

    if ONLY ~= 'seed' then
        -- Warm-up: statement caches, buffer pools, JIT.
        for k = 1, 3000 do
            local op = MIX[(k % #MIX) + 1][1]
            if op ~= 'bank_transfer' and op ~= 'send_message' and op ~= 'save_player' and op ~= 'save_inventory' and op ~= 'vehicle_update' then
                pcall(OPS[op], (k * 31) % PLAYERS + 1, k)
            end
        end

        -- Idle frame time of this boot sets the long-frame threshold: one 60 Hz
        -- frame (16.7 ms) past the normal tick.
        frameStart()
        Wait(10000)
        local idle = frameStop()
        frameThreshold = idle.mean_ms + 16.7
        idle.threshold_ms = frameThreshold
        results.idle = idle
        log('idle tick %.1f ms (p99 %.1f, max %.1f); long frame = over %.1f ms', idle.mean_ms, idle.p99_ms, idle.max_ms, frameThreshold)

        engineStats('boot')
        results.latency = latencySuite()
        engineStats('latency')
        save()
        results.live = {}
        for i, n in ipairs({ 64, 128, 256 }) do
            results.live[i] = liveServer(n, 60, 400)
            engineStats('live' .. n)
        end
        save()
        results.join = joinStorm(128)
        engineStats('join')
        results.save_storm = saveStorm(256)
        engineStats('save')
        results.payday = payday(5000)
        engineStats('payday')
        results.saturation = saturation(32, 10)
        engineStats('saturation')
    end
    results.errors = errors
    results.error_sample = errorSample
    results.checksums = checksums()
    results.total_s = (now() - t0) / 1e9
    save()
    log('checksums %s', json.encode(results.checksums))
    log('errors %d%s', errors, errorSample and (' first: ' .. errorSample) or '')
    log('BENCH_DONE %s', RESULT_FILE)
    -- cis_database answers from SQLite and copies to MariaDB behind. The run
    -- script compares MariaDB with the checksums above once the copy is done.
    if DRIVER == 'cis_database' and GetResourceState('cis_database') == 'started' then
        local a = now()
        local probe
        repeat
            probe = exports.cis_database:probe()
            if probe and probe.replica == 0 then break end
            Wait(100)
        until (now() - a) > 300e9
        results.outbox_drain_ms = (now() - a) / 1e6
        results.probe = probe
        save()
        log('OUTBOX_EMPTY %.0f ms (left %s)', results.outbox_drain_ms, tostring(probe and probe.replica))
    end
end

CreateThread(function()
    local ok, err = pcall(run)
    if not ok then
        log('FATAL %s', tostring(err))
        results.fatal = tostring(err)
        save()
    end
end)
