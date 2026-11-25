fx_version 'cerulean'
game 'gta5'
lua54 'yes'

name 'cis_drill'
author 'Cisoko'
description 'Outage drill for cis_database: numbered writes and a count, from the server console. Test only, never shipped.'
version '1.0.0'

dependency 'oxmysql'

server_scripts {
    '@oxmysql/lib/MySQL.lua',
    'server.lua',
}
