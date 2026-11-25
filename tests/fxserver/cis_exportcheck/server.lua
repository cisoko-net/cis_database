-- Test only. `cisexport_check <resource>` (console only) calls each oxmysql
-- export as exports[<resource>]:<name>(...), the way scripts that skip
-- @oxmysql/lib/MySQL.lua do, and prints one CISEXPORT line per call plus a
-- summary. Run it with cis_database (the control) and with oxmysql.

local TIMEOUT_MS = 5000

-- Calls exports[res][name](sql, params, cb) and waits for cb. Returns
-- ok, value or false, reason.
local function call(res, name, ...)
    local p = promise.new()
    local args = { ... }
    args[#args + 1] = function(result) p:resolve({ true, result }) end
    local ok, err = pcall(function()
        return exports[res][name](exports[res], table.unpack(args))
    end)
    if not ok then
        return false, tostring(err):gsub('\n.*', '')
    end
    SetTimeout(TIMEOUT_MS, function() p:resolve({ false, 'timeout' }) end)
    local out = Citizen.Await(p)
    return out[1], out[2]
end

local function check(res, name, expect, ...)
    local ok, value = call(res, name, ...)
    local pass = ok and expect(value)
    print(('CISEXPORT %s %s %s %s'):format(res, name, pass and 'PASS' or 'FAIL', ok and json.encode(value) or value))
    return pass
end

local function isNumber(v) return type(v) == 'number' end

-- Calls exports[res][name](...) with no callback and returns what the Lua
-- runtime hands back (it awaits an async retval inside this coroutine).
local function callSync(res, name, ...)
    local args = { ... }
    local ok, value = pcall(function()
        return exports[res][name](exports[res], table.unpack(args))
    end)
    if not ok then return false, tostring(value):gsub('\n.*', '') end
    return true, value
end

local function checkSync(res, name, expect, ...)
    local ok, value = callSync(res, name, ...)
    local pass = ok and expect(value)
    print(('CISEXPORT %s %s %s %s'):format(res, name, pass and 'PASS' or 'FAIL', ok and json.encode(value) or value))
    return pass
end

-- The names oxmysql v2.14.3 answers for mysql-async and ghmattimysql scripts.
local function compat(res)
    local tag = res
    local pass, total = 0, 0
    local function run(fn, ...)
        total = total + 1
        if fn(res, ...) then pass = pass + 1 end
    end
    local sel = 'SELECT n FROM cis_exportcheck WHERE tag = ?'
    if res == 'mysql-async' then
        run(check, 'mysql_execute', isNumber, 'DELETE FROM cis_exportcheck WHERE tag = ?', { tag })
        run(check, 'mysql_insert', function(v) return isNumber(v) and v > 0 end, 'INSERT INTO cis_exportcheck (tag, n) VALUES (?, ?)', { tag, 1 })
        run(check, 'mysql_execute', function(v) return v == 1 end, 'UPDATE cis_exportcheck SET n = ? WHERE tag = ?', { 2, tag })
        run(check, 'mysql_fetch_scalar', function(v) return v == 2 end, sel, { tag })
        run(check, 'mysql_fetch_all', function(v) return type(v) == 'table' and #v == 1 and v[1].n == 2 end, sel, { tag })
        run(check, 'mysql_transaction', function(v) return v == true end,
            { { query = 'UPDATE cis_exportcheck SET n = ? WHERE tag = ?', values = { 3, tag } } })
        run(check, 'mysql_store', function(v) return v == sel end, sel)
        run(check, 'mysql_execute', function(v) return v == 1 end, 'DELETE FROM cis_exportcheck WHERE tag = ?', { tag })
    else
        run(check, 'execute', function(v) return type(v) == 'table' end, 'DELETE FROM cis_exportcheck WHERE tag = ?', { tag })
        run(check, 'execute', function(v) return type(v) == 'table' and v.insertId and v.insertId > 0 end, 'INSERT INTO cis_exportcheck (tag, n) VALUES (?, ?)', { tag, 1 })
        run(check, 'scalar', function(v) return v == 1 end, sel, { tag })
        run(check, 'execute', function(v) return type(v) == 'table' and #v == 1 and v[1].n == 1 end, sel, { tag })
        run(check, 'transaction', function(v) return v == true end,
            { { query = 'UPDATE cis_exportcheck SET n = ? WHERE tag = ?', values = { 2, tag } } })
        run(checkSync, 'scalarSync', function(v) return v == 2 end, sel, { tag })
        run(checkSync, 'executeSync', function(v) return type(v) == 'table' and #v == 1 and v[1].n == 2 end, sel, { tag })
        run(checkSync, 'transactionSync', function(v) return v == true end,
            { { query = 'UPDATE cis_exportcheck SET n = ? WHERE tag = ?', values = { 3, tag } } })
        run(checkSync, 'scalarSync', function(v) return v == 3 end, sel, { tag })
        run(check, 'store', function(v) return v == sel end, sel)
        run(checkSync, 'storeSync', function(v) return v == sel end, sel)
        run(check, 'execute', function(v) return type(v) == 'table' and v.affectedRows == 1 end, 'DELETE FROM cis_exportcheck WHERE tag = ?', { tag })
    end
    print(('CISEXPORT done %s pass=%d fail=%d'):format(res, pass, total - pass))
end

RegisterCommand('cisexport_check', function(source, args)
    if source ~= 0 then return end
    local res = args[1]
    if res == 'mysql-async' or res == 'ghmattimysql' then
        CreateThread(function() compat(res) end)
        return
    end
    if res ~= 'cis_database' and res ~= 'oxmysql' then
        print('CISEXPORT usage: cisexport_check <cis_database|oxmysql|mysql-async|ghmattimysql>')
        return
    end
    CreateThread(function()
        print(('CISEXPORT state oxmysql=%s cis_database=%s'):format(GetResourceState('oxmysql'), GetResourceState('cis_database')))
        local tag = res
        local pass, total = 0, 0
        local function run(...)
            total = total + 1
            if check(res, ...) then pass = pass + 1 end
        end

        run('query', function(v) return type(v) == 'table' end,
            'CREATE TABLE IF NOT EXISTS cis_exportcheck (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, tag VARCHAR(32) NOT NULL, n INT NOT NULL)', {})
        run('update', isNumber, 'DELETE FROM cis_exportcheck WHERE tag = ?', { tag })
        run('insert', function(v) return isNumber(v) and v > 0 end, 'INSERT INTO cis_exportcheck (tag, n) VALUES (?, ?)', { tag, 1 })
        run('update', function(v) return v == 1 end, 'UPDATE cis_exportcheck SET n = ? WHERE tag = ?', { 2, tag })
        run('scalar', function(v) return v == 2 end, 'SELECT n FROM cis_exportcheck WHERE tag = ?', { tag })
        run('single', function(v) return type(v) == 'table' and v.n == 2 end, 'SELECT n FROM cis_exportcheck WHERE tag = ?', { tag })
        run('query', function(v) return type(v) == 'table' and #v == 1 end, 'SELECT n FROM cis_exportcheck WHERE tag = ?', { tag })
        run('prepare', function(v) return v == 2 end, 'SELECT n FROM cis_exportcheck WHERE tag = ?', { tag })
        run('execute', isNumber, 'UPDATE cis_exportcheck SET n = 3 WHERE tag = ?', { tag })
        run('fetchScalar', function(v) return v == 3 end, 'SELECT n FROM cis_exportcheck WHERE tag = ?', { tag })
        run('transaction', function(v) return v == true end,
            { { query = 'UPDATE cis_exportcheck SET n = ? WHERE tag = ?', values = { 4, tag } } })
        run('scalar', function(v) return v == 4 end, 'SELECT n FROM cis_exportcheck WHERE tag = ?', { tag })
        run('update', function(v) return v == 1 end, 'DELETE FROM cis_exportcheck WHERE tag = ?', { tag })

        total = total + 1
        local ok, ready = pcall(function() return exports[res]:isReady() end)
        local readyPass = ok and ready == true
        if readyPass then pass = pass + 1 end
        print(('CISEXPORT %s isReady %s %s'):format(res, readyPass and 'PASS' or 'FAIL', tostring(ready):gsub('\n.*', '')))

        print(('CISEXPORT done %s pass=%d fail=%d'):format(res, pass, total - pass))
    end)
end, true)

print('CISEXPORT loaded')
