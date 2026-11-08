# Real shared-calendar writes, privacy, freebusy_request and grant transition sync tokens.
import os
import subprocess
import base64
import urllib.request
import urllib.error
from datetime import datetime, timezone
import caldav
from caldav.elements import dav

base = os.environ['DAV_URL']
cal_id = os.environ['HOSTED_CALENDAR']

def client(user, password):
    return caldav.DAVClient(url=base, username=user, password=password)

def collection(connection, username):
    return caldav.Calendar(client=connection, url=f'{base}dav/{username}/cal/{cal_id}/')

owner = client(os.environ['DAV_USER'], os.environ['DAV_PASS'])
reader = client(os.environ['SHARED_READ_USER'], os.environ['SHARED_READ_PASS'])
writer = client(os.environ['SHARED_WRITE_USER'], os.environ['SHARED_WRITE_PASS'])
read_cal = collection(reader, os.environ['SHARED_READ_USER'])
write_cal = collection(writer, os.environ['SHARED_WRITE_USER'])
owner_cal = collection(owner, os.environ['DAV_USER'])
assert 'Hosted (Writer)' in str(read_cal.get_property(dav.DisplayName()))
initial = read_cal.objects_by_sync_token(load_objects=True)
assert 'SUMMARY:Busy' in list(initial)[0].data
assert 'Secret' not in list(initial)[0].data
assert 'SUMMARY:Secret' in list(write_cal.objects_by_sync_token(load_objects=True))[0].data

body = '\r\n'.join(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Shared test//EN', 'BEGIN:VEVENT', 'UID:shared-python', 'DTSTAMP:20260101T000000Z', 'DTSTART:20261109T110000Z', 'DURATION:PT1H', 'SUMMARY:Shared python write', 'END:VEVENT', 'END:VCALENDAR', ''])
written = write_cal.save_event(body)
assert any('Shared python write' in event.data for event in owner_cal.events())
try:
    reader.put(str(read_cal.url) + 'denied.ics', body, headers={'Content-Type': 'text/calendar'})
    raise AssertionError('read grant accepted a write')
except caldav.lib.error.AuthorizationError:
    pass

def raw_request(username, password, method, url, data):
    auth = base64.b64encode(f'{username}:{password}'.encode()).decode()
    request = urllib.request.Request(url, method=method, data=data.encode(), headers={'Authorization': f'Basic {auth}', 'Content-Type': 'application/xml'})
    try:
        with urllib.request.urlopen(request) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()

status, text = raw_request(os.environ['SHARED_READ_USER'], os.environ['SHARED_READ_PASS'], 'PUT', str(read_cal.url) + 'denied.ics', body)
assert status == 403 and 'need-privileges' in text

busy = read_cal.freebusy_request(datetime(2026, 11, 9, tzinfo=timezone.utc), datetime(2026, 11, 10, tzinfo=timezone.utc))
components = busy.icalendar_instance.walk('VFREEBUSY')
assert len(components) == 1
freebusy = components[0]['FREEBUSY']
periods = freebusy if isinstance(freebusy, list) else [freebusy]
assert len(periods) == 2
assert periods[0].dt == (datetime(2026, 11, 9, 9, tzinfo=timezone.utc), datetime(2026, 11, 9, 10, tzinfo=timezone.utc))

subprocess.run(['bun', os.environ['SHARED_UPGRADE']], check=True)
# python caldav automatically resyncs when the server rejects a stale token.
resynced = read_cal.objects_by_sync_token(sync_token=initial.sync_token, load_objects=True)
assert resynced.sync_token != initial.sync_token
assert any('SUMMARY:Secret' in event.data for event in resynced)
status, text = raw_request(os.environ['SHARED_READ_USER'], os.environ['SHARED_READ_PASS'], 'REPORT', str(read_cal.url), f'<d:sync-collection xmlns:d="DAV:"><d:sync-token>{initial.sync_token}</d:sync-token><d:sync-level>1</d:sync-level></d:sync-collection>')
assert status == 403 and 'valid-sync-token' in text

status, text = raw_request('alice-dav', 'alice-app-password', 'REPORT', f'{base}dav/alice-dav/cal/work/', '<c:free-busy-query xmlns:c="urn:ietf:params:xml:ns:caldav"><c:time-range start="20261109T000000Z" end="20261110T000000Z"/></c:free-busy-query>')
assert status == 403 and 'supported-report' in text
written.delete()
print('OK python shared write visible to owner, read privacy and PUT denial, freebusy_request, token transition, feed denial')
