import { seedObservedGrok } from './fx-routing-fixtures.ts';
import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { lockFile } from '../src/accounts/storage.ts';
import { readPool } from '../src/accounts/store.ts';
import { buildCodexObservation } from '../src/codex/observe.ts';
import { readRoutingEvidence } from '../src/routing-evidence/index.ts';
import { nextCodexSourceRevision, nextGrokSourceRevision, readCodexObservation, readGrokObservation } from '../src/observe.ts';
import { writeSidecar } from '../src/sidecar.ts';
import { fixtureState, managed, seed } from './managed-fixtures.ts';

test('private bridge fences activation, refuses browser/auth input, bounds failure retry and releases the lease', async () => {
  const state=fixtureState();await seed(state,[managed()]);
  writeSidecar(state.paths.codexObservation,buildCodexObservation(readPool(state.paths).accounts,Date.now()));
  (await lockFile(state.paths.codexRefreshLock,0))();
  await seedObservedGrok(state.paths);
  const evidence=await readRoutingEvidence(state.paths);
  let forwards=0;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request) {
    if (new URL(request.url).pathname.endsWith('/models')) return Response.json({models:[{slug:'gpt-test',visibility:'list',supported_in_api:true,supported_reasoning_levels:[{effort:'low'}]}]});
    forwards++;expect(request.headers.get('authorization')).toBe('Bearer access-codex-1');
    return new Response('access-codex-1',{status:429});
  }});
  const child=spawn(process.execPath,['src/cli.ts','fx-bridge'],{cwd:join(import.meta.dir,'..'),env:{...process.env,...state.env,AGENTUSAGE_TEST_CODEX_ORIGIN:`http://127.0.0.1:${server.port}`},stdio:['pipe','pipe','pipe']});
  child.stderr.resume();
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  const next=async () => {const line=await lines.next();expect(line.done).toBe(false);return JSON.parse(line.value!);};
  const exit=new Promise<number|null>(resolve=>child.once('close',resolve));
  try {
    child.stdin.write(JSON.stringify({schema_version:1,deadline_ms:Date.now()+60_000,owner:{host_id:'test-host',host_incarnation:'test-instance',execution_id:'test-exec',attempt_id:'test-attempt',control_epoch:1},selection:{account_key:'codex-1',model:'gpt-test',effort:'low',service_tier:null,expected_source_revision:evidence.source_revision}})+'\n');
    const prepared=await next();expect(prepared.type).toBe('prepared');
    const url=prepared.private_transport.chat_url;
    expect(JSON.stringify(prepared.receipt)).not.toContain('access-codex-1');
    expect((await fetch(url,{method:'POST',body:'{}'})).status).toBe(409);
    expect((await fetch(prepared.private_transport.catalog_url,{headers:{origin:'http://evil.test'}})).status).toBe(403);
    expect((await fetch(prepared.private_transport.catalog_url,{headers:{authorization:'Bearer injected'}})).status).toBe(403);
    expect((await fetch(prepared.private_transport.catalog_url)).status).toBe(200);
    child.stdin.write(JSON.stringify({action:'activate',native:{process_instance_id:'test-process',fx_build_revision:'test-build',session_id:'test-session'}})+'\n');
    const active=await next();expect(active.type).toBe('active');
    const request={method:'POST',body:JSON.stringify({model:'gpt-test',store:false,reasoning:{effort:'low'}})};
    const result=await fetch(url,request);expect(result.status).toBe(429);expect(await result.text()).not.toContain('access-codex-1');
    expect((await next()).type).toBe('forward');
    expect((await fetch(url,request)).status).toBe(403);expect(forwards).toBe(1);
    child.stdin.end(JSON.stringify({action:'release'})+'\n');
    expect((await next()).type).toBe('released');expect(await exit).toBe(0);
  } finally {child.kill('SIGKILL');await exit;server.stop(true);}
},30_000);

