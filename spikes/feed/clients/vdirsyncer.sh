#!/bin/sh
# Prove incremental sync with vdirsyncer: discover, sync, server-side change/delete/add, sync again.
set -e
cd "$(dirname "$0")/.."
W=/private/tmp/claude-501/-Users-user-work-playground-supercal/2c9dfad9-ad70-4f53-9d6c-07256ea8bfe7/scratchpad/vds
V="uvx --quiet vdirsyncer@0.19.3 -c clients/vdirsyncer.conf"
rm -rf $W && mkdir -p $W/cals $W/status
bun src/seed.ts >/dev/null
yes | $V discover feed >/dev/null 2>&1
echo "--- sync 1"; $V sync 2>&1 | tail -n 20
for d in $W/cals/*; do echo "$(basename $d): $(ls $d | wc -l | tr -d ' ') items"; done
echo "--- server-side: update allday, delete floating, add new-one (source 1)"
bun src/mutate.ts update 1 allday@example.com "Holidays (edited)" >/dev/null
bun src/mutate.ts delete 1 floating@example.com >/dev/null
bun src/mutate.ts add 1 new-one@example.com "Brand new" >/dev/null
echo "--- sync 2"; $V sync 2>&1 | tail -n 30
for d in $W/cals/*; do echo "$(basename $d): $(ls $d | wc -l | tr -d ' ') items"; done
grep -l "Holidays (edited)" $W/cals/work/*.ics >/dev/null && echo "work: edited summary present locally"
grep -l "Floating wake-up" $W/cals/work/*.ics >/dev/null || echo "work: deleted event gone locally"
echo "--- epoch bump on work (pub 1), then sync 3"
bun src/mutate.ts bump-epoch 1 >/dev/null
$V sync 2>&1 | tail -n 10
echo "work: $(ls $W/cals/work | wc -l | tr -d ' ') items after epoch bump"
echo "--- same UID across collections on disk"
grep -h "^UID:" $W/cals/work/*.ics $W/cals/merged-raw-uids/*.ics | sort | uniq -c | sort -rn | head -n 3
