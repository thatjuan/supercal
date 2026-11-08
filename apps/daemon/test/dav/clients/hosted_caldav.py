# Exercise python caldav's discovery, MKCALENDAR, conditional writes, recurrence and sync.
import os
import caldav
from caldav.elements import dav

client = caldav.DAVClient(url=os.environ['DAV_URL'], username=os.environ['DAV_USER'], password=os.environ['DAV_PASS'])
principal = client.principal()
assert principal.url.path == f"/dav/{os.environ['DAV_USER']}/"
calendar = principal.make_calendar(name='Python hosted', cal_id='python-client', supported_calendar_component_set=['VEVENT'])
assert calendar.url.path.endswith('/python-client/')
assert 'write' in str(calendar.get_property(dav.CurrentUserPrivilegeSet()))

body = '\r\n'.join(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Python test//EN', 'BEGIN:VEVENT', 'UID:python-event', 'DTSTAMP:20260101T000000Z', 'DTSTART:20261110T090000Z', 'DURATION:PT1H', 'SUMMARY:Original', 'END:VEVENT', 'END:VCALENDAR', ''])
event = calendar.save_event(body)
initial = calendar.objects_by_sync_token(load_objects=True)
assert len(list(initial)) == 1
assert 'SUMMARY:Original' in event.data

event.icalendar_component['SUMMARY'] = 'Edited by python'
event.save()
event.load()
assert 'SUMMARY:Edited by python' in event.data
changed = calendar.objects_by_sync_token(sync_token=initial.sync_token, load_objects=True)
assert len(list(changed)) == 1
assert 'Edited by python' in list(changed)[0].data

series = '\r\n'.join(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Python test//EN', 'BEGIN:VEVENT', 'UID:python-series', 'DTSTAMP:20260101T000000Z', 'DTSTART:20261110T090000Z', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Series', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:python-series', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID:20261117T090000Z', 'DTSTART:20261117T120000Z', 'DURATION:PT1H', 'SUMMARY:Moved instance', 'END:VEVENT', 'END:VCALENDAR', ''])
recurring = calendar.save_event(series)
recurring.load()
assert 'RECURRENCE-ID:20261117T090000Z' in recurring.data
assert 'SUMMARY:Moved instance' in recurring.data

event.delete(if_match=True)
delta = calendar.objects_by_sync_token(sync_token=changed.sync_token, load_objects=True)
items = list(delta)
assert len(items) == 2, items
assert any('Moved instance' in (o.data or '') for o in items)
assert len(list(calendar.objects_by_sync_token(load_objects=True))) == 1
recurring.delete()
assert len(list(calendar.objects_by_sync_token(load_objects=True))) == 0
calendar.delete()
print('OK python hosted create/edit/delete, recurring override, incremental sync')
