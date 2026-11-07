import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {Outlet,createRootRoute,createRoute,createRouter,RouterProvider} from '@tanstack/react-router';
import {api} from '../src/client';
import {authClient} from './auth-client';
function Feeds(){
  const session=authClient.useSession();
  const feeds=api.useQuery('get','/api/v1/feeds',{params:{query:{limit:20}}},{enabled:!!session.data});
  return <main><h1>Supercal</h1><p>{session.data?.user.name??'Sign in through Better Auth to list feeds.'}</p>{feeds.error&&<p>Feed request failed.</p>}<ul>{feeds.data?.items.map(feed=><li key={feed.id}>{feed.name}</li>)}</ul></main>;
}
const rootRoute=createRootRoute({component:Outlet});
const feedRoute=createRoute({getParentRoute:()=>rootRoute,path:'/',component:Feeds});
const router=createRouter({routeTree:rootRoute.addChildren([feedRoute])});
declare module '@tanstack/react-router' {interface Register{router:typeof router}}
const root=document.getElementById('root');if(!root)throw new Error('Missing root');
createRoot(root).render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router}/></QueryClientProvider>);
