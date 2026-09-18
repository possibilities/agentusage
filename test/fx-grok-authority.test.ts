import {expect,test} from 'bun:test';
import {lockFile} from '../src/accounts/storage.ts';
import {readPool} from '../src/accounts/store.ts';
import {buildCodexObservation} from '../src/codex/observe.ts';
import {buildGrokObservation} from '../src/grok/observe.ts';
import {nextGrokSourceRevision} from '../src/observe.ts';
import {readRoutingEvidence} from '../src/routing-evidence/index.ts';
import {writeSidecar} from '../src/sidecar.ts';
import {GrokFxAuthority,requireGrokCapacity} from '../src/fx-broker/grok-authority.ts';
import {fixtureState,managed,seed} from './managed-fixtures.ts';
import {account,billing,seedGrok} from './grok-fixtures.ts';
const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value));
test('Grok owner fences included quota, source/credential changes and exact request settings without leaking auth',async()=>{
  const state=fixtureState();await seed(state,[managed()]);
  writeSidecar(state.paths.codexObservation,buildCodexObservation(readPool(state.paths).accounts,Date.now()));
  (await lockFile(state.paths.codexRefreshLock,0))();
  const now=Date.now();const row=account(2,billing({included:{usedPercent:0,remainingPercent:100,periodType:'USAGE_PERIOD_TYPE_WEEKLY',periodStart:new Date(now-1000).toISOString(),resetsAt:new Date(now+86400_000).toISOString()}}),now);
  await seedGrok(state.paths,[row]);const observed=buildGrokObservation([row],now);observed.source_revision=nextGrokSourceRevision(null,now);writeSidecar(state.paths.grokObservation,observed);(await lockFile(state.paths.grokRefreshLock,0))();
  const evidence=await readRoutingEvidence(state.paths);requireGrokCapacity(evidence,'grok-2');
  for(const update of [(e:typeof evidence)=>{e.usage.grok.accounts[0]!.included=null;},(e:typeof evidence)=>{e.usage.grok.accounts[0]!.included!.remainingPercent=0;},(e:typeof evidence)=>{e.usage.grok.accounts[0]!.stale=true;}]){const e=structuredClone(evidence);update(e);expect(()=>requireGrokCapacity(e,'grok-2')).toThrow('capacity_unavailable');}
  let forwards=0;const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){
    expect(request.headers.get('authorization')).toBe('Bearer access-2');
    const path=new URL(request.url).pathname;
    if(path==='/v1/models')return Response.json({data:[{model:'grok-test',api_backend:'responses',supports_reasoning_effort:true,reasoning_efforts:[{value:'low'}],context_window:100000,max_completion_tokens:8192}]});
    if(path==='/v1/language-models')return Response.json({models:[{id:'grok-test',input_modalities:['text'],output_modalities:['text']}]});
    forwards++;expect(request.headers.get('x-grok-user-id')).toBe('acct_2');return new Response('access-2 refresh-2 acct_2 user2@example.test',{status:429});
  }});
  try{
    const env={...state.env,AGENTUSAGE_TEST_GROK_ORIGIN:`http://127.0.0.1:${server.port}`};
    const authority=await GrokFxAuthority.create(state.paths,{account_key:'grok-2',model:'grok-test',effort:'low',service_tier:null,expected_source_revision:evidence.source_revision},env);
    const binding=await authority.inspect('grok','grok-2');
    const request={operation:'inference' as const,target:authority.target,headers:{},body:bytes({model:'grok-test',store:false,reasoning:{effort:'low'}})};
    await expect(authority.forward(binding,{...request,body:bytes({model:'grok-other',store:false,reasoning:{effort:'low'}})})).rejects.toMatchObject({code:'target_mismatch'});
    const result=await authority.forward(binding,request);expect(result.response.status).toBe(429);expect(forwards).toBe(1);
    for(const secret of ['access-2','refresh-2','acct_2','user2@example.test'])expect(new TextDecoder().decode(result.response.body)).not.toContain(secret);
    const codex=buildCodexObservation(readPool(state.paths).accounts,Date.now());codex.source_revision=evidence.provider_source_revisions.codex+1;writeSidecar(state.paths.codexObservation,codex);
    expect((await readRoutingEvidence(state.paths)).source_revision).not.toBe(evidence.source_revision);
    expect((await authority.forward(binding,request)).response.status).toBe(429);expect(forwards).toBe(2);
    observed.source_revision++;writeSidecar(state.paths.grokObservation,observed);
    expect((await authority.forward(binding,request)).response.status).toBe(429);expect(forwards).toBe(3);
    const exhausted=account(2,billing({included:{usedPercent:100,remainingPercent:0,periodType:'USAGE_PERIOD_TYPE_WEEKLY',periodStart:new Date(now-1000).toISOString(),resetsAt:new Date(now+86400_000).toISOString()}}),Date.now());
    await seedGrok(state.paths,[exhausted]);
    const exhaustedObservation=buildGrokObservation([exhausted],Date.now());
    exhaustedObservation.source_revision=evidence.provider_source_revisions.grok+2;writeSidecar(state.paths.grokObservation,exhaustedObservation);
    await expect(authority.forward(binding,request)).rejects.toMatchObject({code:'capacity_unavailable'});expect(forwards).toBe(3);
    exhaustedObservation.source_revision=evidence.provider_source_revisions.grok-1;writeSidecar(state.paths.grokObservation,exhaustedObservation);
    await expect(authority.forward(binding,request)).rejects.toMatchObject({code:'source_revision_conflict'});expect(forwards).toBe(3);
  }finally{server.stop(true);}
});
