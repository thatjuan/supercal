import { CalDavClient, type DavCursor, type DavCalendar } from './caldav';
import { syncIcs, parseResources, type IcsCursor } from './ics';
import type { GuardOptions } from './ssrf';
export type NormalizedResource = { id:string;uid:string;revision:string;ical:string;raw:unknown };
export type SourceCalendar = { id:string;name:string;color?:string;capabilities:{incremental:'token'|'etag'|'conditional-get';push:boolean;colors:boolean} };
export type SyncResult<C> = {upserts:NormalizedResource[];deletes:string[];nextCursor:C;fullResync:boolean};
export type PushLease = {id:string;expiresAt:string;providerState:unknown};
export interface ProviderAdapter<C> {
  readonly capabilities:{calendarDiscovery:'poll'|'push'|'single';push:boolean};
  listCalendars():Promise<SourceCalendar[]>;
  /** Each upsert replaces the COMPLETE master+overrides resource. Cursor and changes commit together, after every page succeeds. */
  sync(calendarId:string,cursor?:C):Promise<SyncResult<C>>;
  push?:{
    subscribe(target:{kind:'calendar';id:string}|{kind:'calendar-list'},callbackUrl:string,secret:string):Promise<PushLease>;
    renew(lease:PushLease):Promise<PushLease>;
    teardown(lease:PushLease):Promise<void>;
  };
}
export class CalDavAdapter implements ProviderAdapter<DavCursor> {
  readonly capabilities={calendarDiscovery:'poll',push:false} as const;
  private calendars=new Map<string,DavCalendar>();
  constructor(private client:CalDavClient,private baseUrl:string){}
  async listCalendars(){
    const{home}=await this.client.discover(this.baseUrl);const calendars=await this.client.listCalendars(home);
    this.calendars=new Map(calendars.filter(c=>c.components.includes('VEVENT')).map(c=>[c.href,c]));
    return [...this.calendars.values()].map(c=>({id:c.href,name:c.name??c.href,color:c.color,capabilities:{incremental:c.syncCollection?'token' as const:'etag' as const,push:false,colors:Boolean(c.color)}}));
  }
  async sync(calendarId:string,cursor?:DavCursor):Promise<SyncResult<DavCursor>>{
    if(!this.calendars.size)await this.listCalendars();const calendar=this.calendars.get(calendarId);if(!calendar)throw new Error('Unknown calendar');
    const result=await this.client.sync(calendar,cursor);
    return{...result,upserts:result.upserts.map(o=>{
      const resources=parseResources(o.ical);if(resources.length!==1)throw new Error('CalDAV object must contain exactly one VEVENT UID');
      return{id:o.href,uid:resources[0]!.uid,revision:o.etag,ical:o.ical,raw:o.ical};
    })};
  }
}
export class IcsAdapter implements ProviderAdapter<IcsCursor> {
  readonly capabilities={calendarDiscovery:'single',push:false} as const;
  constructor(private url:string,private options:GuardOptions={},private id='feed'){}
  async listCalendars(){return[{id:this.id,name:'Subscribed calendar',capabilities:{incremental:'conditional-get' as const,push:false,colors:false}}];}
  async sync(calendarId:string,cursor?:IcsCursor):Promise<SyncResult<IcsCursor>>{
    if(calendarId!==this.id)throw new Error('Unknown calendar');const result=await syncIcs(this.url,cursor,this.options);
    return{...result,upserts:result.upserts.map(o=>({...o,raw:o.ical}))};
  }
}
