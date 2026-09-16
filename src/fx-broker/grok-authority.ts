import { AccountError, record } from '../accounts/storage.ts';
import { providerURL, readCapped, type Env } from '../accounts/http.ts';
import { readState } from '../grok/store.ts';
import { credentialFingerprint } from '../grok/billing.ts';
import { XAI_COMPAT_VERSION } from '../grok/oauth.ts';
import type { StoredAccount } from '../grok/model.ts';
import type { StatePaths } from '../paths.ts';
import { withRoutingEvidenceSnapshot } from '../routing-evidence/projection.ts';
import type { RoutingEvidenceProjection } from '../routing-evidence/types.ts';
import { sha256 } from './codex-authority.ts';
import type { FxBrokerAuthority, FxBrokerAuthorityAccount, FxBrokerTarget } from './types.ts';
const FRESH_MS = 300_000;
const MAX_BYTES = 1024 * 1024;
function fail(code: string): never { throw new AccountError(code, code, 409); }
function headers(account: StoredAccount): Headers {
  return new Headers({authorization: `Bearer ${account.credentials.accessToken}`, 'x-grok-user-id':account.userId,
    'X-XAI-Token-Auth':'xai-grok-cli','x-authenticateresponse':'authenticate-response',
    'x-grok-client-version':XAI_COMPAT_VERSION,'x-grok-client-identifier':'agentusage',accept:'application/json'});
}
function redact(bytes: Uint8Array, account: StoredAccount): Uint8Array {
  let text = new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  for(const secret of [account.credentials.accessToken,account.credentials.refreshToken,account.userId,account.email])
    if(secret) text=text.split(secret).join('[redacted]');
  return new TextEncoder().encode(text);
}
export function requireGrokCapacity(evidence: RoutingEvidenceProjection, key: string, now = Date.now()): void {
  const observation = evidence.usage.grok;
  const account = observation.accounts.find(row => row.accountKey === key);
  const observed = account?.observedAtMs ?? NaN;
  const reset = account?.included?.resetsAt ? Date.parse(account.included.resetsAt) : NaN;
  if (!account || !account.enabled || account.authStatus !== 'valid' || account.billingStatus !== 'fresh' || account.stale ||
    !Number.isFinite(observed) || observed > now || now-observed >= FRESH_MS ||
    observation.observed_at_ms > now || now-observation.observed_at_ms >= FRESH_MS ||
    !account.included || account.included.remainingPercent === null || account.included.remainingPercent <= 0 ||
    !Number.isFinite(reset) || reset <= now) fail('capacity_unavailable');
}
export function validateGrokCapability(catalog: Uint8Array, modalities: Uint8Array, model: string, effort: string): void {
  const value=record(JSON.parse(new TextDecoder().decode(catalog)));
  const modality=record(JSON.parse(new TextDecoder().decode(modalities)));
  if(!Array.isArray(value?.data) || value.data.length>128 || !Array.isArray(modality?.models) || modality.models.length>128) fail('catalog_unavailable');
  const rows=value.data.map(record).filter(row=>row?.model===model);
  const matches=modality.models.map(record).filter(row=>row?.id===model);
  if(rows.length!==1 || matches.length!==1) fail('catalog_drift');
  const row=rows[0]!, shape=matches[0]!;
  if(row.api_backend!=='responses' || row.supports_reasoning_effort!==true ||
    !Array.isArray(row.reasoning_efforts) || !row.reasoning_efforts.some(item=>record(item)?.value===effort) ||
    !Array.isArray(shape.output_modalities) || !shape.output_modalities.includes('text')) fail('catalog_drift');
}
/** A bridge pins one fresh credential fingerprint. Refresh requires a new routing decision. */
export class GrokFxAuthority implements FxBrokerAuthority {
  private constructor(readonly paths: StatePaths, readonly target: FxBrokerTarget, readonly accountKey:string,
    readonly catalog:Uint8Array, readonly modalities:Uint8Array, readonly capturedAt:number,
    readonly evidence:RoutingEvidenceProjection, private readonly fingerprint:string, private readonly env:Env) {}
  static async create(paths:StatePaths, selection:{account_key:string;model:string;effort:string;service_tier:string|null;expected_source_revision:number|string},env:Env=process.env):Promise<GrokFxAuthority> {
    if(!/^grok-[1-9]\d*$/.test(selection.account_key) || !/^[a-zA-Z0-9._-]{1,100}$/.test(selection.model) ||
      !['low','medium','high','xhigh','max','ultra'].includes(selection.effort) || ![null,'priority'].includes(selection.service_tier)) fail('invalid_selection');
    const {evidence,account}=await withRoutingEvidenceSnapshot(paths,async evidence=>{
      if(String(evidence.source_revision)!==String(selection.expected_source_revision)) fail('source_revision_conflict');
      requireGrokCapacity(evidence,selection.account_key);
      const account=(await readState(paths)).accounts.find(row=>row.accountKey===selection.account_key);
      if(!account || account.credentials.expiresAtMs<=Date.now()+240_000) fail('auth_unavailable');
      return {evidence,account};
    });
    const signal=AbortSignal.timeout(20_000);
    const response=await fetch(providerURL('grok','/v1/models',env),{headers:headers(account),redirect:'manual',signal});
    if(response.status!==200){await response.body?.cancel();fail(`catalog_http_${response.status}`);}
    const catalog=redact(await readCapped(response,MAX_BYTES,signal),account);
    // Fixed second provider-owned endpoint; the isolated fixture override is the same guarded loopback origin.
    const modalitiesURL=env.AGENTUSAGE_TEST_GROK_ORIGIN ? providerURL('grok','/v1/language-models',env) : 'https://api.x.ai/v1/language-models';
    const modalityResponse=await fetch(modalitiesURL,{headers:{authorization:`Bearer ${account.credentials.accessToken}`,accept:'application/json'},redirect:'manual',signal});
    if(modalityResponse.status!==200){await modalityResponse.body?.cancel();fail(`catalog_http_${modalityResponse.status}`);}
    const modalities=redact(await readCapped(modalityResponse,MAX_BYTES,signal),account);
    validateGrokCapability(catalog,modalities,selection.model,selection.effort);
    const capturedAt=Date.now(), digest=sha256(Buffer.concat([catalog,modalities]));
    const target:FxBrokerTarget={target_id:`grok-${selection.model}`,target_revision:digest,provider:'grok',model:selection.model,effort:selection.effort,
      service_tier:selection.service_tier,protocol:'grok-responses',capability_capture_id:`grok-${capturedAt}`,capability_digest:digest};
    const authority=new GrokFxAuthority(paths,target,selection.account_key,catalog,modalities,capturedAt,evidence,credentialFingerprint(account.credentials.accessToken),env);
    await authority.inspect('grok',selection.account_key);
    return authority;
  }
  private async account(evidence:RoutingEvidenceProjection):Promise<StoredAccount> {
    if(evidence.source_revision!==this.evidence.source_revision) fail('source_revision_conflict');
    if(Date.now()-this.capturedAt>=FRESH_MS) fail('capability_stale');
    requireGrokCapacity(evidence,this.accountKey);
    const account=(await readState(this.paths)).accounts.find(row=>row.accountKey===this.accountKey);
    if(!account || !account.enabled || account.credentials.expiresAtMs<=Date.now() || credentialFingerprint(account.credentials.accessToken)!==this.fingerprint) fail('auth_unavailable');
    return account;
  }
  async inspect(provider:'codex'|'grok',key:string):Promise<FxBrokerAuthorityAccount> {
    if(provider!=='grok' || key!==this.accountKey) fail('adapter_unsupported');
    return withRoutingEvidenceSnapshot(this.paths,async evidence=>{
      const account=await this.account(evidence);
      return {provider:'grok',account_key:key,account_generation:account.ordinal,provider_generation:1,credential_revision:1,
        enabled:true,auth_available:true,target:this.target,activation_supported:true};
    });
  }
  async forward(binding:FxBrokerAuthorityAccount,request:Parameters<FxBrokerAuthority['forward']>[1]) {
    if(binding.provider!=='grok' || binding.account_key!==this.accountKey || JSON.stringify(request.target)!==JSON.stringify(this.target)) fail('target_mismatch');
    const body=record(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(request.body)));
    if(request.operation!=='inference' || !body || body.model!==this.target.model || record(body.reasoning)?.effort!==this.target.effort ||
      (body.service_tier??null)!==this.target.service_tier || body.store!==false) fail('target_mismatch');
    const signal=AbortSignal.timeout(120_000);
    const {account,response}=await withRoutingEvidenceSnapshot(this.paths,async evidence=>{
      const account=await this.account(evidence);
      const outgoing=headers(account);outgoing.set('content-type','application/json');outgoing.set('accept','text/event-stream');outgoing.set('x-grok-model-override',this.target.model);
      const response=await fetch(providerURL('grok','/v1/responses',this.env),{method:'POST',headers:outgoing,body:request.body,redirect:'manual',signal});
      return {account,response};
    });
    const bytes=redact(await readCapped(response,MAX_BYTES,signal),account);
    return {account_generation:account.ordinal,provider_generation:1,credential_revision:1,response:{status:response.status,headers:{'content-type':response.headers.get('content-type')??'application/json'},body:bytes}};
  }
}
