/** Feed queries shared by the Subscribe and Settings screens. */
import { $api } from '../../api.ts';

/** The signed-in user's feeds (the server creates the default one on first read). */
export const feedsQuery = $api.queryOptions('get', '/api/v1/feeds');

/** How to subscribe to one feed, with `{token}` placeholders. */
export const subscribeQuery = (feedId: string) => $api.queryOptions('get', '/api/v1/feeds/{id}/subscribe', { params: { path: { id: feedId } } });
