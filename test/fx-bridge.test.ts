import { seedObservedGrok } from './fx-routing-fixtures.ts';
import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { lockFile } from '../src/accounts/storage.ts';
import { readPool } from '../src/accounts/store.ts';
import { buildCodexObservation } from '../src/codex/observe.ts';
import { readRoutingEvidence } from '../src/routing-evidence/index.ts';
import { nextCodexSourceRevision, readCodexObservation } from '../src/observe.ts';
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
