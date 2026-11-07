# Python `caldav` library against the feed spike: discovery, read-only detection, time-range
# search, multiget, and RFC 6578 incremental sync across a server-side update + delete + epoch bump.
import subprocess, sys
from datetime import datetime, timezone
import caldav
from caldav.elements import dav

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5232/"
FEED = "/Users/user/work/playground/supercal/spikes/feed"

def mutate(*args):
    subprocess.run(["bun", "src/mutate.ts", *args], cwd=FEED, check=True, capture_output=True)

client = caldav.DAVClient(url=URL, username="meridian", password="meridian-app-pw")
principal = client.principal()
print("principal:", principal.url)
cals = principal.calendars()
print("calendars:", [(c.name, str(c.url)) for c in cals])
work = next(c for c in cals if c.url.path.endswith("/work/"))
privs = work.get_property(dav.CurrentUserPrivilegeSet())
print("work privileges:", privs)

evs = work.search(start=datetime(2026, 11, 1, tzinfo=timezone.utc), end=datetime(2026, 11, 30, tzinfo=timezone.utc), event=True, expand=False)
print("work time-range Nov 2026:", sorted(e.icalendar_component.get("summary") for e in evs))

# Initial sync
objs = work.objects_by_sync_token(load_objects=True)
tok1 = objs.sync_token
print("initial sync:", len(list(objs)), "objects, token", tok1)

mutate("update", "1", "allday@example.com", "Holidays (edited)")
mutate("delete", "1", "floating@example.com")
mutate("add", "1", "new-one@example.com", "Brand new")
objs2 = work.objects_by_sync_token(sync_token=tok1, load_objects=True)
changed = []
for o in objs2:
    try:
        changed.append(str(o.icalendar_component.get("summary")))
    except Exception:
        changed.append("<deleted> " + str(o.url))
print("incremental sync after update+delete+add:", changed, "token", objs2.sync_token)

# Epoch bump -> old token must be rejected (403 valid-sync-token) and the lib must recover
mutate("bump-epoch", "1")
try:
    objs3 = work.objects_by_sync_token(sync_token=objs2.sync_token, load_objects=False)
    print("after epoch bump, lib returned", len(list(objs3)), "objects, token", objs3.sync_token)
except Exception as e:
    print("after epoch bump, lib raised:", type(e).__name__, str(e)[:200])

# Same UID in two collections (merged-raw-uids keeps source UIDs; work also has them)
raw = next(c for c in principal.calendars() if c.url.path.endswith("/merged-raw-uids/"))
uids_work = {o.icalendar_component.get("uid") for o in work.events()}
uids_raw = {o.icalendar_component.get("uid") for o in raw.events()}
print("UIDs shared between 'work' and 'merged-raw-uids':", sorted(uids_work & uids_raw))
merged = next(c for c in principal.calendars() if c.url.path.endswith("/merged/"))
print("merged (rewritten UIDs):", sorted((str(o.icalendar_component.get("uid")), str(o.icalendar_component.get("summary"))) for o in merged.events()))
