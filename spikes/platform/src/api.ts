import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import {HTTPException} from 'hono/http-exception';
import { apiReference } from '@scalar/hono-api-reference';
import { resolvePrincipal, type Principal } from './principal';
import { auth } from './auth';
const SourceId = z.uuid();
const Publication = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('passthrough'), sourceCalendarId: SourceId }).strict().openapi('PassthroughPublication'),
  z.object({ kind: z.literal('virtual'), sourceCalendarIds: z.array(SourceId).min(2) }).strict().openapi('VirtualPublication'),
]).openapi('Publication');
const FeedInput = z.object({ name: z.string().min(1).max(120), publications: z.array(Publication) }).strict().openapi('FeedInput');
const Feed = FeedInput.extend({ id: z.uuid(), tenantId: z.string() }).openapi('Feed');
const Problem = z.object({ type: z.url(), title: z.string(), status: z.number().int(), detail: z.string(), instance: z.string() }).openapi('Problem');
const errors = {
  400: { description: 'Invalid request', content: { 'application/problem+json': { schema: Problem } } },
  401: { description: 'Authentication or active tenant required', content: { 'application/problem+json': { schema: Problem } } },
  404: { description: 'Not found in tenant', content: { 'application/problem+json': { schema: Problem } } },
  500: { description: 'Internal error', content: { 'application/problem+json': { schema: Problem } } },
};
type Env = { Variables: { principal: Principal } };
export const app = new OpenAPIHono<Env>({ defaultHook(result, c) {
  if (!result.success) return c.json({ type:'https://supercal.example/problems/invalid-request', title:'Invalid request', status:400, detail:result.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; '), instance:c.req.path }, 400, { 'Content-Type':'application/problem+json' });
}});
app.openAPIRegistry.registerComponent('securitySchemes', 'session', { type:'apiKey', in:'cookie', name:'better-auth.session_token' });
app.openAPIRegistry.registerComponent('securitySchemes', 'apiKey', { type:'apiKey', in:'header', name:'x-api-key' });
const security: Record<string, string[]>[] = [{ session: [] }, { apiKey: [] }];
app.use('/api/v1/*', async (c, next) => {
  const principal = await resolvePrincipal(c.req.raw.headers);
  if (!principal) return c.json({ type:'https://supercal.example/problems/unauthorized', title:'Unauthorized', status:401, detail:'A session with an active organization or a tenant-bound API key is required', instance:c.req.path },401,{'Content-Type':'application/problem+json'});
  c.set('principal', principal);
  await next();
});
app.on(['GET','POST'], '/api/auth/*', c=>auth.handler(c.req.raw));
const feeds = new Map<string, z.infer<typeof Feed>>();
const params = z.object({ id:z.uuid().openapi({param:{name:'id',in:'path'}}) });
app.openapi(createRoute({ method:'get',path:'/api/v1/feeds',operationId:'listFeeds',security,request:{query:z.object({ cursor:z.uuid().optional(),limit:z.coerce.number().int().min(1).max(100).default(20) })},responses:{200:{description:'Keyset page, ordered by id',content:{'application/json':{schema:z.object({items:z.array(Feed),nextCursor:z.uuid().nullable()}).openapi('FeedPage')}}},...errors}}),c=>{
  const {cursor,limit}=c.req.valid('query');
  const rows=[...feeds.values()].filter(f=>f.tenantId===c.var.principal.tenantId&&(!cursor||f.id>cursor)).sort((a,b)=>a.id.localeCompare(b.id));
  const items=rows.slice(0,limit);
  return c.json({items,nextCursor:rows.length>limit ? items.at(-1)?.id ?? null:null},200);
});
app.openapi(createRoute({method:'post',path:'/api/v1/feeds',operationId:'createFeed',security,request:{body:{required:true,content:{'application/json':{schema:FeedInput}}}},responses:{201:{description:'Created',content:{'application/json':{schema:Feed}}},...errors}}),c=>{
  const feed={...c.req.valid('json'),id:crypto.randomUUID(),tenantId:c.var.principal.tenantId};
  feeds.set(feed.id,feed); return c.json(feed,201);
});
app.openapi(createRoute({method:'get',path:'/api/v1/feeds/{id}',operationId:'getFeed',security,request:{params},responses:{200:{description:'Feed',content:{'application/json':{schema:Feed}}},...errors}}),c=>{
  const feed=feeds.get(c.req.valid('param').id);
  if(!feed||feed.tenantId!==c.var.principal.tenantId) return c.json({type:'https://supercal.example/problems/not-found',title:'Not found',status:404,detail:'Feed not found',instance:c.req.path},404,{'Content-Type':'application/problem+json'});
  return c.json(feed,200);
});
app.openapi(createRoute({method:'patch',path:'/api/v1/feeds/{id}',operationId:'updateFeed',security,request:{params,body:{required:true,content:{'application/json':{schema:FeedInput.partial().openapi('FeedPatch')}}}},responses:{200:{description:'Updated',content:{'application/json':{schema:Feed}}},...errors}}),c=>{
  const feed=feeds.get(c.req.valid('param').id);
  if(!feed||feed.tenantId!==c.var.principal.tenantId) return c.json({type:'https://supercal.example/problems/not-found',title:'Not found',status:404,detail:'Feed not found',instance:c.req.path},404,{'Content-Type':'application/problem+json'});
  const updated={...feed,...c.req.valid('json')}; feeds.set(feed.id,updated); return c.json(updated,200);
});
app.get('/api/v1/principal',c=>c.json(c.var.principal));
app.doc31('/openapi.json',{openapi:'3.1.0',info:{title:'Supercal platform spike',version:'0.1.0'}});
app.get('/docs',apiReference({url:'/openapi.json'}));
app.get('/health',c=>c.json({ok:true,bun:Bun.version}));
app.onError((error,c)=>{
  if(error instanceof HTTPException&&error.status===400)return c.json({type:'https://supercal.example/problems/invalid-request',title:'Invalid request',status:400,detail:'Malformed request body',instance:c.req.path},400,{'Content-Type':'application/problem+json'});
  console.error(error);
  return c.json({type:'https://supercal.example/problems/internal',title:'Internal error',status:500,detail:'Internal server error',instance:c.req.path},500,{'Content-Type':'application/problem+json'});
});
