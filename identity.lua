-- GetCurrentResourceName is CFX shared. Offline suites have no native; skip.
-- A renamed folder still boots. provide 'oxmysql' only works under cis_database.
-- LICENSE.md requires the canonical folder name.

if type(GetCurrentResourceName) == 'function' then
    local ok, name = pcall(GetCurrentResourceName)
    if ok and type(name) == 'string' then
        local base = name:match('([^/\\]+)$') or name
        if base ~= 'cis_database' then
            print('^1----------------------------------------------------------------------^7')
            print('^1[cis_database] WARNING: Resource folder name is "' .. name .. '".^7')
            print('^1The license requires the canonical name "cis_database".^7')
            print('^3Drop-in exports will fail if the folder is renamed.^7')
            print('^1----------------------------------------------------------------------^7')
        end
    end
end
