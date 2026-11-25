-- Stub resource named "oxmysql", so scripts that load @oxmysql/lib/MySQL.lua
-- find that file; it forwards to cis_database's include. It runs no SQL.
fx_version 'cerulean'
game 'gta5'

name 'oxmysql'
author 'Cisoko'
description 'VFS stub. SQL runs in cis_database. Do not ensure this with cis_database.'
version '2.14.3'

files {
    'lib/MySQL.lua',
}
