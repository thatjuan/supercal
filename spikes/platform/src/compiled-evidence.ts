import {strict as assert} from 'node:assert';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {z} from 'zod';
import {client} from './db';
const executable=resolve(process.argv[2]??'build/platform-macos');
const before=await client`select to_regclass('platform_api_key_binding') is not null as probe_exists`;
const start=performance.now();
const processes=[4318,4319].map(port=>Bun.spawn([executable],{cwd:tmpdir(),env:{...process.env,PORT:String(port),BASE_URL:`http://localhost:${port}`},stdout:'pipe',stderr:'pipe'}));
try{
  const ready=await Promise.all([4318,4319].map(async port=>{
    for(let i=0;i<200;i++){
      try{const response=await fetch(`http://localhost:${port}/health`);if(response.ok)return {port,elapsedMs:Math.round(performance.now()-start),health:await response.json() as unknown};}catch{}
      await Bun.sleep(20);
    }
    throw new Error(`Compiled server ${port} startup failed`);
  }));
  const base='http://localhost:4318';
  const signup=await fetch(`${base}/api/auth/sign-up/email`,{method:'POST',headers:{'Content-Type':'application/json',origin:base},body:JSON.stringify({email:`compiled-${crypto.randomUUID()}@example.invalid`,password:'compiled-spike-password',name:'Compiled Gnomon'})});assert.equal(signup.status,200);
  const cookie=signup.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
  const org=await fetch(`${base}/api/auth/organization/create`,{method:'POST',headers:{'Content-Type':'application/json',origin:base,cookie},body:JSON.stringify({name:'Compiled tenant',slug:`compiled-${crypto.randomUUID()}`})});assert.equal(org.status,200);
  const tenantId=z.object({id:z.string()}).parse(await org.json()).id;
  const active=await fetch(`${base}/api/auth/organization/set-active`,{method:'POST',headers:{'Content-Type':'application/json',origin:base,cookie},body:JSON.stringify({organizationId:tenantId})});assert.equal(active.status,200);
  const session=await fetch(`${base}/api/v1/principal`,{headers:{cookie}});assert.equal(session.status,200);
  const docs=await fetch(`${base}/docs`);assert.equal(docs.status,200);
  const after=await client`select to_regclass('platform_api_key_binding') is not null as probe_exists`;
  console.log(JSON.stringify({executable,workingDirectory:tmpdir(),binaryBytes:(await Bun.file(executable).stat()).size,ready,bindingTableBefore:before[0],bindingTableAfter:after[0],compiledAuth:{signup:signup.status,organization:org.status,protectedRoute:session.status},scalar:docs.status},null,2));
}finally{
  for(const child of processes)child.kill();
  for(const child of processes){await child.exited;console.log(await new Response(child.stdout).text());console.log(await new Response(child.stderr).text());}
  await client.end();
}
