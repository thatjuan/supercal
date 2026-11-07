import postgres from 'postgres';
import { claim,complete } from './scheduler';
const sql=postgres(process.env.DATABASE_URL??'postgres://supercal:spike@hare:55432/spike_platform',{max:2});
const owner=crypto.randomUUID();
const end=Date.now()+Number(process.env.DURATION_MS??60_000);
let handled=0;
try {
  while(Date.now()<end){
    const rows=await claim(sql,owner,1200,8);
    if(process.env.CRASH_ON_CLAIM==='1'&&rows.length){
      console.log(JSON.stringify({crashed:owner,ids:rows.map(r=>r.id)}));
      process.exit(86);
    }
    if(!rows.length){await Bun.sleep(20);continue;}
    await Promise.all(rows.map(async row=>{
      await Bun.sleep(10+Math.random()*30);
      // Some first attempts fail, then succeed; repeated changes get a shorter poll.
      const error=row.id%19===0&&row.attempts===1?'fixture provider timeout':null;
      await complete(sql,owner,row,error,row.id%3===0);handled++;
    }));
  }
  console.log(JSON.stringify({worker:owner,handled}));
}finally{await sql.end();}
