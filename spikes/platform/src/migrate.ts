import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import initial from '../migrations/0000_luxuriant_sharon_ventura.sql' with {type:'text'};
import probe from '../migrations/0001_supreme_mac_gargan.sql' with {type:'text'};
import binding from '../migrations/0002_sour_captain_universe.sql' with {type:'text'};
import journal from '../migrations/meta/_journal.json';
import {client,db} from './db';
// Static text imports embed SQL in a compiled executable. Drizzle's standard reader needs files.
export async function migrateAtBoot(){
  const start=performance.now();
  const lock=await client.reserve();
  let directory:string|undefined;
  try{
    await lock`select pg_advisory_lock(731605012)`;
    directory=await mkdtemp(join(tmpdir(),'supercal-platform-migrations-'));
    await mkdir(join(directory,'meta'));
    await writeFile(join(directory,'meta','_journal.json'),JSON.stringify(journal));
    await writeFile(join(directory,'0000_luxuriant_sharon_ventura.sql'),initial);
    await writeFile(join(directory,'0001_supreme_mac_gargan.sql'),probe);
    await writeFile(join(directory,'0002_sour_captain_universe.sql'),binding);
    await migrate(db,{migrationsFolder:directory});
    await client`insert into platform_boot_probe(id) values('compiled-boot') on conflict do nothing`;
    console.log(JSON.stringify({migrations:'applied',embeddedFiles:3,advisoryLock:true,elapsedMs:Math.round(performance.now()-start)}));
  }finally{
    if(directory)await rm(directory,{recursive:true,force:true});
    await lock`select pg_advisory_unlock(731605012)`;
    lock.release();
  }
}
