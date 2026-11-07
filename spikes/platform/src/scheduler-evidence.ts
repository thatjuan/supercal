import { strict as assert } from 'node:assert';
import postgres from 'postgres';
import { claim,complete,nextDelayMs } from './scheduler';
const url=process.env.DATABASE_URL??'postgres://supercal:spike@hare:55432/spike_platform';
const sql=postgres(url,{max:4,onnotice:()=>{}});
try{
  await sql`create table if not exists calendar_sync(id int primary key,tenant_id uuid not null,next_run_at timestamptz not null,lease_until timestamptz,lease_owner uuid,lease_version int not null default 0,attempts int not null default 0,last_error text)`;
  await sql`create index if not exists calendar_sync_due on calendar_sync(next_run_at,id)`;
  await sql`create table if not exists sync_audit(calendar_id int not null,owner uuid not null,generation int not null,claimed_at timestamptz not null,completed_at timestamptz,accepted boolean,error text,primary key(calendar_id,generation))`;
  await sql`truncate calendar_sync,sync_audit`;
  await sql`insert into calendar_sync(id,tenant_id,next_run_at) select g,${crypto.randomUUID()},clock_timestamp() from generate_series(1,1000) g`;
  const start=performance.now();
  const children=[0,1,2].map(i=>Bun.spawn([process.execPath,'src/scheduler-worker.ts'],{env:{...process.env,DATABASE_URL:url,DURATION_MS:'60000',CRASH_ON_CLAIM:i===0?'1':'0'},stdout:'pipe',stderr:'pipe'}));
  const outputs=await Promise.all(children.map(async child=>({exit:await child.exited,stdout:await new Response(child.stdout).text(),stderr:await new Response(child.stderr).text()})));
  assert.equal(outputs[0]?.exit,86);assert.equal(outputs[1]?.exit,0);assert.equal(outputs[2]?.exit,0);
  const summary=await sql`select count(*)::int claims,count(*) filter(where accepted)::int accepted,count(*) filter(where completed_at is null)::int crashed_claims,count(distinct calendar_id)::int distinct_rows,max(generation)::int max_generation from sync_audit`;
  const overlaps=await sql`select count(*)::int as count from sync_audit a join sync_audit b on a.calendar_id=b.calendar_id and a.generation<b.generation where a.completed_at is not null and a.claimed_at<b.completed_at and b.claimed_at<a.completed_at`;
  const reclaimed=await sql`select count(*)::int as count,min(extract(epoch from (b.claimed_at-a.claimed_at))*1000)::int as min_ms from sync_audit a join sync_audit b on a.calendar_id=b.calendar_id and b.generation=a.generation+1 where a.completed_at is null`;
  const failures=await sql`select count(*)::int as count from sync_audit where error is not null`;
  assert.equal(summary[0]?.distinct_rows,1000);assert.equal(overlaps[0]?.count,0);assert.equal(reclaimed[0]?.count,8);assert.ok(Number(failures[0]?.count)>0);
  console.log(JSON.stringify({durationMs:Math.round(performance.now()-start),processes:3,workers:outputs,summary:summary[0],concurrentCompletedOverlaps:overlaps[0]?.count,crashedLeasesReclaimed:reclaimed[0],failedAttempts:failures[0],backoffJitterBounds:[nextDelayMs({changed:false,attempts:3,random:0}),nextDelayMs({changed:false,attempts:3,random:1})]},null,2));
  // A live but paused worker may overlap after expiry. Fencing rejects its completion.
  await sql`truncate calendar_sync,sync_audit`;
  await sql`insert into calendar_sync(id,tenant_id,next_run_at) values(1,${crypto.randomUUID()},clock_timestamp())`;
  const oldOwner=crypto.randomUUID(),newOwner=crypto.randomUUID();
  const [old]=await claim(sql,oldOwner,100,1);assert.ok(old);
  await Bun.sleep(150);
  const [fresh]=await claim(sql,newOwner,1000,1);assert.ok(fresh);
  const staleAccepted=await complete(sql,oldOwner,old,null,true);const freshAccepted=await complete(sql,newOwner,fresh,null,true);
  assert.equal(staleAccepted,false);assert.equal(freshAccepted,true);
  console.log(JSON.stringify({pausedWorkerFault:{sameCalendarClaimedTwiceWhileOldWorkerAlive:true,staleCompletionAccepted:staleAccepted,newCompletionAccepted:freshAccepted},recommendation:'Fencing protects DB commits; leases alone cannot prevent overlapping external work. Renew/cancel leases and make side effects idempotent.'},null,2));
}finally{await sql.end();}
