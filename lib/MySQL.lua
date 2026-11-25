-- Written for cis_database from the oxmysql documentation, without oxmysql's source.
-- Await runs in the caller resource VM.

local resourceName = GetCurrentResourceName()

-- mysql_option entries in the calling resource's fxmanifest, as in oxmysql.
-- return_callback_errors: a failed query calls the callback as (nil, message)
-- instead of only printing the error.
local options = { return_callback_errors = false }
for i = 1, GetNumResourceMetadata(resourceName, 'mysql_option') do
    local option = GetResourceMetadata(resourceName, 'mysql_option', i - 1)
    if option then
        options[option] = true
    end
end

local function driverName()
    if GetResourceState('cis_database') == 'started' then
        return 'cis_database'
    end
    if GetResourceState('oxmysql') == 'started' then
        return 'oxmysql'
    end
    return 'cis_database'
end

-- The driver's export table, resolved on first use instead of on every query
-- (two native calls and an exports lookup each time). A driver starting or
-- stopping clears it, so the next query resolves again.
local driverExports = nil

local function driver()
    local exp = driverExports
    if exp then
        return exp
    end
    local name = driverName()
    exp = exports[name]
    if GetResourceState(name) == 'started' then
        driverExports = exp
    end
    return exp
end

-- The .await fast path (cis_database only; see exportCallPath in server.js).
-- One resolver is registered per resource instead of passing a new Lua
-- function on every call: FXServer keeps each passed function, and what it
-- captures, alive until V8 collects it. A call that ran at once comes back as
-- the export's return value; one held back by the slice budget comes back
-- through the resolver.
local pendingCalls = {}
local callExport = nil
-- An older cis_database has no cis_register; asked once per start.
local noFastPath = false

local function settle(id, result, err)
    local p = pendingCalls[id]
    if not p then
        return
    end
    pendingCalls[id] = nil
    if err ~= nil and err ~= '' then
        p:reject(err)
    else
        p:resolve(result)
    end
end

-- (id, result, err) for one answer, or (0, n, ids, results, errors) for a
-- batch: the writes one WAL sync answered come over in one call.
local function onResult(id, a, b, c, d)
    if id == 0 then
        for i = 1, a do
            settle(b[i], c and c[i], d and d[i])
        end
        return
    end
    settle(id, a, b)
end

local function fastCall()
    if callExport then
        return callExport
    end
    if noFastPath or driverName() ~= 'cis_database' or GetResourceState('cis_database') ~= 'started' then
        return nil
    end
    local exp = exports.cis_database
    local ok, registered = pcall(function()
        return exp.cis_register(nil, onResult, 2)
    end)
    if ok and registered == true then
        callExport = exp.cis_call
    else
        noFastPath = true
    end
    return callExport
end

local function forgetDriver(name)
    if name == 'cis_database' or name == 'oxmysql' then
        driverExports = nil
        callExport = nil
        noFastPath = false
    end
end

AddEventHandler('onResourceStart', forgetDriver)
AddEventHandler('onResourceStop', function(name)
    -- Any resource can TriggerEvent('onResourceStop', 'cis_database'). Only a
    -- real stop has it in the stopping state.
    if GetResourceState(name) ~= 'stopping' then
        return
    end
    forgetDriver(name)
    -- Calls cis_database held back when it stopped will not be answered.
    if name == 'cis_database' and next(pendingCalls) then
        local waiting = pendingCalls
        pendingCalls = {}
        for _, p in pairs(waiting) do
            p:reject('cis_database stopped')
        end
    end
end)

-- CFX export wrapper is function(self, ...); first arg is dropped.
-- Dot-call without the dummy self eats the SQL string. The last argument
-- asks the driver to call cb with (nil, message) on an error; without it the
-- error is printed and cb is not called.
local function invoke(method, query, parameters, cb, wantErrors)
    if wantErrors == nil then
        wantErrors = options.return_callback_errors
    end
    return driver()[method](nil, query, parameters, cb, resourceName, wantErrors)
end

