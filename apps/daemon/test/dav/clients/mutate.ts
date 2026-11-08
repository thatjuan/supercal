/**
 * Server-side changes for the client scripts, against `DATABASE_URL` (a seeded `fixture.ts` world):
 *
 *   bun mutate.ts put <calendar> <uid> <summary>
 *   bun mutate.ts delete <calendar> <uid>
 *   bun mutate.ts bump-epoch <publication slug>
 */
import { closeDb, connectDb } from '@supercal/db';
import { bumpPublicationEpoch, deleteEvent, putEvent } from '../fixture.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
connectDb(url);

const [op, a = '', b = '', c = ''] = process.argv.slice(2);
const calendar = (name: string) => {
  if (name === 'work' || name === 'home' || name === 'bulk' || name === 'personal') return name;
  throw new Error(`unknown calendar ${name}`);
};
if (op === 'put') await putEvent(calendar(a), b, c);
else if (op === 'delete') await deleteEvent(calendar(a), b);
else if (op === 'bump-epoch') await bumpPublicationEpoch(a);
else throw new Error(`unknown op ${op}`);
await closeDb();
