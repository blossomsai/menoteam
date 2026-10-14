import { expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { FastifyRequest } from 'fastify';
import { rateLimitKey } from '../src/workbench/rate-limit.js';
import { digest } from '../src/workbench/auth.js';

it('gives authenticated read/renew one finite Connector control bucket without partitioning by run or token',async()=>{
  const sql=(async(strings:TemplateStringsArray,...values:unknown[])=>{
    const query=strings.join('?');
    if(query.includes('FROM wb_connectors WHERE digest='))return values[0]===digest('owner-token')?[{id:'fixture'}]:[];
    if(query.includes('FROM wb_bridge_tokens'))return values[0]===digest('bridge-token')?[{id:'fixture'}]:[];
    return [];
  }) as unknown as Sql;
  const key=rateLimitKey(sql);
  const request=(route:string,token='owner-token',id='one')=>({ip:'127.0.0.1',routeOptions:{url:route},headers:{authorization:`Bearer ${token}`},params:{id}} as unknown as FastifyRequest);
  expect(await key(request('/api/workbench/connector/runs/:id'))).toBe('connector:fixture:lease-control');
  expect(await key(request('/api/workbench/connector/runs/:id/renew','owner-token','two'))).toBe('connector:fixture:lease-control');
  for(const route of ['/api/workbench/connector/claim','/api/workbench/connector/runs/:id/artifacts','/api/workbench/connector/runs/:id/recovery-state','/api/workbench/connector/runs/:id/qa-authorize'])expect(await key(request(route))).toBe('connector:fixture');
  expect(await key(request('/api/workbench/connector/runs/:id/tools','bridge-token'))).toBe('connector:fixture');
  for(const route of ['/api/workbench/connector/runs/:id','/api/workbench/connector/runs/:id/renew'])expect(await key(request(route,'revoked-token'))).toBe('ip:127.0.0.1');
  expect(await key(request('/api/workbench/connector/runs/:id/renew','bridge-token'))).toBe('ip:127.0.0.1');
});
