import { test, expect } from 'bun:test';
import ICAL from 'ical.js';
import { googleResource, graphResource, graphRrule, ianaZone, type GoogleEvent, type GraphEvent, type GraphPattern } from '../src/mapping';
import { parseResources } from '../src/ics';
import { allDayIcs } from '../src/fixtures';
const components = (ical:string) => new ICAL.Component(ICAL.parse(ical)).getAllSubcomponents('vevent');
const googleMaster:GoogleEvent={id:'series',iCalUID:'series@example.test',updated:'2026-11-07T00:00:00Z',summary:'Weekly; team, sync\nNew line',start:{dateTime:'2026-10-26T09:00:00-07:00',timeZone:'America/Los_Angeles'},end:{dateTime:'2026-10-26T10:00:00-07:00',timeZone:'America/Los_Angeles'},recurrence:['RRULE:FREQ=WEEKLY;COUNT=5'],conferenceData:{entryPoints:[{entryPointType:'video',uri:'https://meet.google.com/abc-defg-hij'}]}};
test('Google recurring master + moved override + sparse cancellation grouped by master, no UTC recurrence drift',()=>{
  const exceptions:GoogleEvent[]=[{id:'changed',recurringEventId:'series',originalStartTime:{dateTime:'2026-11-02T09:00:00-08:00'},start:{dateTime:'2026-11-02T11:00:00-08:00'},end:{dateTime:'2026-11-02T12:00:00-08:00'},summary:'Moved'}, {id:'cancelled',status:'cancelled',recurringEventId:'series',originalStartTime:{dateTime:'2026-11-09T09:00:00-08:00'}}];
  const resource=googleResource(googleMaster,exceptions)!;const events=components(resource.ical);
  expect(events).toHaveLength(3);expect(events.map(e=>e.getFirstPropertyValue('uid'))).toEqual(Array(3).fill('series@example.test'));
  expect(events[0]?.getFirstPropertyValue('summary')).toBe(googleMaster.summary);expect(events[0]?.getFirstPropertyValue('url')).toBe('https://meet.google.com/abc-defg-hij');
  expect(resource.ical).toContain('DTSTART;TZID=America/Los_Angeles:20261026T090000');expect(resource.ical).toContain('RECURRENCE-ID;TZID=America/Los_Angeles:20261102T090000');expect(resource.ical).toContain('DTSTART;TZID=America/Los_Angeles:20261102T110000');
  expect(events[2]?.getFirstPropertyValue('status')).toBe('CANCELLED');expect(resource.timezoneIds).toEqual(['America/Los_Angeles']);
});
test('Google all-day end remains exclusive; deleted master distinct from cancelled instance',()=>{
  const r=googleResource({id:'day',start:{date:'2026-11-10'},end:{date:'2026-11-12'}})!;
  expect(r.ical).toContain('DTSTART;VALUE=DATE:20261110');expect(r.ical).toContain('DTEND;VALUE=DATE:20261112');expect(r.timezoneIds).toEqual([]);
  expect(googleResource({...googleMaster,status:'cancelled'})).toBeNull();
  expect(()=>googleResource(googleMaster,[{id:'lost',recurringEventId:'other',originalStartTime:{date:'2026-11-10'}}])).toThrow();
});
test('ICS parser retains all-day DATE properties',()=>{expect(parseResources(allDayIcs)[0]?.ical).toContain('DTSTART;VALUE=DATE:20261110');});
const patterns:{pattern:GraphPattern;expected:string}[]=[
  {pattern:{type:'daily',interval:2},expected:'FREQ=DAILY;INTERVAL=2'},
  {pattern:{type:'weekly',interval:2,daysOfWeek:['monday','wednesday'],firstDayOfWeek:'monday'},expected:'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;WKST=MO'},
  {pattern:{type:'absoluteMonthly',interval:1,dayOfMonth:15},expected:'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15'},
  {pattern:{type:'relativeMonthly',interval:1,daysOfWeek:['thursday'],index:'second'},expected:'FREQ=MONTHLY;INTERVAL=1;BYDAY=TH;BYSETPOS=2'},
  {pattern:{type:'absoluteYearly',interval:1,dayOfMonth:15,month:3},expected:'FREQ=YEARLY;INTERVAL=1;BYMONTH=3;BYMONTHDAY=15'},
  {pattern:{type:'relativeYearly',interval:1,month:11,daysOfWeek:['friday'],index:'last'},expected:'FREQ=YEARLY;INTERVAL=1;BYMONTH=11;BYDAY=FR;BYSETPOS=-1'},
];
for(const{pattern,expected}of patterns)test(`Graph ${pattern.type} RRULE numbered range`,()=>{
  expect(graphRrule({pattern,range:{type:'numbered',numberOfOccurrences:5,startDate:'2026-11-01'}},false,'UTC')).toBe(expected+';COUNT=5');
});
test('Graph endDate inclusive in local zone becomes UTC UNTIL after DST; all-day stays date',()=>{
  const recurrence={pattern:{type:'daily',interval:1} as const,range:{type:'endDate',startDate:'2026-10-30',endDate:'2026-11-02',recurrenceTimeZone:'Pacific Standard Time'} as const};
  expect(graphRrule(recurrence,false,'UTC')).toBe('FREQ=DAILY;INTERVAL=1;UNTIL=20261103T075959Z');expect(graphRrule(recurrence,true,'UTC')).toBe('FREQ=DAILY;INTERVAL=1;UNTIL=20261102');
});
const graphMaster:GraphEvent={id:'master',type:'seriesMaster',iCalUId:'master@example.test',subject:'Team sync',start:{dateTime:'2026-10-26T16:00:00.0000000',timeZone:'UTC'},end:{dateTime:'2026-10-26T17:00:00.0000000',timeZone:'UTC'},originalStartTimeZone:'Pacific Standard Time',recurrence:{pattern:{type:'weekly',interval:1,daysOfWeek:['monday']},range:{type:'numbered',startDate:'2026-10-26',numberOfOccurrences:5,recurrenceTimeZone:'Pacific Standard Time'}},cancelledOccurrences:['opaque-cancelled-id'],lastModifiedDateTime:'2026-11-07T00:00:00Z',onlineMeeting:{joinUrl:'https://teams.microsoft.com/l/meetup-join/fixture'}};
test('Graph Windows TZ, moved exception, cancellation and differing per-instance iCalUId use master UID',()=>{
  const exception:GraphEvent={id:'instance',iCalUId:'DIFFERENT-UID',seriesMasterId:'master',type:'exception',originalStart:'2026-11-02T17:00:00Z',start:{dateTime:'2026-11-02T19:00:00',timeZone:'UTC'},end:{dateTime:'2026-11-02T20:00:00',timeZone:'UTC'},subject:'Moved'};
  const r=graphResource(graphMaster,{exceptions:[exception],cancelledOriginalStarts:{'opaque-cancelled-id':'2026-11-09T17:00:00Z'}})!;
  expect(components(r.ical)).toHaveLength(3);expect(components(r.ical).map(e=>e.getFirstPropertyValue('uid'))).toEqual(Array(3).fill('master@example.test'));
  expect(r.ical).toContain('DTSTART;TZID=America/Los_Angeles:20261026T090000');expect(r.ical).toContain('RECURRENCE-ID;TZID=America/Los_Angeles:20261102T090000');expect(r.ical).toContain('DTSTART;TZID=America/Los_Angeles:20261102T110000');expect(r.ical).toContain('STATUS:CANCELLED');expect(r.ical).toContain('URL:https://teams.microsoft.com/');
  expect(()=>graphResource(graphMaster)).toThrow('Unresolved cancelled occurrence');
});
test('Graph all-day dates and Windows territory mapping; unknown custom zone fails closed',()=>{
  const day:GraphEvent={id:'day',isAllDay:true,start:{dateTime:'2026-11-10T00:00:00',timeZone:'Pacific Standard Time'},end:{dateTime:'2026-11-11T00:00:00',timeZone:'Pacific Standard Time'}};
  const r=graphResource(day)!;expect(r.ical).toContain('DTSTART;VALUE=DATE:20261110');expect(r.ical).toContain('DTEND;VALUE=DATE:20261111');expect(ianaZone('Pacific Standard Time','CA')).toBe('America/Vancouver');
  expect(()=>ianaZone('tzone://Microsoft/Custom')).toThrow();expect(graphResource({...day,isCancelled:true})).toBeNull();
});
test('Graph all-day UTC response is converted back to its original positive-offset zone',()=>{
  const day:GraphEvent={id:'tokyo-day',isAllDay:true,originalStartTimeZone:'Tokyo Standard Time',start:{dateTime:'2026-11-09T15:00:00',timeZone:'UTC'},end:{dateTime:'2026-11-10T15:00:00',timeZone:'UTC'}};
  expect(graphResource(day)?.ical).toContain('DTSTART;VALUE=DATE:20261110');expect(graphResource(day)?.ical).toContain('DTEND;VALUE=DATE:20261111');
});
test('relative monthly mapping expands to the second Thursday, including short months',()=>{
  const rule=ICAL.Recur.fromString(graphRrule({pattern:{type:'relativeMonthly',interval:1,daysOfWeek:['thursday'],index:'second'},range:{type:'numbered',startDate:'2026-01-08',numberOfOccurrences:3}},false,'UTC'));
  const iterator=rule.iterator(ICAL.Time.fromDateTimeString('2026-01-08T09:00:00Z'));
  expect([iterator.next()?.toString(),iterator.next()?.toString(),iterator.next()?.toString()]).toEqual(['2026-01-08T09:00:00Z','2026-02-12T09:00:00Z','2026-03-12T09:00:00Z']);expect(iterator.next()).toBeNull();
});
