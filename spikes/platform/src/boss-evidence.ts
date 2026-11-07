import {strict as assert} from 'node:assert';
import {PgBoss} from 'pg-boss';
const boss=new PgBoss({connectionString:process.env.DATABASE_URL??'postgres://supercal:spike@hare:55432/spike_platform',schema:'platform_boss',supervise:false,schedule:false});
boss.on('error',error=>console.error(error));
try {
  const start=performance.now();await boss.start();
  const name='gnomon-probe';await boss.createQueue(name);
  const id=await boss.send(name,{tenantId:'fixture',calendarId:'one'});assert.ok(id);
  const jobs=await boss.fetch<{tenantId:string;calendarId:string}>(name);const job=jobs.find(j=>j.id===id);assert.ok(job);
  assert.equal(job.data.calendarId,'one');await boss.complete(name,id);
  console.log(JSON.stringify({bun:Bun.version,pgBoss:'12.38.1',startSendFetchComplete:true,jobId:id,elapsedMs:Math.round(performance.now()-start)},null,2));
}finally{await boss.stop({graceful:true,timeout:3000});}
