import { strict as assert } from 'node:assert';
import { z } from 'zod';
import { app } from './api';
import { auth } from './auth';
import { client,db } from './db';
import {apiKeyBinding} from './platform-schema';
import {member} from './auth-schema';
import {and,eq} from 'drizzle-orm';
const userSchema=z.object({user:z.object({id:z.string()})});
const orgSchema=z.object({id:z.string()});
let cookie='';
async function request(path:string,body?:unknown,key?:string){
  return app.request(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',origin:'http://localhost:4316',...(cookie?{cookie}:{}),...(key?{'x-api-key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
async function main(){
  const signup=await request('/api/auth/sign-up/email',{email:`gnomon-${crypto.randomUUID()}@example.invalid`,password:'spike-password-12345678',name:'Gnomon'});
  const signupBody:unknown=await signup.json(); assert.equal(signup.status,200,JSON.stringify(signupBody));
  const {user}=userSchema.parse(signupBody);
  cookie=signup.headers.getSetCookie().map(s=>s.split(';')[0]).join('; '); assert.ok(cookie);
  const org=await request('/api/auth/organization/create',{name:'Platform tenant',slug:`gnomon-${crypto.randomUUID()}`});
  const orgBody:unknown=await org.json(); assert.equal(org.status,200,JSON.stringify(orgBody)); const tenantId=orgSchema.parse(orgBody).id;
  const active=await request('/api/auth/organization/set-active',{organizationId:tenantId}); assert.equal(active.status,200);
  cookie=[cookie,...active.headers.getSetCookie().map(s=>s.split(';')[0])].join('; ');
  const sessionResponse=await request('/api/v1/principal'); const principal:unknown=await sessionResponse.json(); assert.equal(sessionResponse.status,200,JSON.stringify(principal));
  assert.deepEqual(principal,{userId:user.id,tenantId,role:'owner',via:'session'});
  const key=await auth.api.createApiKey({headers:new Headers({cookie}),body:{name:'Tenant automation',metadata:{tenantId},configId:'default'}});
  await db.insert(apiKeyBinding).values({apiKeyId:key.id,tenantId,userId:user.id});
  const oldCookie=cookie; cookie='';
  const keyResponse=await request('/api/v1/principal',undefined,key.key); const keyPrincipal:unknown=await keyResponse.json();
  assert.equal(keyResponse.status,200,JSON.stringify(keyPrincipal)); assert.deepEqual(keyPrincipal,{userId:user.id,tenantId,role:'owner',via:'apiKey'});
  await auth.api.updateApiKey({headers:new Headers({cookie:oldCookie}),body:{keyId:key.id,configId:'default',metadata:{tenantId:'attacker-supplied-tenant'}}});
  assert.deepEqual(await (await request('/api/v1/principal',undefined,key.key)).json(),keyPrincipal);
  const invalid=await request('/api/v1/feeds',undefined,'bogus-key'); assert.equal(invalid.status,401);
  cookie=oldCookie;
  const orgKey=await request('/api/auth/api-key/create',{name:'Native org key',configId:'tenant',organizationId:tenantId});
  const orgKeyBody=z.object({key:z.string(),referenceId:z.string()}).parse(await orgKey.json()); assert.equal(orgKey.status,200);
  assert.equal(orgKeyBody.referenceId,tenantId);
  const verifiedOrg=await auth.api.verifyApiKey({body:{key:orgKeyBody.key,configId:'tenant'}}); assert.equal(verifiedOrg.valid,true);
  const source=crypto.randomUUID();
  const created=await request('/api/v1/feeds',{name:'One',publications:[{kind:'passthrough',sourceCalendarId:source},{kind:'virtual',sourceCalendarIds:[source,crypto.randomUUID()]}]});
  const createdBody=z.object({id:z.string()}).parse(await created.json()); assert.equal(created.status,201);
  await request('/api/v1/feeds',{name:'Two',publications:[]});
  const pageResponse=await request('/api/v1/feeds?limit=1'); const page=z.object({items:z.array(z.unknown()),nextCursor:z.string()}).parse(await pageResponse.json()); assert.equal(page.items.length,1);
  const page2=z.object({items:z.array(z.unknown()),nextCursor:z.null()}).parse(await (await request(`/api/v1/feeds?limit=1&cursor=${page.nextCursor}`)).json()); assert.equal(page2.items.length,1);
  const patch=await app.request(`/api/v1/feeds/${createdBody.id}`,{method:'PATCH',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({name:'Updated'})}); assert.equal(patch.status,200);
  const invalidBody=await request('/api/v1/feeds',{name:'Bad',publications:[{kind:'virtual',sourceCalendarIds:[source]}]});
  assert.equal(invalidBody.status,400); assert.equal(invalidBody.headers.get('Content-Type'),'application/problem+json');
  const malformed=await app.request('/api/v1/feeds',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:'{bad'});assert.equal(malformed.status,400);
  const roles:string[]=[];
  for(const role of ['admin','member','owner'] as const){
    await db.update(member).set({role}).where(and(eq(member.userId,user.id),eq(member.organizationId,tenantId)));
    const p=z.object({role:z.string()}).parse(await (await request('/api/v1/principal')).json());assert.equal(p.role,role);roles.push(p.role);
  }
  const memberships=await db.select().from(member).where(and(eq(member.userId,user.id),eq(member.organizationId,tenantId)));
  await db.delete(member).where(and(eq(member.userId,user.id),eq(member.organizationId,tenantId)));
  cookie='';const revoked=await request('/api/v1/principal',undefined,key.key);assert.equal(revoked.status,401);cookie=oldCookie;
  if(memberships[0])await db.insert(member).values(memberships[0]);
  const docs=await request('/docs'); assert.equal(docs.status,200); assert.ok((await docs.text()).includes('scalar'));
  console.log(JSON.stringify({signup:signup.status,createOrg:org.status,session:principal,apiKey:keyPrincipal,invalidKey:invalid.status,editableMetadataIgnored:true,revokedMembership:revoked.status,resolvedRoles:roles,malformedJson:malformed.status,nativeOrgKey:{created:orgKey.status,verified:verifiedOrg.valid,referenceIsTenant:true},feedCreate:created.status,patch:patch.status,pagination:[page.items.length,page2.items.length],invalidUnion:{status:invalidBody.status,contentType:invalidBody.headers.get('Content-Type')},scalar:docs.status},null,2));
  await auth.api.deleteApiKey({headers:new Headers({cookie}),body:{keyId:key.id,configId:'default'}});
}
try {await main();} finally {await client.end();}