test('prepares a lease before a queued routing-revision publication can advance', async () => {
  const state=fixtureState();await seed(state,[managed()]);
  writeSidecar(state.paths.codexObservation,buildCodexObservation(readPool(state.paths).accounts,Date.now()));
  (await lockFile(state.paths.codexRefreshLock,0))();
  await seedObservedGrok(state.paths);
  const evidence=await readRoutingEvidence(state.paths);
  let startPublisher!:()=>void, published!:()=>void;
  const publisherStarted=new Promise<void>(resolve=>{startPublisher=resolve;});
  const publication=new Promise<void>(resolve=>{published=resolve;});
  const publish=async()=>{
    startPublisher();
    const release=await lockFile(state.paths.codexRefreshLock,5_000);
    try {
      const current=readCodexObservation(state.paths)!;
      current.source_revision=nextCodexSourceRevision(current,Date.now());
      writeSidecar(state.paths.codexObservation,current);
      published();
    } finally {release();}
  };
  let publishPromise:Promise<void>|undefined;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request) {
    if (new URL(request.url).pathname.endsWith('/models')) {
      publishPromise ??= publish();
      await publisherStarted;
      return Response.json({models:[{slug:'gpt-test',visibility:'list',supported_in_api:true,supported_reasoning_levels:[{effort:'low'}]}]});
    }
    return new Response(null,{status:500});
  }});
  const child=spawn(process.execPath,['src/cli.ts','fx-bridge'],{cwd:join(import.meta.dir,'..'),env:{...process.env,...state.env,AGENTUSAGE_TEST_CODEX_ORIGIN:`http://127.0.0.1:${server.port}`},stdio:['pipe','pipe','pipe']});
  child.stderr.resume();
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  const next=async()=>{const line=await lines.next();expect(line.done).toBe(false);return JSON.parse(line.value!);};
  const exit=new Promise<number|null>(resolve=>child.once('close',resolve));
  try {
    child.stdin.write(JSON.stringify({schema_version:1,deadline_ms:Date.now()+60_000,owner:{host_id:'test-host',host_incarnation:'test-instance',execution_id:'test-exec',attempt_id:'revision-gate',control_epoch:1},selection:{account_key:'codex-1',model:'gpt-test',effort:'low',service_tier:null,expected_source_revision:evidence.source_revision}})+'\n');
    const prepared=await next();
    expect(prepared.type).toBe('prepared');
    await publication;await publishPromise;
    expect((await readRoutingEvidence(state.paths)).source_revision).not.toBe(evidence.source_revision);
    child.stdin.end(JSON.stringify({action:'release'})+'\n');
    expect((await next()).type).toBe('released');expect(await exit).toBe(0);
  } finally {child.kill('SIGKILL');await exit;server.stop(true);}
},30_000);

test('resolves the current exact revision inside broker preparation after caller preflight ages', async () => {
  const state=fixtureState();await seed(state,[managed()]);
  writeSidecar(state.paths.codexObservation,buildCodexObservation(readPool(state.paths).accounts,Date.now()));
  (await lockFile(state.paths.codexRefreshLock,0))();
  await seedObservedGrok(state.paths);
  const preflight=await readRoutingEvidence(state.paths);
  const current=readCodexObservation(state.paths)!;
  current.source_revision=nextCodexSourceRevision(current,Date.now()+1);
  writeSidecar(state.paths.codexObservation,current);
  const preparedRevision=(await readRoutingEvidence(state.paths)).source_revision;
  expect(preparedRevision).not.toBe(preflight.source_revision);
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request) {
    if(new URL(request.url).pathname.endsWith('/models')) return Response.json({models:[{slug:'gpt-test',visibility:'list',supported_in_api:true,supported_reasoning_levels:[{effort:'low'}]}]});
    return new Response(null,{status:500});
  }});
  const start=()=>spawn(process.execPath,['src/cli.ts','fx-bridge'],{cwd:join(import.meta.dir,'..'),env:{...process.env,...state.env,AGENTUSAGE_TEST_CODEX_ORIGIN:`http://127.0.0.1:${server.port}`},stdio:['pipe','pipe','pipe']});
  const run=async(expected_source_revision:number|string,attempt_id:string)=>{
    const child=start();child.stderr.resume();
    const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
    const exit=new Promise<number|null>(resolve=>child.once('close',resolve));
    child.stdin.write(JSON.stringify({schema_version:1,deadline_ms:Date.now()+60_000,owner:{host_id:'test-host',host_incarnation:'test-instance',execution_id:`test-${attempt_id}`,attempt_id,control_epoch:1},selection:{account_key:'codex-1',model:'gpt-test',effort:'low',service_tier:null,expected_source_revision}})+'\n');
    const line=await lines.next();expect(line.done).toBe(false);
    const result=JSON.parse(line.value!);
    if(result.type==='prepared') child.stdin.end(JSON.stringify({action:'release'})+'\n');
    else child.stdin.end();
    await exit;
    return result;
  };
  try {
    expect(await run(preflight.source_revision,'stale-exact')).toMatchObject({type:'error',code:'source_revision_conflict'});
    const prepared=await run('broker_prepare','atomic-current');
    expect(prepared).toMatchObject({type:'prepared',routing_source_revision:preparedRevision});
    expect(prepared.evidence.source_revision).toBe(preparedRevision);
  } finally {server.stop(true);}
},30_000);

