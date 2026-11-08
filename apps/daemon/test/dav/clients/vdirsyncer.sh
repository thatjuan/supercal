#!/bin/sh
# vdirsyncer against the daemon: discover, sync, server-side update + delete + add, sync again.
# The second sync must transfer only the changed items. Run by clients.e2e.ts with DAV_URL,
# DAV_USER, DAV_PASS, MUTATE and WORKDIR (an empty scratch directory) set.
set -eu
V="uvx --quiet vdirsyncer@0.19.3 -c $WORKDIR/vdirsyncer.conf"
mkdir -p "$WORKDIR/cals" "$WORKDIR/status"
cat >"$WORKDIR/vdirsyncer.conf" <<EOF
[general]
status_path = "$WORKDIR/status/"

[pair feed]
a = "feed_remote"
b = "feed_local"
collections = ["from a"]
conflict_resolution = "a wins"

[storage feed_remote]
type = "caldav"
url = "$DAV_URL"
username = "$DAV_USER"
password = "$DAV_PASS"
read_only = true

[storage feed_local]
type = "filesystem"
path = "$WORKDIR/cals/"
fileext = ".ics"
EOF

fail() { echo "FAIL: $*"; exit 1; }
count() { ls "$WORKDIR/cals/$1" | wc -l | tr -d ' '; }

yes | $V discover feed >/dev/null 2>&1
$V sync >/dev/null 2>&1
for c in work merged busy bulk; do echo "sync 1: $c $(count $c) items"; done
[ "$(count work)" = 4 ] || fail "work should hold 4 items"
[ "$(count bulk)" = 5000 ] || fail "bulk should hold 5000 items"

bun "$MUTATE" put work allday@example.com "Holidays (edited)"
bun "$MUTATE" delete work floating@example.com
bun "$MUTATE" put work new-one@example.com "Brand new"

out=$($V sync 2>&1)
echo "--- sync 2"; echo "$out"
transfers=$(echo "$out" | grep -cE 'Copying|Deleting' || true)
# work and merged (which includes work) each change three items; busy and bulk nothing.
[ "$transfers" = 6 ] || fail "expected 6 transfers in sync 2, got $transfers"
echo "$out" | grep -qE '(Copying|Deleting).*/(bulk|busy)$' && fail "bulk and busy should not transfer anything"
grep -l "Holidays (edited)" "$WORKDIR"/cals/work/*.ics >/dev/null || fail "edited summary missing"
grep -l "Floating wake-up" "$WORKDIR"/cals/work/*.ics >/dev/null && fail "deleted event still present"
echo OK
