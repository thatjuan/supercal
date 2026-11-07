import {test,expect} from 'bun:test';
import {CalDavClient,type DavCalendar,type Transport} from '../src/caldav';
const ns='xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"';
const cal:DavCalendar={href:'https://calendar.test/cal/',components:['VEVENT'],syncCollection:true};
const response=(status:number,text:string)=>({status,text,url:cal.href});
const props=(content:string)=>`<d:multistatus ${ns}><d:response><d:href>/cal/</d:href><d:propstat><d:prop>${content}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
test('unsupported sync-collection falls back, absent ctag cannot suppress listing',async()=>{
  const methods:string[]=[];
  const transport:Transport=async(_url,init)=>{
    methods.push(init.method+':'+(init.body?.includes('sync-collection')?'sync':init.body?.includes('calendar-query')?'query':'props'));
    if(init.body?.includes('<d:sync-collection'))return response(501,'not supported');
    if(init.method==='PROPFIND')return response(207,props('<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>'));
    return response(207,`<d:multistatus ${ns}/>`);
  };
  const client=new CalDavClient(transport);
  // A valid empty calendar-query has no response elements.
  const first=await client.sync(cal);expect(first.nextCursor.mode).toBe('etag');
  await client.sync(cal,first.nextCursor);expect(methods.filter(m=>m==='REPORT:query')).toHaveLength(2);
});
test('auth failure is never converted to a full empty snapshot',async()=>{
  const client=new CalDavClient(async()=>response(401,'unauthorized'));
  await expect(client.sync(cal,{mode:'sync',token:'old',etags:{'https://calendar.test/cal/a.ics':'old'}})).rejects.toThrow('401');
});
test('multiget disappearance does not advance the cursor',async()=>{
  const transport:Transport=async(_url,init)=>init.body?.includes('<d:sync-collection')?response(207,`<d:multistatus ${ns}><d:sync-token>new</d:sync-token><d:response><d:href>/cal/a.ics</d:href><d:propstat><d:prop><d:getetag>new</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`):response(207,`<d:multistatus ${ns}><d:response><d:href>/cal/a.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response></d:multistatus>`);
  await expect(new CalDavClient(transport).sync(cal,{mode:'sync',token:'old',etags:{}})).rejects.toThrow('Concurrent disappearance');
});
test('omitted multiget result does not advance the cursor',async()=>{
  const client=new CalDavClient(async()=>response(207,`<d:multistatus ${ns}/>`));
  await expect(client.multiget(cal.href,['https://calendar.test/cal/a.ics'])).rejects.toThrow('Incomplete');
});
