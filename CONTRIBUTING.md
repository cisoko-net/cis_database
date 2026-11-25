# Contributing to cis_database

Thank you for helping. Bug reports, reproductions and pull requests are all welcome.

## Before you open a pull request

`cis_database` is source-available, not open source. Read `LICENSE.md` first. Section 4 holds the contributor terms: by opening a pull request you license your change to Cisoko so it can ship as part of `cis_database`. We cannot merge a pull request whose author has not agreed to them.

To agree, put this line in the pull request description:

> I have read the contributor terms in LICENSE.md section 4 and I agree to them for this contribution.

Please do not submit code copied from another project, especially GPL or LGPL code such as oxmysql (LGPL-3.0), qb-core, qbx_core or the ox resources. `cis_database` implements the oxmysql API from its documentation and observed behaviour; its source was read only to learn what a call returns, and none of its code is copied here.

## What makes a good pull request

- One fix or feature per pull request.
- A test under `tests/repro/` that fails before your change and passes after it. `npm test` runs them all on Node 22. The Lua checks need `lua` on PATH and the MariaDB checks a MariaDB 10.11 at `FX_TRUST_MARIA` (default `mysql://root@127.0.0.1:3307`); a check that cannot run prints SKIP, and a SKIP fails `npm test`. `CIS_TEST_ALLOW_SKIP=1 npm test` allows a partial run.
- `node --check server.js dialect.js cdc.js collation.js` passes.
- If you change `web/src`, rebuild `web/dist` with `cd web && npm ci && npm run build` and commit both.
- If you change behaviour that users see, update `README.md`, `API.md` or `docs/CONFIG.md` in the same pull request.

## Reporting a bug

Open an issue with:

- the FXServer artifact number and your OS;
- the resource that made the call and the SQL (redact player data);
- what you expected and what happened, with the console lines.

Security problems go through `SECURITY.md`, not a public issue.

## Sharing your changes

The license does not allow publishing a modified copy of `cis_database`. If you built something useful on top of it, send it back as a pull request, or ship it as a separate resource that calls the `cis_database` exports.
