'use strict';

// Review L13: identity.lua warned about a renamed folder only when the name
// did not start with "cis_database", so cis_database_old or cis_database-main
// booted without the warning, though provide 'oxmysql' and the license both
// need the exact name. Only "cis_database" itself is quiet now.
// identity.lua runs under a stock Lua with a stubbed GetCurrentResourceName.
// Usage: node tests/repro/folder_name.js (needs `lua` on PATH, else SKIP)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const identity = fs.readFileSync(path.join(__dirname, '..', '..', 'identity.lua'), 'utf8');

const driver = `
local src = io.read('a')
local function warns(name)
    local said = false
    GetCurrentResourceName = function() return name end
    print = function(s) if tostring(s):find('WARNING') then said = true end end
    load(src, 'identity.lua')()
    return said
end
local out = io.stdout
local function check(label, ok) out:write((ok and 'PASS ' or 'FAIL ') .. label .. '\\n') end
check('cis_database is quiet', not warns('cis_database'))
check('a path ending in cis_database is quiet', not warns('resources/[cis]/cis_database'))
check('cis_database_old warns', warns('cis_database_old'))
check('cis_database-main warns', warns('cis_database-main'))
check('oxmysql warns', warns('oxmysql'))
`;

const r = spawnSync('lua', ['-e', driver], { input: identity, encoding: 'utf8', timeout: 20000 });
if (r.error && r.error.code === 'ENOENT') {
    console.log('SKIP lua not on PATH');
    process.exit(0);
}
const out = (r.stdout || '') + (r.stderr || '');
process.stdout.write(out);
const lines = out.split('\n').filter((l) => /^(PASS|FAIL) /.test(l));
const failed = lines.filter((l) => l.startsWith('FAIL')).length;
const ok = r.status === 0 && lines.length === 5 && failed === 0;
console.log(ok ? 'all ' + lines.length + ' passed' : (failed || 1) + ' of ' + Math.max(lines.length, 5) + ' failed');
process.exit(ok ? 0 : 1);
