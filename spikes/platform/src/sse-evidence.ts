import {strict as assert} from 'node:assert';
import {z} from 'zod';
import {client} from './db';
const port=4320,base=`http://localhost:${port}`;
const child=Bun.spawn([process.execPath,'src/server.ts'],{env:{...process.env,PORT:String(port),BASE_URL:base,MIGRATE_ON_BOOT:'0'},stdout:'pipe',stderr:'pipe'});
const controllers:AbortController[]=[];
const consumers:Promise<void>[]=[];
type Event={tenantId:string;calendarId:string;seq:string;receivedAt:number};
async function account(){
  const signup=await fetch(`${base}/api/auth/sign-up/email`,{method:'POST',headers:{'Content-Type':'application/json',origin:base},body:JSON.stringify({email:`sse-${crypto.randomUUID()}@example.invalid`,password:'sse-test-password-12345',name:'SSE Gnomon'})});assert.equal(signup.status,200);
  const cookie=signup.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
  const org=await fetch(`${base}/api/auth/organization/create`,{method:'POST',headers:{'Content-Type':'application/json',origin:base,cookie},body:JSON.stringify({name:'SSE tenant',slug:`sse-${crypto.randomUUID()}`})});assert.equal(org.status,200);
  const tenantId=z.object({id:z.string()}).parse(await org.json()).id;
  const active=await fetch(`${base}/api/auth/organization/set-active`,{method:'POST',headers:{'Content-Type':'application/json',origin:base,cookie},body:JSON.stringify({organizationId:tenantId})});assert.equal(active.status,200);
  return {cookie,tenantId};
}
async function subscribe(cookie:string){
  const controller=new AbortController();controllers.push(controller);
  const response=await fetch(`${base}/api/v1/events`,{headers:{cookie},signal:controller.signal});assert.equal(response.status,200);assert.ok(response.body);
  const events:Event[]=[];let ready:()=>void=()=>{};
  const handshake=new Promise<void>(resolve=>{ready=resolve;});
  const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
  const consume=(async()=>{try{while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let end:number;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);if(frame.includes('event: ready'))ready();if(frame.includes('event: change')){const data=frame.split('\n').find(line=>line.startsWith('data: '))?.slice(6);if(data){const event=z.object({tenantId:z.string(),calendarId:z.string(),seq:z.string()}).parse(JSON.parse(data) as unknown);events.push({...event,receivedAt:performance.now()});}}}}}catch(error){if(!controller.signal.aborted)throw error;}})();
  consumers.push(consume);await Promise.race([handshake,Bun.sleep(3000).then(()=>{throw new Error('SSE handshake timeout');})]);return events;
}
async function waitUntil(predicate:()=>boolean){for(let i=0;i<100;i++){if(predicate())return;await Bun.sleep(10);}throw new Error('event delivery timeout');}
try{
  let healthy=false;
  for(let i=0;i<100;i++){try{healthy=(await fetch(`${base}/health`)).ok;}catch{}if(healthy)break;await Bun.sleep(20);}
  assert.ok(healthy,'SSE daemon failed to start');
  const [a,b]=await Promise.all([account(),account()]);
  const groups=await Promise.all([a,a,a,b,b,b].map(tenant=>subscribe(tenant.cookie)));
  const commits=new Map<string,number>();
  for(let seq=1;seq<=12;seq++){
    const tenant=seq<=10?a:b;
    await client.begin(async tx=>{
      await tx`select pg_notify('platform_changes',${JSON.stringify({tenantId:tenant.tenantId,calendarId:'fixture',seq:String(seq)})})`;
      if(seq===1){await Bun.sleep(150);assert.ok(groups.every(events=>events.length===0));}
      commits.set(String(seq),performance.now());
    });
    await waitUntil(()=>groups.filter((_,index)=>seq<=10?index<3:index>=3).every(events=>events.some(event=>event.seq===String(seq))));
  }
  assert.deepEqual(groups.map(events=>events.length),[10,10,10,2,2,2]);
  for(let i=0;i<groups.length;i++)assert.ok(groups[i]?.every(event=>event.tenantId===(i<3?a:b).tenantId));
  const latencies=groups.flatMap(events=>events.map(event=>event.receivedAt-(commits.get(event.seq)??0))).sort((a,b)=>a-b);
  const connections=await client`select count(*)::int as count from pg_stat_activity where datname=current_database() and application_name='supercal-platform-sse'`;
  assert.equal(connections[0]?.count,1);assert.ok((latencies.at(-1)??Infinity)<100);
  console.log(JSON.stringify({bun:Bun.version,subscriberCount:6,tenants:2,eventsPerSubscriber:groups.map(events=>events.length),listenerConnections:connections[0]?.count,noDeliveryBeforeCommit:true,latencyDefinition:'time immediately before COMMIT round trip until SSE received in another process',latencyMs:{min:+(latencies[0]??0).toFixed(2),p95:+(latencies[Math.floor(latencies.length*0.95)]??0).toFixed(2),max:+(latencies.at(-1)??0).toFixed(2)},crossTenantEvents:0,idleTimeout:0,heartbeatSeconds:15},null,2));
}finally{
  controllers.forEach(controller=>controller.abort());await Promise.all(consumers);child.kill();await child.exited;
  const errors=await new Response(child.stderr).text();if(errors)console.error(errors);await client.end();
}