local function awaitCall(method, query, parameters)
    local call = fastCall()
    if call then
        local r = call(nil, method, query, parameters)
        local state = r and r[1]
        if state == 1 then
            return r[2]
        end
        if state == 0 then
            local p = promise.new()
            pendingCalls[r[2]] = p
            return Citizen.Await(p)
        end
        if state == 2 then
            -- Raised the same way Citizen.Await raises a rejected call.
            local p = promise.new()
            p:reject(r[2])
            return Citizen.Await(p)
        end
        -- [3]: cis_database restarted and lost the resolver. Register again
        -- on the next call; this one takes the callback path below.
        callExport = nil
    end
    local p = promise.new()
    invoke(method, query, parameters, function(result, err)
        if err ~= nil and err ~= '' then
            return p:reject(err)
        end
        p:resolve(result)
    end, true)
    return Citizen.Await(p)
end

-- ---- Argument rules ---------------------------------------------------------------------------

-- A callback is a Lua function, or a function reference that arrived from
-- another resource: a table with __cfx_functionReference set.
local function isCallback(v)
    if type(v) == 'function' then
        return true
    end
    return type(v) == 'table' and v.__cfx_functionReference ~= nil
end

-- Returns query, parameters, cb for a call. withCb is false for .await, which
-- has no callback to take. Errors point at the caller's line (level 3: this
-- function, the method wrapper, the caller).
local storedQueries = {}

local function readArgs(name, query, parameters, cb, withCb)
    local qt = type(query)
    if qt == 'number' and name ~= 'transaction' then
        -- A number MySQL.store handed back.
        local stored = storedQueries[query]
        if not stored then
            error(('MySQL.%s received %s as its query, but MySQL.store never handed back that number'):format(name, tostring(query)), 3)
        end
        query, qt = stored, 'string'
    end
    if qt ~= 'string' and not (name == 'transaction' and qt == 'table') then
        local want = name == 'transaction' and 'a query string or a list of queries' or 'a query string'
        error(('MySQL.%s wants %s as its first argument, but received %s'):format(name, want, qt), 3)
    end
    if parameters == nil then
        parameters = {}
    elseif withCb and isCallback(parameters) then
        -- (query, cb): no parameters
        cb = parameters
        parameters = {}
    elseif type(parameters) ~= 'table' or isCallback(parameters) then
        error(('MySQL.%s wants the parameters as a table%s, but received %s'):format(name, withCb and ' or a callback' or '', type(parameters)), 3)
    end
    if withCb and cb ~= nil and not isCallback(cb) then
        error(('MySQL.%s wants the callback as a function, but received %s'):format(name, type(cb)), 3)
    end
    return query, parameters, cb
end

-- ---- Methods ----------------------------------------------------------------------------------

MySQL = MySQL or {}

-- For the export cis_call does not run (startTransaction): wait for
-- the export's own callback.
local function awaitCallback(method, query, parameters)
    local p = promise.new()
    invoke(method, query, parameters, function(result, err)
        if err ~= nil and err ~= '' then
            return p:reject(err)
        end
        p:resolve(result)
    end, true)
    return Citizen.Await(p)
end

-- MySQL.<name>(query, parameters, cb) and MySQL.<name>.await(query, parameters).
-- finish, when given, turns the driver's answer into the call's result.
local function newMethod(name, wait, finish)
    local method = {
        await = function(query, parameters)
            local q, p = readArgs(name, query, parameters, nil, false)
            local result = wait(name, q, p)
            if finish then
                return finish(q, result)
            end
            return result
        end,
    }
    return setmetatable(method, {
        __call = function(_, query, parameters, cb)
            local q, p, c = readArgs(name, query, parameters, cb, true)
            local result = invoke(name, q, p, c)
            if finish then
                return finish(q, result)
            end
            return result
        end,
    })
end

for _, name in ipairs({ 'query', 'single', 'scalar', 'update', 'insert', 'prepare', 'rawExecute', 'transaction' }) do
    MySQL[name] = newMethod(name, awaitCall)
end

