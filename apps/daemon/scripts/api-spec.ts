/** `bun run api:spec`: writes the OpenAPI document to packages/api-client/openapi.json without starting a server. */
import { createApi, openApiConfig } from '../src/api/index.ts';

const out = new URL('../../../packages/api-client/openapi.json', import.meta.url);
await Bun.write(out, `${JSON.stringify(createApi().getOpenAPI31Document(openApiConfig), null, 2)}\n`);
console.log(`wrote ${out.pathname}`);
