import {test,expect} from 'bun:test';
import {googleSync,type GooglePageRequest} from '../src/google-sync';
test('Google 410 resets; all pages drained, exceptions and tombstones retained, terminal token only',async()=>{
  const requests:GooglePageRequest[]=[];
  const result=await googleSync(async request=>{
    requests.push(request);
    if(request.syncToken==='expired')return{status:410,page:{}};
    if(!request.pageToken)return{status:200,page:{items:[{id:'master'}],nextPageToken:'p2'}};
    return{status:200,page:{items:[{id:'exception',recurringEventId:'master',originalStartTime:{date:'2026-11-01'}},{id:'deleted',status:'cancelled'}],nextSyncToken:'new'}};
  },{syncToken:'expired'});
  expect(result.fullResync).toBe(true);expect(result.nextCursor.syncToken).toBe('new');expect(result.events).toHaveLength(3);expect(requests.map(r=>r.syncToken)).toEqual(['expired',undefined,undefined]);expect(requests.every(r=>r.singleEvents===false&&r.showDeleted)).toBe(true);
});
test('Google later-page failure never exposes a partial cursor',async()=>{
  await expect(googleSync(async request=>request.pageToken?{status:500,page:{}}:{status:200,page:{items:[{id:'master'}],nextPageToken:'p2'}},{syncToken:'old'})).rejects.toThrow('500');
});
