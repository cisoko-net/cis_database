fx_version 'cerulean'
game 'gta5'
lua54 'yes'
node_version '22'

name 'cis_refs'
description 'Test only. Lua heap growth when every export call passes a new Lua callback, against one callback registered once.'

server_script 'refs.js'
server_script 'refs.lua'
