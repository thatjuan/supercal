import postgres from 'postgres';
import {streamSSE} from 'hono/streaming';
import {z} from 'zod';
import type {app as apiApp} from './api';
import {databaseURL} from './db';
const changeSchema=z.object({tenantId:z.string(),calendarId:z.string(),seq:z.string()});
type Change=z.infer<typeof changeSchema>;
type Subscriber={tenantId:string;send:(change:Change)=>void};
// Exactly one dedicated LISTEN connection per process, independent of subscriber count.
export async function attachSSE(app:typeof apiApp){
  const subscribers=new Set<Subscriber>();
  const listener=postgres(databaseURL,{max:1,connection:{application_name:'supercal-platform-sse'},onnotice:()=>{}});
  await listener.listen('platform_changes',payload=>{
    let decoded:unknown;try{decoded=JSON.parse(payload);}catch{return;}
    const parsed=changeSchema.safeParse(decoded);if(!parsed.success)return;
    for(const subscriber of subscribers)if(subscriber.tenantId===parsed.data.tenantId)subscriber.send(parsed.data);
  });
  app.get('/api/v1/events',c=>streamSSE(c,async stream=>{
    let finish:()=>void=()=>{};
    const done=new Promise<void>(resolve=>{finish=resolve;});
    let pending=0;
    const subscriber:Subscriber={tenantId:c.var.principal.tenantId,send(change){
      if(++pending>16){subscribers.delete(subscriber);void stream.close();finish();return;}
      void stream.writeSSE({event:'change',id:change.seq,data:JSON.stringify(change)}).catch(()=>finish()).finally(()=>{pending--;});
    }};
    subscribers.add(subscriber);
    stream.onAbort(finish);
    const heartbeat=setInterval(()=>{void stream.write(': heartbeat\n\n').catch(finish);},15_000);
    try{await stream.writeSSE({event:'ready',data:'{}'});await done;}
    finally{clearInterval(heartbeat);subscribers.delete(subscriber);}
  }));
  return ()=>listener.end();
}