test('keeps a prepared Grok lease usable across safe newer provider observations', async () => {
  const state=fixtureState();await seed(state,[managed()]);
  writeSidecar(state.paths.codexObservation,buildCodexObservation(readPool(state.paths).accounts,Date.now()));
  (await lockFile(state.paths.codexRefreshLock,0))();
  await seedObservedGrok(state.paths);
  const evidence=await readRoutingEvidence(state.paths);
  let forwards=0;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request) {
    const path=new URL(request.url).pathname;
    if(path==='/v1/models')return Response.json({data:[{model:'grok-test',api_backend:'responses',supports_reasoning_effort:true,reasoning_efforts:[{value:'low'}],context_window:100000,max_completion_tokens:8192}]});
    if(path==='/v1/language-models')return Response.json({models:[{id:'grok-test',input_modalities:['text'],output_modalities:['text']}]});
    forwards++;return Response.json({id:`response-${forwards}`});
  }});
  const child=spawn(process.execPath,['src/cli.ts','fx-bridge'],{cwd:join(import.meta.dir,'..'),env:{...process.env,...state.env,AGENTUSAGE_TEST_GROK_ORIGIN:`http://127.0.0.1:${server.port}`},stdio:['pipe','pipe','pipe']});
  child.stderr.resume();
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  const next=async()=>{const line=await lines.next();expect(line.done).toBe(false);return JSON.parse(line.value!);};
  const exit=new Promise<number|null>(resolve=>child.once('close',resolve));
  try {
    child.stdin.write(JSON.stringify({schema_version:1,deadline_ms:Date.now()+60_000,owner:{host_id:'test-host',host_incarnation:'test-instance',execution_id:'test-grok-exec',attempt_id:'provider-scoped-forward',control_epoch:1},selection:{account_key:'grok-2',model:'grok-test',effort:'low',service_tier:null,expected_source_revision:evidence.source_revision}})+'\n');
    const prepared=await next();expect(prepared.type).toBe('prepared');
    child.stdin.write(JSON.stringify({action:'activate',native:{process_instance_id:'test-process',fx_build_revision:'test-build',session_id:'test-session'}})+'\n');
    expect((await next()).type).toBe('active');
    const request={method:'POST',body:JSON.stringify({model:'grok-test',store:false,reasoning:{effort:'low'}})};
    expect((await fetch(prepared.private_transport.chat_url,request)).status).toBe(200);
    expect((await next()).type).toBe('forward');
    const codex=readCodexObservation(state.paths)!;
    codex.source_revision=nextCodexSourceRevision(codex,Date.now());
    writeSidecar(state.paths.codexObservation,codex);
    const advanced=await readRoutingEvidence(state.paths);
    expect(advanced.source_revision).not.toBe(evidence.source_revision);
    expect(advanced.provider_source_revisions.grok).toBe(evidence.provider_source_revisions.grok);
    expect((await fetch(prepared.private_transport.chat_url,request)).status).toBe(200);
    expect((await next()).type).toBe('forward');expect(forwards).toBe(2);
    const grok=readGrokObservation(state.paths)!;
    grok.source_revision=nextGrokSourceRevision(grok,Date.now());
    writeSidecar(state.paths.grokObservation,grok);
    const refreshed=await readRoutingEvidence(state.paths);
    expect(refreshed.provider_source_revisions.grok).toBeGreaterThan(evidence.provider_source_revisions.grok);
    expect((await fetch(prepared.private_transport.chat_url,request)).status).toBe(200);
    expect((await next()).type).toBe('forward');expect(forwards).toBe(3);
    child.stdin.end(JSON.stringify({action:'release'})+'\n');
    expect((await next()).type).toBe('released');expect(await exit).toBe(0);
  } finally {child.kill('SIGKILL');await exit;server.stop(true);}
},30_000);

