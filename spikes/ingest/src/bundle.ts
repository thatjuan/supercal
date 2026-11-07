import { gzipSync } from 'node:zlib';
for (const entry of ['src/caldav.ts', 'src/tsdav-entry.ts']) {
  const result = await Bun.build({ entrypoints: [entry], target: 'bun', minify: true });
  if (!result.success) throw new Error(String(result.logs));
  const output = result.outputs[0]; if (!output) throw new Error('No bundle');
  const bytes = new Uint8Array(await output.arrayBuffer());
  console.log(JSON.stringify({ entry, minifiedBytes: bytes.length, gzipBytes: gzipSync(bytes).length, bun: Bun.version }));
}
