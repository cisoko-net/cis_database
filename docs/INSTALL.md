# Install, update and remove cis_database

The short version is in the [README](../README.md#install). This page has every detail.

The resource folder must be named `cis_database`. `provide 'oxmysql'` only remaps `@oxmysql` when the folder has that name. GitHub's "Source code" downloads unpack as `cis_database-1.0.0`: rename that folder to `cis_database`.

## Requirements

- FXServer build **35245** or newer. The manifest refuses to start on an older build.
- Node 22, set by `node_version '22'`. `node:sqlite` is part of that runtime. If it is missing, the resource logs that it fell back to `sql.js`.
- MariaDB or MySQL on the same machine when you want the game copy filled from an existing database, and when you want writes copied back. The connection string is a server convar, not a replicated one:

  ```
  set mysql_connection_string "mysql://cis:password@127.0.0.1:3306/yourdb?charset=utf8mb4"
  ```

  Use a MariaDB user of its own (`cis` here) with rights on that database only, not `root`; [SECURITY-NOTES.md](SECURITY-NOTES.md) has the `CREATE USER` statements.

  On Windows, `localhost` in that string is rewritten to `127.0.0.1`.

  A MariaDB on another machine needs TLS, or game data and the password cross the network in plain text. Add `ssl=true` (`?ssl=true` in the URL form, `;ssl=true` in the `key=value` form) to connect with TLS and check the server's certificate. `ssl` also takes mysql2's TLS options as JSON, for example `ssl={"rejectUnauthorized":false}` for a self-signed certificate (URL-encode it in the URL form). Without `ssl`, the resource warns at boot when the host is not this machine.

OneSync is not required. No game build is required.

The resource is not server-only. It ships an optional admin dashboard (`ui_page`, `client/dashboard.lua` and `web/dist`, about 250 KB) that every player downloads. Only an admin who has the ACE `cis_database.dashboard` can open it with `/cis_db`.

## Install

Back up your database first. Take a dump of the MariaDB database the server uses (`mysqldump --single-transaction yourdb > backup.sql`, or your host panel's backup) before the first start, so you can go back to it whatever happens.

1. Stop `oxmysql`. Do not `ensure` both. This resource and a real `oxmysql` provide the same name. Remove the `ensure oxmysql` line. If the `oxmysql` folder is inside a category that `server.cfg` starts as a whole, such as `ensure [standalone]` in the QBCore recipe, also move the folder out of every such category, for example to `resources/[disabled]`, which no `ensure` line names. Without the move, the category line still starts oxmysql.
2. Put this folder in `resources`, or inside a category such as `resources/[standalone]`.
3. Set the connection string above.
4. Start it before every resource that runs SQL. Put this line where `ensure oxmysql` was:

   ```
   ensure cis_database
   ```

   Some recipes have no `ensure oxmysql` line and start oxmysql through a category instead. The QBCore recipe starts it with `ensure [standalone]`, after `ensure qb-core`. There, put `ensure cis_database` above the framework's first line (`ensure qb-core`).

Scripts that already use `@oxmysql/lib/MySQL.lua`, `exports.oxmysql`, or the `exports['mysql-async']` and `exports.ghmattimysql` names oxmysql answers do not need an edit. A script that does not want the oxmysql include calls `exports.cis_database` directly. That surface is in [API.md](../API.md).

To check the install, type `cis_database_doctor` in the server console. It prints one line per check (folder name, a real `oxmysql` started beside it, `config.json`, ready, the SQLite file, the WAL checkpoint, the MariaDB copy, the `ALTER` privilege), each `OK`, `WARN` or `FAIL`, and the fix for anything that is not `OK`. It answers the server console only, never a player.

## What it adds to MariaDB

cis_database creates two tables of its own in the database that `mysql_connection_string` names:

- `__cis_replica_state` records how far each SQLite file was copied to MariaDB, so a `cache/` older than MariaDB is found at boot ([HOW-IT-WORKS.md](HOW-IT-WORKS.md#what-a-query-waits-for)).
- `__cis_id_reserve` records each raise of a copied table's `AUTO_INCREMENT` counter, which keeps a row inserted straight into MariaDB from taking an id the game hands out ([CONFIG.md](CONFIG.md#changedatacapture-cdc)).

Of your own tables it changes only that `AUTO_INCREMENT` counter. Their columns, keys and rows change only through the statements your resources send, as with oxmysql. Leave both tables in place while you use cis_database; oxmysql does not read them.

## Going back to oxmysql

MariaDB stays the system of record, so going back is a config change, not a migration. Your data is in MariaDB as long as the outbox is empty when you stop.

1. Keep MariaDB up. Open `/cis_db` and wait until **Write-behind queue** reads 0.
2. Stop the server. A txAdmin stop sends what is left in the outbox to MariaDB before the resources stop; a `quit` in the console only waits for a copy already running. If the console prints `writes wait in the outbox for MariaDB; they are sent after the next start`, MariaDB did not take them: start the server again with cis_database, fix MariaDB, and stop once the queue is 0.
3. In `server.cfg`, replace `ensure cis_database` with `ensure oxmysql`. If you moved the `oxmysql` folder out of a category at install, move it back, and move `cis_database` out of every category that `server.cfg` starts as a whole, so that only one of the two starts. The same `mysql_connection_string` works for both.
4. Start the server. oxmysql reads and writes the same MariaDB database.

Leave the `cis_database` folder and its `cache/` where they are if you may come back. Every start with cis_database copies again each table MariaDB changed, so what oxmysql wrote in between is what the game reads. A table with writes still in the outbox from before keeps its copy until those writes are in MariaDB, then is copied again. To start clean instead, delete `cache/` while the server is stopped, only once the queue was 0 at the last stop.

## Versions

On boot the resource asks GitHub for the latest release of `cisoko-net/cis_database`. When the installed version is older, the console prints both lines:

```
cis_database 1.0.0 is outdated. Latest release is v1.0.1.
What is new in v1.0.1:
```

A beta is older than the final release with the same number: `1.0.0-beta.1` is told about `v1.0.0`.

The text under that is the release description published on GitHub. A current install prints nothing. A private repo, or a failed request, prints nothing.

## Where the data lives

Durable mode stores the game database at `cache/durable.sqlite` inside this resource. Do not delete that file while the server is running.

## From source

`node_modules` is in the git tree with the runtime dependencies only (`mysql2`, `sql.js` and what they load), trimmed by `tools/trim_node_modules.sh` to what runs: sql.js's `dist/sql-asm.js` only, no type packages, tests or browser builds. A clone has them and needs no `npm ci` to start. `npm ci` installs the full set again. A GitHub release attaches `cis_database.zip` with the same trimmed modules.

With `mysql_connection_string` set and `node_modules/mysql2` missing, cis_database does not start serving: it answers no query and prints how to fix it, and `cis_database_doctor` shows `FAIL mysql2`. Copy `node_modules/` from the zip into the `cis_database` folder, then restart cis_database.

## Files

The release zip holds what the server runs:

```
cis_database/
  fxmanifest.lua
  config.json          settings (frameBudgetMs)
  server.js            engine: SQLite, durable writes, MariaDB copy, exports
  dialect.js           MySQL to SQLite translation
  collation.js         sort keys for utf8mb4_general_ci and utf8mb4_unicode_ci
  cdc.js               picks up edits made directly in MariaDB
  identity.lua         warns when the folder is renamed
  index.lua            shutdown hooks and the ready log line
  lib/MySQL.lua        the @oxmysql/lib/MySQL.lua include
  compat/oxmysql/      stub for scripts that load files from an oxmysql folder
  server/dashboard.lua, client/dashboard.lua, web/dist/   the /cis_db panel
  node_modules/        mysql2 and sql.js (dist/sql-asm.js only)
  package.json, package-lock.json
  docs/                the pages in this folder
  README.md, API.md, LICENSE.md, CHANGELOG.md, SECURITY.md, CONTRIBUTING.md
```

The repository also has `tests/` (`npm test` runs `tests/repro`; `tests/bench` holds timing scripts; `tests/fxserver` holds live-server checks), `bench/` (the FXServer shootout against oxmysql), `tools/` (the `node_modules` trim) and `web/src` (the panel's source).
