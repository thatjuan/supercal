import type { GoogleEvent } from './mapping';
export type GooglePage = {items?:GoogleEvent[];nextPageToken?:string;nextSyncToken?:string};
export type GoogleCursor = {syncToken:string};
export type GooglePageRequest={singleEvents:false;showDeleted:true;syncToken?:string;pageToken?:string};
/** Fetch all pages before exposing a new cursor; one 410 restarts the whole snapshot. The caller merges exceptions into its cached masters. */
export async function googleSync(fetchPage:(request:GooglePageRequest)=>Promise<{status:number;page:GooglePage}>,cursor?:GoogleCursor){
  let token=cursor?.syncToken;let fullResync=!cursor;
  for(let attempt=0;attempt<2;attempt++){
    let pageToken:string|undefined;const events:GoogleEvent[]=[];const seen=new Set<string>();
    for(;;){
      const{status,page}=await fetchPage({singleEvents:false,showDeleted:true,syncToken:token,pageToken});
      if(status===410&&token){token=undefined;fullResync=true;break;}
      if(status!==200)throw new Error(`Google HTTP ${status}`);
      events.push(...page.items??[]);
      if(page.nextPageToken){if(seen.has(page.nextPageToken))throw new Error('Repeated page token');seen.add(page.nextPageToken);pageToken=page.nextPageToken;continue;}
      if(!page.nextSyncToken)throw new Error('Missing terminal sync token');
      return{events,nextCursor:{syncToken:page.nextSyncToken},fullResync};
    }
  }
  throw new Error('Repeated full-resync failure');
}
