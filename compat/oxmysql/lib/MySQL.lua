-- Forwards the oxmysql include to cis_database's lib/MySQL.lua, run in the
-- caller's Lua VM (load), so MySQL.*.await works as with the real oxmysql.
local body = LoadResourceFile('cis_database', 'lib/MySQL.lua')
assert(body, 'ensure cis_database before using this include')
assert(load(body, 'MySQL.lua'))()
