fx_version 'cerulean'
game 'gta5'
lua54 'yes'

name 'cis_probe'
author 'Cisoko'
description 'Test only. Console commands that write and count rows through cis_database. Never ship.'
version '1.0.0'

server_scripts {
    '@cis_database/lib/MySQL.lua',
    'server.lua',
}

dependency 'cis_database'
