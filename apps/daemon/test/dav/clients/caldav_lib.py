# python `caldav` against the daemon: discovery from /, read-only privileges, initial sync,
# incremental sync after a server-side update + delete + add, and recovery from the 403 an
# epoch bump causes. Run by clients.e2e.ts with DAV_URL, DAV_USER, DAV_PASS and MUTATE set.
import os, subprocess
import caldav
from caldav.elements import dav

URL, USER, PASS, MUTATE = (os.environ[k] for k in ("DAV_URL", "DAV_USER", "DAV_PASS", "MUTATE"))

def mutate(*args):
    subprocess.run(["bun", MUTATE, *args], check=True, capture_output=True)

def summaries(objs):
    out = []
    for o in objs:
        try:
            out.append(str(o.icalendar_component.get("summary")))
        except Exception:
            out.append("<deleted>")
    return sorted(out)

client = caldav.DAVClient(url=URL, username=USER, password=PASS)
principal = client.principal()
print("principal:", principal.url)
assert principal.url.path == f"/dav/{USER}/", principal.url

cals = principal.calendars()
names = sorted(c.url.path.rstrip("/").split("/")[-1] for c in cals)
print("calendars:", names)
assert names == ["bulk", "busy", "merged", "work"], names

work = next(c for c in cals if c.url.path.endswith("/work/"))
privs = work.get_property(dav.CurrentUserPrivilegeSet())
print("work privileges:", privs)
assert "write" not in str(privs) and "read" in str(privs)

objs = work.objects_by_sync_token(load_objects=True)
tok1 = objs.sync_token
initial = summaries(objs)
print("initial sync:", initial, "token", tok1)
assert initial == ["Floating wake-up", "Holidays", "Shared meeting", "Weekly sync"], initial

mutate("put", "work", "allday@example.com", "Holidays (edited)")
mutate("delete", "work", "floating@example.com")
mutate("put", "work", "new-one@example.com", "Brand new")
objs2 = work.objects_by_sync_token(sync_token=tok1, load_objects=True)
changed = summaries(objs2)
print("incremental sync:", changed, "token", objs2.sync_token)
assert changed == ["<deleted>", "Brand new", "Holidays (edited)"], changed

mutate("bump-epoch", "work")
objs3 = work.objects_by_sync_token(sync_token=objs2.sync_token, load_objects=False)
count = len(list(objs3))
print("after epoch bump:", count, "objects, token", objs3.sync_token)
assert count == 4, count
print("OK")
