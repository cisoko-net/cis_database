# Security notes

How to run cis_database safely. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

- **Give the resource its own MariaDB user.** The default connection string uses `root`, which is fine for a test box only. A read SQLite cannot run goes to MariaDB as written, so the user in `mysql_connection_string` should have rights on the game database alone, and no `FILE` privilege: then `LOAD_FILE()` and `SELECT ... INTO OUTFILE` cannot reach the machine's files whatever a script sends. For example:

  ```sql
  CREATE USER 'cis'@'127.0.0.1' IDENTIFIED BY 'a long random password';
  GRANT ALL PRIVILEGES ON yourdb.* TO 'cis'@'127.0.0.1';
  ```

- **`cache/` is the game database.** It holds every table, the outbox and, right after an upgrade, spill files from an older build. Its contents are sent to MariaDB at the next start. Keep the folder private: do not share it, commit it, or leave it in a zip of the resource you pass on. File permissions there do not protect it on Windows; the folder's location does.
- **`config.json` values are checked.** `sqlite.journal_mode`, `synchronous`, `locking_mode` and `wal_autocheckpoint` must be a value SQLite takes for that setting. Anything else is logged and replaced by the default.
- **Performance mode trades writes for speed.** `cis_database_mode "performance"` runs SQLite with `journal_mode=OFF` and `synchronous=0`. A crash of the server or of the machine loses every write MariaDB had not yet confirmed, and can leave the SQLite file damaged. Use `durable` (the default) on a live server.
- **The dashboard shows SQL text.** Slow queries in `/cis_db` show up to 500 characters of the statement, with `?` where parameters were bound. A script that pastes values into its SQL instead of binding them shows those values to anyone with the `cis_database.dashboard` ACE. Grant that ACE to admins only.
