/**
 * Loads one publication with its ETag for editing and saves PATCHes with `If-Match`. The loaded
 * copy is not refreshed by the live stream, so an edit is always checked against the version the
 * user started from. On a 412 it reloads the publication and sets `conflict`; screens key their
 * form on `etag`, so the form restarts from the new version for the user to review.
 */
import type { components } from '@supercal/api-client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { client, isProblem } from '../../api.ts';
import { useRefreshFeeds } from './data.ts';

type Patch = components['schemas']['PublicationPatch'];

export const CONFLICT_MESSAGE = 'Someone else changed this; review and save again';

export function usePublicationEditor(id: string) {
  const [conflict, setConflict] = useState(false);
  const refresh = useRefreshFeeds();

  const query = useQuery({
    queryKey: ['publication-editor', id],
    queryFn: async () => {
      const { data, error, response } = await client.GET('/api/v1/publications/{id}', { params: { path: { id } } });
      if (error) throw error;
      return { publication: data, etag: response.headers.get('ETag') ?? '' };
    },
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  const save = useMutation({
    mutationFn: async (patch: Patch) => {
      const etag = query.data?.etag;
      const { data, error } = await client.PATCH('/api/v1/publications/{id}', {
        params: { path: { id }, ...(etag && { header: { 'if-match': etag } }) },
        body: patch,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      setConflict(false);
      await Promise.all([refresh(), query.refetch()]);
    },
    onError: async (error) => {
      if (!isProblem(error) || error.status !== 412) return;
      setConflict(true);
      await query.refetch();
    },
  });

  return { query, save, conflict };
}
