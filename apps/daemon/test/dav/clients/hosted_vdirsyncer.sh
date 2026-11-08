#!/bin/sh
# vdirsyncer writes each side in turn and finishes with a no-transfer run.
set -eu
V="uvx --quiet vdirsyncer@0.19.3 -c $WORKDIR/hosted.conf"
mkdir -p "$WORKDIR/cals" "$WORKDIR/status"
cat >"$WORKDIR/hosted.conf" <<CONFIG
[general]
status_path = "$WORKDIR/status/"
[pair hosted]
a = "hosted_remote"
b = "hosted_local"
collections = ["from a"]
[storage hosted_remote]
type = "caldav"
url = "$DAV_URL"
username = "$DAV_USER"
password = "$DAV_PASS"
[storage hosted_local]
type = "filesystem"
path = "$WORKDIR/cals/"
fileext = ".ics"
CONFIG
url="${DAV_URL}dav/$DAV_USER/cal/$HOSTED_CALENDAR/server-name.ics"
cat >"$WORKDIR/event.ics" <<ICS
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//vdirsyncer test//EN
BEGIN:VEVENT
UID:vdirsyncer-event
DTSTAMP:20260101T000000Z
DTSTART:20261110T090000Z
DURATION:PT1H
SUMMARY:Original
END:VEVENT
END:VCALENDAR
ICS
curl --fail --silent --show-error -u "$DAV_USER:$DAV_PASS" -H 'Content-Type: text/calendar' -T "$WORKDIR/event.ics" "$url"
yes | $V discover hosted >/dev/null 2>&1
$V sync
local_file=$(find "$WORKDIR/cals/$HOSTED_CALENDAR" -name '*.ics' -type f | head -1)
[ -n "$local_file" ] || { echo 'FAIL missing local event'; exit 1; }
python3 - "$local_file" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
p.write_bytes(p.read_bytes().replace(b'SUMMARY:Original', b'SUMMARY:Local edit'))
PY
$V sync
curl --fail --silent --show-error -u "$DAV_USER:$DAV_PASS" "$url" | grep -q 'SUMMARY:Local edit'
sed 's/SUMMARY:Original/SUMMARY:Server edit/' "$WORKDIR/event.ics" >"$WORKDIR/remote.ics"
curl --fail --silent --show-error -u "$DAV_USER:$DAV_PASS" -H 'Content-Type: text/calendar' -T "$WORKDIR/remote.ics" "$url"
$V sync
grep -q 'SUMMARY:Server edit' "$local_file"
rm "$local_file"
$V sync --force-delete "hosted/$HOSTED_CALENDAR"
status=$(curl --silent --show-error -u "$DAV_USER:$DAV_PASS" -o /dev/null -w '%{http_code}' "$url")
[ "$status" = 404 ] || { echo "FAIL deletion returned $status"; exit 1; }
out=$($V sync 2>&1)
echo "$out"
if echo "$out" | grep -qE 'Copying|Deleting|Uploading|Updating'; then
  echo 'FAIL final sync transferred items'; exit 1
fi
echo 'OK vdirsyncer two-way edits, deletion and final no-op'