-- store keeps the query here and hands back its number, to cb and as the
-- return value; any later call takes the number in place of the SQL.
local function storeQuery(query)
    if type(query) ~= 'string' then
        error('MySQL.store wants a query string, but received ' .. type(query), 3)
    end
    local id = #storedQueries + 1
    storedQueries[id] = query
    return id
end

MySQL.store = setmetatable({
    await = function(query)
        return storeQuery(query)
    end,
}, {
    __call = function(_, query, cb)
        local id = storeQuery(query)
        if cb ~= nil then
            if not isCallback(cb) then
                error('MySQL.store wants the callback as a function, but received ' .. type(cb), 2)
            end
            cb(id)
        end
        return id
    end,
})

-- startTransaction(fn, cb): cis_database answers false and runs nothing
-- (docs/KNOWN-GAPS.md), so fn is only handed over.
local function checkTransactionFn(fn, cb)
    if type(fn) ~= 'function' and not isCallback(fn) then
        error('MySQL.startTransaction wants a function as its first argument, but received ' .. type(fn), 3)
    end
    if cb ~= nil and not isCallback(cb) then
        error('MySQL.startTransaction wants the callback as a function, but received ' .. type(cb), 3)
    end
end

MySQL.startTransaction = setmetatable({
    await = function(fn)
        checkTransactionFn(fn, nil)
        return awaitCallback('startTransaction', fn, nil)
    end,
}, {
    __call = function(_, fn, cb)
        checkTransactionFn(fn, cb)
        return invoke('startTransaction', fn, cb, nil)
    end,
})

-- ---- ready ------------------------------------------------------------------------------------

-- True once the driver says so. A driver without isReady raises on the call;
-- then the resource state is all there is to go by.
local function engineUp()
    local ok, up = pcall(function()
        return driver().isReady(nil)
    end)
    if ok and up ~= nil then
        return up == true
    end
    return GetResourceState(driverName()) == 'started'
end

-- A driver that is not up after 30 s gets one warning naming it and its
-- resource state; from then on the wait checks once a second, since each
-- check is a call into another resource.
local function waitForEngine()
    local started, warned = GetGameTimer(), false
    while not engineUp() do
        if not warned and GetGameTimer() - started >= 30000 then
            warned = true
            local name = driverName()
            print(('^3[%s] MySQL.ready is still waiting for %s after 30 s (resource state: %s)^0'):format(
                GetCurrentResourceName(), name, GetResourceState(name)))
        end
        Wait(warned and 1000 or 50)
    end
end

MySQL.ready = setmetatable({
    await = function()
        waitForEngine()
        return true
    end,
}, {
    __call = function(_, cb)
        if not isCallback(cb) then
            error('MySQL.ready wants a function, but received ' .. type(cb), 2)
        end
        Citizen.CreateThreadNow(function()
            waitForEngine()
            cb()
        end)
    end,
})

-- ---- Older names ------------------------------------------------------------------------------

MySQL.execute = MySQL.query
MySQL.fetch = MySQL.query
MySQL.fetchAll = MySQL.query
MySQL.fetchSingle = MySQL.single
MySQL.fetchScalar = MySQL.scalar

-- mysql-async: Async takes callbacks, Sync waits.
MySQL.Async = rawget(MySQL, 'Async') or {}
MySQL.Sync = rawget(MySQL, 'Sync') or {}

for alias, name in pairs({
    fetchAll = 'query',
    fetchScalar = 'scalar',
    fetchSingle = 'single',
    execute = 'update',
    insert = 'insert',
    transaction = 'transaction',
    prepare = 'prepare',
    store = 'store',
}) do
    MySQL.Async[alias] = MySQL[name]
    MySQL.Sync[alias] = MySQL[name].await
end

-- Any other name the driver exports (isReady, awaitConnection, ...) is
-- forwarded to it. The function is made on first read and kept.
setmetatable(MySQL, {
    __index = function(self, name)
        if type(name) ~= 'string' or name:sub(1, 2) == '__' then
            return nil
        end
        local forward = function(...)
            return driver()[name](nil, ...)
        end
        rawset(self, name, forward)
        return forward
    end,
})
