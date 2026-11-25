'use strict';

// Pick the public resources for the SQL corpus and pin each to a commit.
// The named frameworks and scripts come first, then the most starred FiveM Lua
// repositories, until COUNT of them send SQL. Writes tests/corpus/repos.json.
// Needs `gh` signed in. Usage: node tests/corpus/pick.js [count]

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { cloneAt, statementsOf } = require('./fetch.js');

const COUNT = Number(process.argv[2]) || 154;
const OUT = path.join(__dirname, 'repos.json');

// Organisations whose resources the README names, each repository with SQL.
const ORGS = ['esx-framework', 'qbcore-framework', 'Qbox-project', 'overextended', 'communityox',
    'ND-Framework', 'project-error', 'Project-Sloth', 'Renewed-Scripts', 'iLLeniumStudios'];
const NAMED = ['ImagicTheCat/vRP'];
const SEARCHES = ['topic:fivem language:Lua', 'topic:fivem-script language:Lua', 'topic:qbcore language:Lua',
    'topic:esx language:Lua', 'topic:qbox language:Lua', 'oxmysql language:Lua'];

function gh(args) {
    return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', timeout: 120000, maxBuffer: 64 << 20 }));
}

function candidates() {
    const seen = new Set();
    const list = [];
    const add = (full, group) => {
        const k = full.toLowerCase();
        if (seen.has(k)) return;
        seen.add(k);
        list.push({ repo: full, group });
    };
    for (const n of NAMED) add(n, 'named');
    for (const org of ORGS) {
        const rows = gh(['repo', 'list', org, '--limit', '200', '--no-archived', '--source', '--json', 'nameWithOwner,stargazerCount,primaryLanguage']);
        rows.filter((r) => !r.primaryLanguage || /lua|javascript|typescript/i.test(r.primaryLanguage.name))
            .sort((a, b) => b.stargazerCount - a.stargazerCount)
            .forEach((r) => add(r.nameWithOwner, 'named'));
    }
    for (const q of SEARCHES) {
        const rows = gh(['search', 'repos', ...q.split(' '), '--sort', 'stars', '--limit', '200', '--json', 'fullName,isArchived,isFork']);
        rows.filter((r) => !r.isArchived && !r.isFork).forEach((r) => add(r.fullName, 'sample'));
    }
    return list;
}

function main() {
    const keep = [];
    const list = candidates();
    console.log(list.length + ' candidates');
    for (const c of list) {
        if (keep.length >= COUNT) break;
        let pinned;
        try { pinned = cloneAt(c.repo, null); } catch (e) { console.log('skip ' + c.repo + ': ' + e.message.split('\n')[0]); continue; }
        const n = statementsOf(pinned.dir).length;
        if (!n) continue;
        keep.push({ repo: c.repo, sha: pinned.sha, group: c.group });
        console.log(keep.length + ' ' + c.repo + ' ' + pinned.sha.slice(0, 7) + ' ' + n + ' statements');
    }
    fs.writeFileSync(OUT, JSON.stringify(keep, null, 2) + '\n');
    console.log('wrote ' + keep.length + ' repos to ' + path.relative(process.cwd(), OUT));
}

if (require.main === module) main();
