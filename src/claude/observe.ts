import { statePaths } from '../paths.ts';
import { refreshUsage } from '../accounts/usage.ts';
import { record } from '../accounts/storage.ts';
import type { ManagedAccount } from '../accounts/store.ts';
import { OBSERVATION_SCHEMA_VERSION, type Observation, type NormalizedWindow, type AccountObservationIssue, type AccountCapacityMetadata } from './types.ts';

export function parseClaudeUsage(value:unknown):{windows:NormalizedWindow[];malformedScoped:boolean}{
 const raw=record(value);if(!raw)return {windows:[],malformedScoped:false};
 const windows:NormalizedWindow[]=[];let malformedScoped=false;
 for(const [name,value]of Object.entries(raw)){
  const key=name==='five_hour'?'session':name==='seven_day'?'week':name.startsWith('seven_day_')?`model:${name.slice(10).toLowerCase()}`:name==='extra_usage'?'spend':null;
  if(!key||value===null)continue;
  const w=record(value);
  const valid=w&&typeof w.utilization==='number'&&Number.isFinite(w.utilization)&&w.utilization>=0;
  if(!valid){if(key.startsWith('model:'))malformedScoped=true;continue;}
  if(key==='spend'&&w.is_enabled!==true)continue;
  const reset=typeof w.resets_at==='string'&&/(?:[zZ]|[+-]\d{2}:?\d{2})$/u.test(w.resets_at)?Date.parse(w.resets_at):NaN;
  windows.push({key,utilization:Math.max(0,Number(w.utilization)/100),resetsAt:Number.isFinite(reset)?new Date(reset).toISOString():null});
 }
 return {windows,malformedScoped};
}
export function buildObservation(accounts:readonly ManagedAccount[],nowMs:number):Observation{
 const observation:Observation={schema_version:OBSERVATION_SCHEMA_VERSION,observed_at_ms:nowMs,health:'ok',routes:[],claude_accounts:{count:0,ordinals:{}},account_capacity:{},account_measurements:{},account_issues:{},notes:[]};
 for(const a of accounts.filter(a=>a.provider==='claude')){
  const id=a.key;
  observation.claude_accounts.count++;
  observation.claude_accounts.ordinals[id]=a.ordinal-1;
  const capacity:AccountCapacityMetadata={};
  if(a.subscription_type==='max'||a.subscription_type==='pro')capacity.subscriptionType=a.subscription_type;
  if(a.rate_limit_multiplier)capacity.rateLimitMultiplier=a.rate_limit_multiplier;
  if(Object.keys(capacity).length)observation.account_capacity![id]=capacity;
  const parsed=parseClaudeUsage(a.usage?.value);
  if(a.usage&&parsed.windows.length&&!parsed.malformedScoped)observation.account_measurements![id]={windows:parsed.windows,measuredAtMs:a.usage.measured_at_ms};
  let issue:AccountObservationIssue|null=null;
  if(!a.enabled)issue='account-unavailable';
  else if(a.auth_error)issue='relogin-required';
  else if(a.usage_error||!a.usage)issue='usage-unavailable';
  else if(a.usage.measured_at_ms>nowMs+1000||nowMs-a.usage.measured_at_ms>300_000)issue='missing-freshness';
  else if(parsed.malformedScoped)issue='malformed-scoped-windows';
  else if(!parsed.windows.some(w=>w.key==='session')||!parsed.windows.some(w=>w.key==='week'))issue='missing-windows';
  if(issue)observation.account_issues[id]=issue;
  else observation.routes.push({id,kind:'managed',slot:a.ordinal,windows:parsed.windows,measuredAtMs:a.usage!.measured_at_ms});
 }
 return observation;
}
export async function observeClaude(env:Record<string,string|undefined>=process.env):Promise<Observation>{
 return buildObservation(await refreshUsage(statePaths(env),'claude',env),Date.now());
}
