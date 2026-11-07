import type postgres from 'postgres';
export type Claimed = {id:number;lease_version:number;attempts:number};
export async function claim(sql:postgres.Sql, owner:string, leaseMs=1000, limit=8) {
  return sql.begin(async tx=>{
    const rows=await tx<Claimed[]>`
      with picked as (
        select id from calendar_sync
        where next_run_at<=clock_timestamp()
          and (lease_until is null or lease_until<clock_timestamp())
        order by next_run_at,id for update skip locked limit ${limit}
      )
      update calendar_sync c set lease_until=clock_timestamp()+${leaseMs}*interval '1 millisecond',
        lease_owner=${owner},lease_version=c.lease_version+1,attempts=c.attempts+1
      from picked where c.id=picked.id returning c.id,c.lease_version,c.attempts`;
    for(const row of rows) await tx`insert into sync_audit(calendar_id,owner,generation,claimed_at) values(${row.id},${owner},${row.lease_version},clock_timestamp())`;
    return rows;
  });
}
export function nextDelayMs({changed,attempts,random=Math.random()}:{changed:boolean;attempts:number;random?:number}) {
  if(attempts>0) return Math.min(300_000,1000*2**Math.min(attempts-1,12))*(0.5+random*0.5);
  return changed?1000:4000;
}
export async function complete(sql:postgres.Sql,owner:string,row:Claimed,error:string|null,changed:boolean) {
  const delay=nextDelayMs({changed,attempts:error?row.attempts:0});
  return sql.begin(async tx=>{
    // Generation AND owner fence an expired worker from overwriting a newer claim.
    const updated=await tx`
      update calendar_sync set lease_until=null,lease_owner=null,
        next_run_at=clock_timestamp()+${delay}*interval '1 millisecond',
        attempts=${error?row.attempts:0},last_error=${error}
      where id=${row.id} and lease_owner=${owner} and lease_version=${row.lease_version}
        and lease_until>clock_timestamp() returning id`;
    await tx`update sync_audit set completed_at=clock_timestamp(),accepted=${updated.length===1},error=${error}
      where calendar_id=${row.id} and owner=${owner} and generation=${row.lease_version}`;
    return updated.length===1;
  });
}
