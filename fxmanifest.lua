fx_version 'cerulean'
game 'gta5'
lua54 'yes'
node_version '22'

name 'cis_database'
author 'Cisoko'
description 'SQLite game database with a MariaDB copy. Provides oxmysql, mysql-async and ghmattimysql.'
version '2.14.3'

-- Product version. version above stays 2.14.3 because ox_inventory requires
-- an oxmysql version. The version check compares cis_version with the latest
-- GitHub release tag.
cis_version '1.0.0'

-- node:sqlite needs the Node 22 server runtime. That runtime shipped in
-- FXServer on 2025-02-11 (commit 6c7a57388c, "Updated NodeJS to v22 and
-- V8 to v12.4"). The recommended artifact this resource is tested on is
-- build 35245. Older servers have Node 16 only, and node_version '22'
-- does not load there.
-- OneSync and a game build are not required. This resource has no
-- entities, no state bags, and no client natives.
dependencies {
    '/server:35245',
}

-- Resources that depend on one of these names are served by this resource.
-- Never run it beside a real oxmysql, mysql-async or ghmattimysql.
provide 'oxmysql'
provide 'mysql-async'
provide 'ghmattimysql'

server_scripts {
    'identity.lua',
    'server.js',
    'index.lua',
    'lib/MySQL.lua',
}

-- The oxmysql / mysql-async / ghmattimysql API, plus the engine's own exports
-- (execMany, queryMany, probe, shutdown, flushReplica, reloadTable, hydrate,
-- cis_dash_*). shutdown, flushReplica, reloadTable, hydrate and cis_dash_*
-- refuse calls from other resources. cis_register and cis_call, the path the
-- include's .await forms use (API.md), are registered by server.js itself.
server_exports {
    'query', 'query_async', 'querySync',
    'single', 'single_async', 'singleSync',
    'scalar', 'scalar_async', 'scalarSync',
    'update', 'update_async', 'updateSync',
    'insert', 'insert_async', 'insertSync',
    'prepare', 'prepare_async', 'prepareSync',
    'transaction', 'transaction_async', 'transactionSync',
    'startTransaction',
    'rawExecute', 'rawExecute_async', 'rawExecuteSync',
    'store', 'store_async', 'storeSync',
    'fetchAll',
    'execute', 'execute_async', 'executeSync',
    'fetch', 'fetch_async', 'fetchSync',
    'fetchSingle',
    'fetchScalar',
    'isReady',
    'ready',
    'awaitConnection',
    'shutdown',
    'probe',
    'execMany',
    'queryMany',
    'flushReplica',
    'reloadTable',
    'hydrate',
    'cis_dash_snapshot',
    'cis_dash_watch',
}

-- Admin dashboard (/cis_db): NUI page built from web/src.
ui_page 'web/dist/index.html'

nui_callback_strict_mode 'true'

client_script 'client/dashboard.lua'
server_script 'server/dashboard.lua'

files {
    'lib/MySQL.lua',
    'web/dist/index.html',
    'web/dist/cisoko-logo.png',
    'web/dist/assets/*',
}
