import {test,expect} from 'bun:test';
import {IcsAdapter,CalDavAdapter} from '../src/adapters';
import {CalDavClient} from '../src/caldav';
import {recurringIcs} from '../src/fixtures';
test('ICS adapter implements one calendar and complete resource upserts',async()=>{
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response(recurringIcs)});
 try{const origin=server.url.origin;const adapter=new IcsAdapter(origin,{allow:[{origin,cidrs:['127.0.0.1/32']}]});
 const calendars=await adapter.listCalendars();expect(calendars[0]?.capabilities.incremental).toBe('conditional-get');
 const first=await adapter.sync('feed');expect(first.upserts).toHaveLength(1);expect(first.upserts[0]?.uid).toBe('astrolabe-recurring');
 const next=await adapter.sync('feed',first.nextCursor);expect(next.upserts).toHaveLength(0);
 await expect(adapter.sync('not-my-calendar')).rejects.toThrow('Unknown');
 }finally{server.stop(true);}
});
test('CalDAV adapter exposes poll discovery and has no push side effects',()=>{
 const adapter=new CalDavAdapter(new CalDavClient(async()=>{throw new Error('not called');}),'https://calendar.test');
 expect(adapter.capabilities.calendarDiscovery).toBe('poll');expect(adapter.capabilities.push).toBe(false);
});
