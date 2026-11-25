fx_version 'cerulean'
game 'gta5'
lua54 'yes'

name 'cis_bench'
author 'Cisoko'
description 'Real-server database benchmark. The same Lua runs against oxmysql or cis_database; only the include below changes.'
version '1.0.0'

server_scripts {
    -- BENCH_INCLUDE (bench/run_bench.sh rewrites the next line for each pass)
    '@cis_database/lib/MySQL.lua',
    'server.lua',
}
