-- Outage drill. Console only (restricted commands; rcon runs as the console).
--
--   cis_drill_write <tag> <n> [ms]  inserts rows seq 1..n for <tag>, one at a
--                                   time, <ms> apart (default 20), and one
--                                   UPDATE of the tag's total after each insert
--   cis_drill_count <tag>           prints what the engine holds for <tag>
--
-- The table has no unique key on (tag, seq) on purpose: a write copied to
-- MariaDB twice shows up as rows > distinct, it is not hidden by an error.
-- MariaDB side of the check (run on the box):
--   mariadb <db> -e "SELECT COUNT(*) n, COUNT(DISTINCT seq) d, SUM(seq) s FROM cis_drill_rows WHERE tag='<tag>'; SELECT total FROM cis_drill_totals WHERE tag='<tag>'"
-- A complete, duplicate-free copy of n writes gives n, n, n*(n+1)/2 and the
-- same total.

local function log(msg)
    print(('[cis_drill] %s'):format(msg))
end

CreateThread(function()
    MySQL.query.await([[CREATE TABLE IF NOT EXISTS cis_drill_rows (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tag VARCHAR(32) NOT NULL,
        seq INT NOT NULL,
        at BIGINT NOT NULL,
        KEY tag_seq (tag, seq)
    )]])
    MySQL.query.await([[CREATE TABLE IF NOT EXISTS cis_drill_totals (
        tag VARCHAR(32) PRIMARY KEY,
        total BIGINT NOT NULL DEFAULT 0,
        writes INT NOT NULL DEFAULT 0
    )]])
    log('ready')
end)

local running = {}

RegisterCommand('cis_drill_write', function(source, args)
    if source ~= 0 then return end
    local tag, n, gap = args[1], tonumber(args[2]), tonumber(args[3] or '20')
    if not tag or not tag:match('^[%w_]+$') or #tag > 32 or not n or n < 1 or n > 100000 or not gap or gap < 0 then
        log('usage: cis_drill_write <tag> <n 1..100000> [ms]')
        return
    end
    if running[tag] then log(tag .. ' is already running') return end
    running[tag] = true
    CreateThread(function()
        local ok, failed, started = 0, 0, GetGameTimer()
        for seq = 1, n do
            local id = MySQL.insert.await('INSERT INTO cis_drill_rows (tag, seq, at) VALUES (?, ?, ?)', { tag, seq, os.time() })
            local up = MySQL.update.await(
                'INSERT INTO cis_drill_totals (tag, total, writes) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE total = total + VALUES(total), writes = writes + 1',
                { tag, seq })
            if id and id > 0 and up and up > 0 then ok = ok + 1 else failed = failed + 1 end
            if seq % 500 == 0 then log(('%s %d/%d written, %d failed'):format(tag, seq, n, failed)) end
            if gap > 0 then Wait(gap) end
        end
        running[tag] = nil
        log(('%s done: %d ok, %d failed, %d ms'):format(tag, ok, failed, GetGameTimer() - started))
    end)
end, true)

RegisterCommand('cis_drill_count', function(source, args)
    if source ~= 0 then return end
    local tag = args[1]
    if not tag or not tag:match('^[%w_]+$') then log('usage: cis_drill_count <tag>') return end
    -- Plain column reads, counted here: an aggregate such as SUM may be
    -- answered by MariaDB, and this must show what SQLite holds.
    local rows = MySQL.query.await('SELECT seq FROM cis_drill_rows WHERE tag = ?', { tag }) or {}
    local seen, distinct, sum = {}, 0, 0
    for _, r in ipairs(rows) do
        if not seen[r.seq] then seen[r.seq] = true distinct = distinct + 1 end
        sum = sum + r.seq
    end
    local t = MySQL.single.await('SELECT total, writes FROM cis_drill_totals WHERE tag = ?', { tag })
    log(('%s engine: rows %d distinct %d sum %d total %s writes %s'):format(tag,
        #rows, distinct, sum, t and t.total or '-', t and t.writes or '-'))
end, true)
