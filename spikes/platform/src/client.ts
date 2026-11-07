import createClient from 'openapi-fetch';
import createQueryClient from 'openapi-react-query';
import type {paths} from './generated';
export const http=createClient<paths>({baseUrl:'',credentials:'include'});
export const api=createQueryClient(http);
