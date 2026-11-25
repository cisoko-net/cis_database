-- Test only. Every command is console-only (source 0) and prints one
-- CISPROBE line that tests/fxserver/vps_check.sh waits for in the log.

local function tagOk(tag)
    return type(tag) == 'string' and tag:match('^[%w_]+$') ~= nil and #tag <= 32
end

RegisterCommand('cisprobe_setup', function(source)
    if source ~= 0 then return end
    CreateThread(function()
        MySQL.query.await('CREATE TABLE IF NOT EXISTS cis_probe (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, tag VARCHAR(32) NOT NULL, n INT NOT NULL)')
        MySQL.query.await('CREATE TABLE IF NOT EXISTS cis_probe_last (tag VARCHAR(32) NOT NULL PRIMARY KEY, n INT NOT NULL)')
        print('CISPROBE setup ok')
    end)
end, true)

-- Writes rows n = 1..count for a tag, and after each insert moves the tag's
-- single cis_probe_last row to n. Every call is awaited, so each write is
-- acknowledged before the next one starts.
RegisterCommand('cisprobe_write', function(source, args)
    if source ~= 0 then return end
    local tag, count = args[1], tonumber(args[2])
    if not tagOk(tag) or not count or count < 1 or count > 100000 then
        print('CISPROBE usage: cisprobe_write <tag> <count 1..100000>')
        return
    end
    count = math.floor(count)
    CreateThread(function()
        MySQL.update.await('DELETE FROM cis_probe_last WHERE tag = ?', { tag })
        MySQL.insert.await('INSERT INTO cis_probe_last (tag, n) VALUES (?, 0)', { tag })
        local t0 = os.clock()
        for i = 1, count do
            MySQL.insert.await('INSERT INTO cis_probe (tag, n) VALUES (?, ?)', { tag, i })
            MySQL.update.await('UPDATE cis_probe_last SET n = ? WHERE tag = ?', { i, tag })
        end
        print(('CISPROBE wrote %s acked=%d cpu_s=%.2f'):format(tag, count, os.clock() - t0))
    end)
end, true)

-- What SQLite holds for a tag, read through cis_database.
RegisterCommand('cisprobe_count', function(source, args)
    if source ~= 0 then return end
    local tag = args[1]
    if not tagOk(tag) then
        print('CISPROBE usage: cisprobe_count <tag>')
        return
    end
    CreateThread(function()
        local row = MySQL.single.await('SELECT COUNT(*) AS c, COUNT(DISTINCT n) AS d, MAX(n) AS mx FROM cis_probe WHERE tag = ?', { tag }) or {}
        local last = MySQL.scalar.await('SELECT n FROM cis_probe_last WHERE tag = ?', { tag })
        print(('CISPROBE sqlite %s count=%s distinct=%s max=%s last=%s'):format(tag, tostring(row.c), tostring(row.d), tostring(row.mx), tostring(last)))
    end)
end, true)

print('CISPROBE loaded')
