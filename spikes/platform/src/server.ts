import { app } from './api';
import {migrateAtBoot} from './migrate';
import {attachSSE} from './sse';
if(process.env.MIGRATE_ON_BOOT!=='0')await migrateAtBoot();
await attachSSE(app);
Bun.serve({port:Number(process.env.PORT??4316),fetch:app.fetch,idleTimeout:0});
console.log(`platform ready Bun=${Bun.version} port=${process.env.PORT??4316}`);
