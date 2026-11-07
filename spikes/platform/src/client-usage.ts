import {api,http} from './client';
import type {components} from './generated';
export function useFeeds() {
  return api.useQuery('get','/api/v1/feeds',{params:{query:{limit:20}}});
}
export function useCreateFeed() { return api.useMutation('post','/api/v1/feeds'); }
export const listOptions = api.queryOptions('get','/api/v1/feeds',{params:{query:{limit:10}}});
export function publicationSource(p: components['schemas']['Publication']) {
  return p.kind==='passthrough' ? [p.sourceCalendarId] : p.sourceCalendarIds;
}
// These prove path/body errors are rejected; tsc fails if they stop being errors.
// @ts-expect-error nonexistent route
api.queryOptions('get','/api/v1/feedz');
// @ts-expect-error wrong type for page limit
api.queryOptions('get','/api/v1/feeds',{params:{query:{limit:'many'}}});

export async function typedFetch() {
  const {data,error}=await http.GET('/api/v1/feeds',{params:{query:{limit:20}}});
  if(error) { const detail:string=error.detail; return detail; }
  return data.items.map(feed=>feed.name);
}
export async function invalidBodyRejected() {
  // @ts-expect-error virtual publications require at least the sourceCalendarIds field
  await http.POST('/api/v1/feeds',{body:{name:'Invalid',publications:[{kind:'virtual'}]}});
}
