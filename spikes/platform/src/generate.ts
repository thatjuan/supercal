import { app } from './api';
import { auth } from './auth';
import { client } from './db';
await Bun.write('openapi.json',JSON.stringify(app.getOpenAPI31Document({openapi:'3.1.0',info:{title:'Supercal platform spike',version:'0.1.0'}}),null,2));
const authSpec=await auth.api.generateOpenAPISchema();
await Bun.write('auth-openapi.json',JSON.stringify(authSpec,null,2));
console.log(JSON.stringify({management:'3.1.0',authVersion:authSpec.openapi,authPaths:Object.keys(authSpec.paths).length,authFirstPath:Object.keys(authSpec.paths)[0],authServers:authSpec.servers}));
await client.end();
