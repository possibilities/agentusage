import { seedObservedGrok } from './fx-routing-fixtures.ts';
import { describe, expect, test } from 'bun:test';
import { lockFile } from '../src/accounts/storage.ts';
import { readPool } from '../src/accounts/store.ts';
import { buildCodexObservation } from '../src/codex/observe.ts';
import { CodexFxAuthority, requireCodexCapacity, validateCodexCapability } from '../src/fx-broker/codex-authority.ts';
import { readRoutingEvidence } from '../src/routing-evidence/index.ts';
import { writeSidecar } from '../src/sidecar.ts';
import { fixtureState, managed, seed } from './managed-fixtures.ts';

const catalog = {models:[{slug:'gpt-test',visibility:'list',supported_in_api:true,supported_reasoning_levels:[{effort:'low'}],additional_speed_tiers:['fast']}]};
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
async function setup() {
  const state = fixtureState();
  await seed(state,[managed()]);
  writeSidecar(state.paths.codexObservation, buildCodexObservation(readPool(state.paths).accounts,Date.now()));
  (await lockFile(state.paths.codexRefreshLock,0))();
  await seedObservedGrok(state.paths);
  return {state,evidence:await readRoutingEvidence(state.paths)};
}
describe('managed Codex Fx authority', () => {
  test('fails closed on stale measurements, unknown/exhausted capacity and passed resets', async () => {
    const {evidence} = await setup();
    requireCodexCapacity(evidence,'codex-1');
    expect(() => requireCodexCapacity(evidence,'codex-1',Date.now()+300_001)).toThrow('capacity_unavailable');
    for (const mutate of [
      (e: typeof evidence) => {e.usage.codex.accounts[0]!.eligible=false;},
      (e: typeof evidence) => {e.usage.codex.accounts[0]!.measuredAtMs=null;},
      (e: typeof evidence) => {e.usage.codex.accounts[0]!.lanes[0]!.windows[0]!.remainingPercent=0;},
      (e: typeof evidence) => {e.usage.codex.accounts[0]!.lanes[0]!.windows[0]!.resetsAt=new Date(Date.now()-1000).toISOString();},
    ]) {const copy=structuredClone(evidence);mutate(copy);expect(() => requireCodexCapacity(copy,'codex-1')).toThrow('capacity_unavailable');}
  });
  test('refuses removed, ambiguous, hidden, unsupported effort and tier metadata', () => {
    validateCodexCapability(bytes(catalog),'gpt-test','low','priority');
    for (const c of [{models:[]},{models:[...catalog.models,...catalog.models]},{models:[{...catalog.models[0],visibility:'hide'}]}])
      expect(() => validateCodexCapability(bytes(c),'gpt-test','low',null)).toThrow('catalog_drift');
    expect(() => validateCodexCapability(bytes(catalog),'gpt-test','high',null)).toThrow('catalog_drift');
    expect(() => validateCodexCapability(bytes(catalog),'gpt-test','low','flex')).toThrow('catalog_drift');
  });
  test('joins a pinned account, verifies request settings, contains secrets, and never retries rejection', async () => {
    const {state,evidence}=await setup();
    let forwards=0;
    const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request) {
      expect(request.headers.get('authorization')).toBe('Bearer access-codex-1');
      expect(request.headers.get('chatgpt-account-id')).toBe('identity-codex-1');
      if (new URL(request.url).pathname.endsWith('/models')) return Response.json(catalog);
      forwards++;
      return new Response('access-codex-1 refresh-codex-1 identity-codex-1 codex1@example.test',{status:401});
    }});
    try {
      const env={...state.env,AGENTUSAGE_TEST_CODEX_ORIGIN:`http://127.0.0.1:${server.port}`};
      const select={account_key:'codex-1',model:'gpt-test',effort:'low',service_tier:null,expected_source_revision:evidence.source_revision};
      await expect(CodexFxAuthority.create(state.paths,{...select,expected_source_revision:1},env)).rejects.toMatchObject({code:'source_revision_conflict'});
      const authority=await CodexFxAuthority.create(state.paths,select,env);
      const binding=await authority.inspect('codex','codex-1');
      await expect(authority.inspect('grok','grok-1')).rejects.toMatchObject({code:'adapter_unsupported'});
      const request={operation:'inference' as const,target:authority.target,headers:{},body:bytes({model:'gpt-test',store:false,reasoning:{effort:'high'}})};
      await expect(authority.forward(binding,request)).rejects.toMatchObject({code:'target_mismatch'});
      expect(forwards).toBe(0);
      const result=await authority.forward(binding,{...request,body:bytes({model:'gpt-test',store:false,reasoning:{effort:'low'}})});
      expect(result.response.status).toBe(401);
      expect(forwards).toBe(1);
      const text=new TextDecoder().decode(result.response.body);
      for(const secret of ['access-codex-1','refresh-codex-1','identity-codex-1','codex1@example.test']) expect(text).not.toContain(secret);
      const changed = buildCodexObservation(readPool(state.paths).accounts, Date.now());
      changed.source_revision = evidence.provider_source_revisions.codex + 1;
      writeSidecar(state.paths.codexObservation, changed);
      await expect(authority.inspect('codex', 'codex-1')).rejects.toMatchObject({code:'source_revision_conflict'});
      await expect(authority.forward(binding,{...request,body:bytes({model:'gpt-test',store:false,reasoning:{effort:'low'}})})).rejects.toMatchObject({code:'source_revision_conflict'});
      expect(forwards).toBe(1);
    } finally {server.stop(true);}
  });
});
