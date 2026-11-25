# Security policy

## Reporting a vulnerability

Email **info@cisoko.net** with "security" in the subject and:

- the `cis_database` version (`cis_version` in `fxmanifest.lua`) and your FXServer build;
- what an attacker can do, and the steps to reproduce it;
- whether the issue is already public.

Please do not open a public issue for a vulnerability.

## What happens next

- We acknowledge the report within 72 hours.
- We confirm or reject it, and agree a disclosure date with you, within 7 days.
- A fix ships as a GitHub release with a CHANGELOG entry that credits you, unless you ask us not to.

## Supported versions

Only the latest release gets security fixes. The resource checks GitHub for a newer release at start and logs a warning when one exists.

## Scope

In scope:

- SQL that reaches MariaDB or SQLite with a meaning the caller did not send;
- internal exports or events reachable by another resource or by a client;
- the `/cis_db` dashboard and its ACE check;
- lost or reordered writes.

Out of scope: weak MariaDB passwords, a server that grants the dashboard ACE to everyone, and bugs in other resources that call this one.
