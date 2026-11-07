import ICAL from 'ical.js';
import { Temporal } from '@js-temporal/polyfill';
import { findIana } from 'windows-iana';
export type Resource = { id: string; uid: string; ical: string; timezoneIds: string[]; raw: unknown };
export type GoogleTime = { date?: string; dateTime?: string; timeZone?: string };
export type GoogleEvent = { id: string; iCalUID?: string; status?: 'confirmed' | 'tentative' | 'cancelled'; summary?: string; description?: string; location?: string; updated?: string; sequence?: number; start?: GoogleTime; end?: GoogleTime; recurrence?: string[]; recurringEventId?: string; originalStartTime?: GoogleTime; conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] }; hangoutLink?: string };
export const textValue = (s: string) => s.replaceAll('\\','\\\\').replaceAll('\r\n','\n').replaceAll('\r','\n').replaceAll('\n','\\n').replaceAll(';','\\;').replaceAll(',','\\,');
const compact = (s: string) => s.replace(/[-:]/g, '').replace(/\.\d+/, '');
const stamp = (value = '1970-01-01T00:00:00Z') => compact(Temporal.Instant.from(value).toString({ smallestUnit:'second' }));
function validZone(zone: string): string { if (/[\r\n:;"\\]/.test(zone)) throw new Error('Invalid timezone'); Temporal.Now.zonedDateTimeISO(zone); return zone; }
function inZone(instant: string, zone: string) { return Temporal.Instant.from(instant).toZonedDateTimeISO(zone).toPlainDateTime().toString({ smallestUnit:'second' }); }
function googleDate(name: string, value: GoogleTime, zones: Set<string>, preferredZone?: string) {
  if (value.date) return `${name};VALUE=DATE:${compact(Temporal.PlainDate.from(value.date).toString())}`;
  if (!value.dateTime) throw new Error(`Missing ${name}`);
  const zone = value.timeZone ?? preferredZone;
  if (zone) { validZone(zone); zones.add(zone); return `${name};TZID=${zone}:${compact(inZone(value.dateTime, zone))}`; }
  return `${name}:${stamp(value.dateTime)}`;
}
function serialize(events: string[][]) {
  return new ICAL.Component(ICAL.parse(['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Supercal//Ingest Spike//EN',...events.flatMap(lines=>['BEGIN:VEVENT',...lines,'END:VEVENT']),'END:VCALENDAR',''].join('\r\n'))).toString();
}
/** Input must be a complete cached master plus its exceptions, not an incremental page alone. Output core supplies VTIMEZONEs. */
export function googleResource(master: GoogleEvent, exceptions: GoogleEvent[] = []): Resource | null {
  if (master.status === 'cancelled') return null;
  if (master.recurringEventId || !master.start || !master.end) throw new Error('Expected complete Google master');
  const uid = master.iCalUID ?? `${master.id}@google.supercal`; const zones = new Set<string>();
  const component = (e: GoogleEvent, exception: boolean) => {
    const lines = [`UID:${textValue(uid)}`, `DTSTAMP:${stamp(e.updated ?? master.updated)}`];
    if (exception) {
      if (e.recurringEventId !== master.id || !e.originalStartTime) throw new Error('Exception missing master/originalStartTime');
      lines.push(googleDate('RECURRENCE-ID', e.originalStartTime, zones, master.start?.timeZone));
    }
    const start = e.start ?? (e.status === 'cancelled' ? e.originalStartTime : undefined); if (!start) throw new Error('Missing start');
    lines.push(googleDate('DTSTART', start, zones, master.start?.timeZone));
    if (e.end) lines.push(googleDate('DTEND',e.end,zones,master.end?.timeZone));
    if (e.status) lines.push(`STATUS:${e.status.toUpperCase()}`);
    if (e.sequence !== undefined) lines.push(`SEQUENCE:${e.sequence}`);
    for (const [key,value] of [['SUMMARY',e.summary],['DESCRIPTION',e.description],['LOCATION',e.location]] as const) if (value !== undefined) lines.push(`${key}:${textValue(value)}`);
    if (!exception) for (const recurrence of e.recurrence ?? []) {
      if (!/^(RRULE|RDATE|EXDATE)(;[^:\r\n]*)?:[^\r\n]+$/.test(recurrence)) throw new Error('Unsupported recurrence property'); lines.push(recurrence);
    }
    const meeting = e.conferenceData?.entryPoints?.find(p => p.entryPointType === 'video')?.uri ?? e.hangoutLink;
    if (meeting) { const u = new URL(meeting); if (!['https:','http:'].includes(u.protocol)) throw new Error('Invalid conference URL'); lines.push(`URL:${u.href}`); }
    return lines;
  };
  return {id:master.id,uid,ical:serialize([component(master,false),...exceptions.map(e=>component(e,true))]),timezoneIds:[...zones],raw:{master,exceptions}};
}

const weekdays = {sunday:'SU',monday:'MO',tuesday:'TU',wednesday:'WE',thursday:'TH',friday:'FR',saturday:'SA'} as const;
type Weekday = keyof typeof weekdays;
type WeekIndex = 'first'|'second'|'third'|'fourth'|'last';
export type GraphPattern = { interval:number } & ({type:'daily'} | {type:'weekly';daysOfWeek:Weekday[];firstDayOfWeek?:Weekday} | {type:'absoluteMonthly';dayOfMonth:number} | {type:'relativeMonthly';daysOfWeek:Weekday[];index?:WeekIndex} | {type:'absoluteYearly';month:number;dayOfMonth:number} | {type:'relativeYearly';month:number;daysOfWeek:Weekday[];index?:WeekIndex});
export type GraphRange = {startDate:string;recurrenceTimeZone?:string} & ({type:'noEnd'} | {type:'numbered';numberOfOccurrences:number} | {type:'endDate';endDate:string});
export type GraphTime = { dateTime:string;timeZone:string };
export type GraphEvent = {id:string;iCalUId?:string;type?:'singleInstance'|'seriesMaster'|'occurrence'|'exception';subject?:string;bodyPreview?:string;location?:{displayName?:string};start:GraphTime;end:GraphTime;isAllDay?:boolean;isCancelled?:boolean;originalStart?:string;originalStartTimeZone?:string;seriesMasterId?:string;lastModifiedDateTime?:string;recurrence?:{pattern:GraphPattern;range:GraphRange};cancelledOccurrences?:string[];exceptionOccurrences?:GraphEvent[];onlineMeeting?:{joinUrl?:string}};
export function ianaZone(zone: string, territory='001') {
  if (zone === 'UTC' || zone === 'Etc/UTC') return 'UTC';
  const mapped = findIana(zone,territory)[0] ?? findIana(zone,'001')[0];
  if (mapped) return validZone(mapped);
  try { return validZone(zone); } catch { throw new Error(`Unmapped Graph timezone: ${zone}`); }
}
function graphLocal(time:GraphTime, target:string, territory:string) {
  const source = ianaZone(time.timeZone,territory);
  const plain = Temporal.PlainDateTime.from(time.dateTime.replace(/Z$/, ''));
  return plain.toZonedDateTime(source).withTimeZone(target).toPlainDateTime().toString({smallestUnit:'second'});
}
export function graphRrule(recurrence:{pattern:GraphPattern;range:GraphRange}, allDay:boolean, eventZone:string, territory='001') {
  const p=recurrence.pattern, r=recurrence.range;
  if (!Number.isInteger(p.interval) || p.interval < 1) throw new Error('Invalid interval');
  const freq = p.type === 'daily' ? 'DAILY' : p.type === 'weekly' ? 'WEEKLY' : p.type.endsWith('Monthly') ? 'MONTHLY' : 'YEARLY';
  const parts = [`FREQ=${freq}`,`INTERVAL=${p.interval}`];
  if ('month' in p) parts.push(`BYMONTH=${p.month}`);
  if ('dayOfMonth' in p) parts.push(`BYMONTHDAY=${p.dayOfMonth}`);
  if ('daysOfWeek' in p) {
    if (!p.daysOfWeek.length) throw new Error('Empty recurrence weekdays');
    parts.push(`BYDAY=${p.daysOfWeek.map(d=>weekdays[d]).join(',')}`);
    if (p.type === 'weekly') parts.push(`WKST=${weekdays[p.firstDayOfWeek ?? 'sunday']}`);
    else parts.push(`BYSETPOS=${({first:1,second:2,third:3,fourth:4,last:-1} as const)[p.index ?? 'first']}`);
  }
  if (r.type === 'numbered') { if (!Number.isInteger(r.numberOfOccurrences) || r.numberOfOccurrences < 1) throw new Error('Invalid count'); parts.push(`COUNT=${r.numberOfOccurrences}`); }
  if (r.type === 'endDate') {
    const date=Temporal.PlainDate.from(r.endDate);
    // Graph's range is inclusive; TZID DTSTART needs a UTC UNTIL, including the whole last local day.
    const until=allDay ? compact(date.toString()) : stamp(date.add({days:1}).toZonedDateTime(ianaZone(r.recurrenceTimeZone ?? eventZone,territory)).toInstant().subtract({seconds:1}).toString());
    parts.push(`UNTIL=${until}`);
  }
  return parts.join(';');
}
/** Cancellation IDs are opaque: the caller must supply each original start from its occurrence index or a verified provider decoder. */
export function graphResource(master:GraphEvent, options:{territory?:string;exceptions?:GraphEvent[];cancelledOriginalStarts?:Record<string,string>} = {}):Resource|null {
  if (master.isCancelled) return null;
  if (master.seriesMasterId) throw new Error('Expected Graph master');
  const territory=options.territory ?? '001';
  const zone=ianaZone(master.recurrence?.range.recurrenceTimeZone ?? master.originalStartTimeZone ?? master.start.timeZone,territory);
  const uid=master.iCalUId ?? `${master.id}@graph.supercal`; const zones=new Set<string>();
  const dateLine = (name:string,time:GraphTime,allDay:boolean) => {
    if (allDay) return `${name};VALUE=DATE:${compact(graphLocal(time,zone,territory).slice(0,10))}`;
    const local=graphLocal(time,zone,territory);
    if(zone==='UTC') return `${name}:${compact(local)}Z`;
    zones.add(zone); return `${name};TZID=${zone}:${compact(local)}`;
  };
  const recurrenceId = (instant:string) => dateLine('RECURRENCE-ID',{dateTime:inZone(instant,zone),timeZone:zone},Boolean(master.isAllDay));
  const component=(e:GraphEvent,exception:boolean) => {
    const lines=[`UID:${textValue(uid)}`,`DTSTAMP:${stamp(e.lastModifiedDateTime ?? master.lastModifiedDateTime)}`];
    if(exception) {if(e.seriesMasterId!==master.id || !e.originalStart) throw new Error('Exception missing originalStart');lines.push(recurrenceId(e.originalStart));}
    lines.push(dateLine('DTSTART',e.start,Boolean(e.isAllDay)),dateLine('DTEND',e.end,Boolean(e.isAllDay)));
    if(e.isCancelled)lines.push('STATUS:CANCELLED');
    for(const[key,value]of[['SUMMARY',e.subject],['DESCRIPTION',e.bodyPreview],['LOCATION',e.location?.displayName]] as const)if(value!==undefined)lines.push(`${key}:${textValue(value)}`);
    if(!exception && e.recurrence)lines.push(`RRULE:${graphRrule(e.recurrence,Boolean(e.isAllDay),zone,territory)}`);
    if(e.onlineMeeting?.joinUrl) { const u=new URL(e.onlineMeeting.joinUrl); if(!['https:','http:'].includes(u.protocol))throw new Error('Invalid meeting URL');lines.push(`URL:${u.href}`); }
    return lines;
  };
  const cancellations=(master.cancelledOccurrences??[]).map(id=>{
    const original=options.cancelledOriginalStarts?.[id];if(!original)throw new Error(`Unresolved cancelled occurrence: ${id}`);
    return [`UID:${textValue(uid)}`,`DTSTAMP:${stamp(master.lastModifiedDateTime)}`,recurrenceId(original),dateLine('DTSTART',{dateTime:inZone(original,zone),timeZone:zone},Boolean(master.isAllDay)),'STATUS:CANCELLED'];
  });
  const ical=serialize([component(master,false),...(options.exceptions??master.exceptionOccurrences??[]).map(e=>component(e,true)),...cancellations]);
  return {id:master.id,uid,ical,timezoneIds:[...zones],raw:{master,options}};
}
