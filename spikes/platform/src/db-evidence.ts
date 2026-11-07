import { strict as assert } from 'node:assert';
import { SQL } from 'bun';
import { drizzle as bunDrizzle } from 'drizzle-orm/bun-sql';
import { sql } from 'drizzle-orm';
import { client, db, databaseURL } from './db';
const native=new SQL(databaseURL);
const bunDb=bunDrizzle(native);
const tenantA=crypto.randomUUID(),tenantB=crypto.randomUUID();
try {
  const identity=await client`select current_user,version(),rolsuper,rolcreaterole from pg_roles where rolname=current_user`;
  await client`create table if not exists platform_rls (id serial primary key, tenant_id uuid not null, payload text not null)`;
  await client`truncate platform_rls`;
  await client`insert into platform_rls (tenant_id,payload) values (${tenantA},'A'),(${tenantB},'B')`;
  await client.unsafe(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='supercal_platform_app') THEN CREATE ROLE supercal_platform_app NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`);
  await client`grant usage on schema public to supercal_platform_app`;
  await client`grant select,insert,update,delete on platform_rls to supercal_platform_app`;
  await client`grant usage,select on sequence platform_rls_id_seq to supercal_platform_app`;
  await client`alter table platform_rls enable row level security`;
  await client`alter table platform_rls force row level security`;
  await client`drop policy if exists tenant_isolation on platform_rls`;
  await client`create policy tenant_isolation on platform_rls using (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)`;
  const pgRows=await db.transaction(async tx=>{
    await tx.execute(sql`set local role supercal_platform_app`);
    await tx.execute(sql`select set_config('app.tenant_id',${tenantA},true)`);
    return tx.execute<{payload:string}>(sql`select payload from platform_rls`);
  });
  assert.deepEqual(pgRows.map(r=>r.payload),['A']);
  const bunRows=await bunDb.transaction(async tx=>{
    await tx.execute(sql`set local role supercal_platform_app`);
    await tx.execute(sql`select set_config('app.tenant_id',${tenantB},true)`);
    return tx.execute<{payload:string}>(sql`select payload from platform_rls`);
  });
  assert.deepEqual(bunRows.map(r=>r.payload),['B']);
  const noTenant=await db.transaction(async tx=>{
    await tx.execute(sql`set local role supercal_platform_app`);
    return tx.execute(sql`select * from platform_rls`);
  }); assert.equal(noTenant.length,0);
  let blockedCode:string|undefined;
  try {await db.transaction(async tx=>{
    await tx.execute(sql`set local role supercal_platform_app`);
    await tx.execute(sql`select set_config('app.tenant_id',${tenantA},true)`);
    await tx.execute(sql`insert into platform_rls (tenant_id,payload) values (${tenantB},'blocked')`);
  });}catch(error){
    if(error instanceof Error && error.cause instanceof Error){const code:unknown=Reflect.get(error.cause,'code');if(typeof code==='string')blockedCode=code;}
  } assert.equal(blockedCode,'42501');
  await assert.rejects(db.transaction(async tx=>{await tx.execute(sql`insert into platform_rls(tenant_id,payload) values(${tenantA},'rollback-pg')`);throw new Error('rollback');}));
  await assert.rejects(bunDb.transaction(async tx=>{await tx.execute(sql`insert into platform_rls(tenant_id,payload) values(${tenantA},'rollback-bun')`);throw new Error('rollback');}));
  const counts=await client<{count:number}[]>`select count(*)::int as count from platform_rls`;assert.equal(counts[0]?.count,2);
  let resolveNotify:(value:string)=>void=()=>{};
  const delivery=new Promise<string>(resolve=>{resolveNotify=resolve;});
  const listener=await client.listen('platform_probe',payload=>resolveNotify(payload));
  const before=performance.now();
  await native`select pg_notify('platform_probe','from-bun-sql')`;
  const payload=await Promise.race([delivery,Bun.sleep(3000).then(()=>{throw new Error('notify timeout');})]);
  const elapsed=performance.now()-before;assert.equal(payload,'from-bun-sql');
  await listener.unlisten();
  await native.unsafe('LISTEN platform_native_probe');
  console.log(JSON.stringify({bun:Bun.version,postgres:identity[0],postgresJs:{transactionCommit:true,rollback:true,listenNotify:true,notifyMs:Math.round(elapsed)},bunSql:{transactionCommit:true,rollback:true,notifyViaSql:true,rawListenAccepted:true,listenAPI:typeof Reflect.get(native,'listen')},rls:{pgForgotWhere:pgRows.map(r=>r.payload),bunForgotWhere:bunRows.map(r=>r.payload),unsetTenantRows:noTenant.length,crossTenantInsertBlocked:blockedCode==='42501',blockedSqlState:blockedCode,role:'supercal_platform_app NOSUPERUSER NOBYPASSRLS',tableOwner:'supercal (test setup only)',forceRls:true}},null,2));
}finally{await native.close();await client.end();}
