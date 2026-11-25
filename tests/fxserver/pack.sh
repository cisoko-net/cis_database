#!/usr/bin/env bash
# Test only. Builds tmp/cis_database_pkg.tar.gz from a commit (default HEAD):
# the resource tree .github/workflows/release.yml ships, node_modules from this
# checkout, the cis_probe, cis_framewatch and cis_exportcheck test resources,
# and vps_check.sh. git archive keeps LF
# line endings, which the bash script needs on Linux. The test tools always
# come from HEAD, so an older ref can be packaged for an A/B run:
#   pack.sh 948a7d7
set -euo pipefail
cd "$(dirname "$0")/../.."
[[ -f node_modules/mysql2/package.json ]] || { echo "run npm ci first" >&2; exit 1; }
if [[ -n "$(git status --porcelain -- . ':!tmp')" ]]; then
    echo "note: uncommitted changes are not in the package (it is built from HEAD)" >&2
fi
ref=${1:-HEAD}
build=$(git rev-parse --short "$ref")
out=tmp/cis_database_pkg.tar.gz
stage=$(mktemp -d)
mkdir -p tmp "$stage/cis_database"
git -c core.autocrlf=false archive --format=tar "$ref" \
    fxmanifest.lua server.js dialect.js collation.js cdc.js identity.lua index.lua package.json package-lock.json \
    config.json README.md API.md LICENSE.md lib client server compat web/dist \
    | tar -x -C "$stage/cis_database"
cp -a node_modules "$stage/cis_database/node_modules"
rm -rf "$stage/cis_database/web/node_modules" "$stage/cis_database/node_modules/.cache"
git -c core.autocrlf=false archive --format=tar HEAD tests/fxserver/cis_probe tests/fxserver/cis_framewatch tests/fxserver/cis_exportcheck tests/fxserver/vps_check.sh bench | tar -x -C "$stage"
mv "$stage/tests/fxserver/cis_probe" "$stage/cis_probe"
mv "$stage/tests/fxserver/cis_framewatch" "$stage/cis_framewatch"
mv "$stage/tests/fxserver/cis_exportcheck" "$stage/cis_exportcheck"
mv "$stage/tests/fxserver/vps_check.sh" "$stage/vps_check.sh"
rm -rf "$stage/tests"
echo "$build" > "$stage/BUILD"
echo "$build" > "$stage/cis_database/BUILD"
tar -czf "$out" -C "$stage" cis_database cis_probe cis_framewatch cis_exportcheck vps_check.sh bench BUILD
rm -rf "$stage"
echo "$out built from $build (test tools from $(git rev-parse --short HEAD))"
