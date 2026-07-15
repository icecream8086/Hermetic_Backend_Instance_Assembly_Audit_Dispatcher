import createClient from 'openapi-fetch';
import type { paths } from './sdk.d.ts';

export const apiClient = createClient<paths>();
export type { paths } from './sdk.d.ts';