test('normalizes Fx Grok permission review inference to the pinned task target', async () => {
  const state=fixtureState();await seed(state,[managed()]);
  writeSidecar(state.paths.codexObservation,buildCodexObservation(readPool(state.paths).accounts,Date.now()));
  (await lockFile(state.paths.codexRefreshLock,0))();
  await seedObservedGrok(state.paths);
  const evidence=await readRoutingEvidence(state.paths);
  const forwarded:Record<string,unknown>[]=[];
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request) {
    const path=new URL(request.url).pathname;
    if(path==='/v1/models')return Response.json({data:[{model:'grok-test',api_backend:'responses',supports_reasoning_effort:true,reasoning_efforts:[{value:'low'}],context_window:100000,max_completion_tokens:8192}]});
    if(path==='/v1/language-models')return Response.json({models:[{id:'grok-test',input_modalities:['text'],output_modalities:['text']}]});
    forwarded.push(JSON.parse(await request.text()));
    return Response.json({id:'permission-review'});
  }});
  const child=spawn(process.execPath,['src/cli.ts','fx-bridge'],{cwd:join(import.meta.dir,'..'),env:{...process.env,...state.env,AGENTUSAGE_TEST_GROK_ORIGIN:`http://127.0.0.1:${server.port}`},stdio:['pipe','pipe','pipe']});
  child.stderr.resume();
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  const next=async()=>{const line=await lines.next();expect(line.done).toBe(false);return JSON.parse(line.value!);};
  const exit=new Promise<number|null>(resolve=>child.once('close',resolve));
  try {
    child.stdin.write(JSON.stringify({schema_version:1,deadline_ms:Date.now()+60_000,owner:{host_id:'test-host',host_incarnation:'test-instance',execution_id:'test-grok-review',attempt_id:'permission-review',control_epoch:1},selection:{account_key:'grok-2',model:'grok-test',effort:'low',service_tier:null,expected_source_revision:evidence.source_revision}})+'\n');
    const prepared=await next();expect(prepared.type).toBe('prepared');
    child.stdin.write(JSON.stringify({action:'activate',native:{process_instance_id:'test-process',fx_build_revision:'test-build',session_id:'test-session'}})+'\n');
    expect((await next()).type).toBe('active');
    const permissionReview={model:'grok-4.5',store:false,stream:true,instructions:'Review the pending action.',input:[],tools:[{type:'function',name:'permission_decision',description:'Decide.',parameters:{type:'object'}}],tool_choice:'required',parallel_tool_calls:true,include:['reasoning.encrypted_content'],text:{verbosity:'low'},max_output_tokens:2048};
    const response=await fetch(prepared.private_transport.chat_url,{method:'POST',body:JSON.stringify(permissionReview)});
    expect(response.status).toBe(200);expect((await next()).type).toBe('forward');
    expect(forwarded[0]).toMatchObject({model:'grok-test',store:false,tool_choice:'required',reasoning:{effort:'low',summary:'auto'}});
    expect((forwarded[0]?.tools as Array<Record<string,unknown>>)[0]?.name).toBe('permission_decision');
    child.stdin.end(JSON.stringify({action:'release'})+'\n');
    expect((await next()).type).toBe('released');expect(await exit).toBe(0);
  } finally {child.kill('SIGKILL');await exit;server.stop(true);}
},30_000);
