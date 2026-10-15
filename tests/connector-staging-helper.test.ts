import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const helper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../deploy/staging/menoteam-staging-delivery');

async function simulate(source: string): Promise<Record<string, unknown>> {
  const { stdout } = await execFile('python3', ['-c', source, helper], { encoding: 'utf8', maxBuffer: 16_384, timeout: 10_000 });
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe('fixed staging remote helper policy', () => {
  it.each(['rollback', 'deploy'])('replays completed %s after lost mutation and status responses without another mutation', async action => {
    const result = await simulate(`
import importlib.util,importlib.machinery,json,sys,tempfile,pathlib,io,contextlib,copy
spec=importlib.util.spec_from_loader('stage',importlib.machinery.SourceFileLoader('stage',sys.argv[1]));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
directory=pathlib.Path(tempfile.mkdtemp());m.STATE=directory/'state.json';m.LOCK=directory/'state.lock'
config={'targetId':'staging','imageRepository':'ghcr.io/blossomsai/menoteam-work-map'};m.load_config=lambda:config
old={'id':'deploy_old','commitSha':'c'*40,'imageDigest':'sha256:'+'d'*64,'healthPassed':True,'schemaMax':'006_old.sql'}
previous={'id':'deploy_previous','commitSha':'a'*40,'imageDigest':'sha256:'+'b'*64,'healthPassed':True,'schemaMax':'006_old.sql'}
state={'current':old,'deployments':{'deploy_old':old,'deploy_previous':previous},'operations':{}};m.atomic_write(state)
request={'action':'${action}','operationId':'run_11111111-2222-3333-4444-555555555555','targetId':'staging','commitSha':'a'*40,'imageDigest':'sha256:'+'b'*64,'expectedCurrentDeploymentId':'deploy_old'}
if request['action']=='rollback':request['previousDeploymentId']='deploy_previous'
calls=[];m.run_compose=lambda *args:calls.append(args);m.image_schema_max=lambda image:'006_old.sql';m.database_schema_latest=lambda:'006_old.sql'
m.wait_health=lambda image,commitSha,seconds=60:request['action']=='rollback' or commitSha==old['commitSha']
def invoke(value):
 m.parse_request=lambda:value
 output=io.StringIO()
 with contextlib.redirect_stdout(output):m.main()
 return json.loads(output.getvalue())
terminal=invoke(request);mutations=len(calls)
# The client loses both the mutation response and the first status response.
status={key:value for key,value in request.items() if key!='previousDeploymentId'};status['action']='status'
m.healthy=lambda *args:(_ for _ in ()).throw(Exception('terminal replay must not derive a fresh phase'))
first=invoke(status);second=invoke(status)
saved=json.loads(m.STATE.read_text());legacy=copy.deepcopy(saved);legacy['operations'][request['operationId']].pop('request');legacyResult=m.operate(config,status,legacy)
errors=[]
for key,value in [('commitSha','e'*40),('imageDigest','sha256:'+'f'*64),('expectedCurrentDeploymentId','deploy_wrong'),('targetId','other')]:
 try:invoke({**status,key:value})
 except ValueError as error:errors.append(str(error))
unknown=invoke({**status,'operationId':'run_22222222-2222-3333-4444-555555555555'})
corrupt=copy.deepcopy(saved);corrupt['operations'][request['operationId']]['request']['expectedCurrentDeploymentId']='deploy_wrong'
try:m.operate(config,{**status,'expectedCurrentDeploymentId':'deploy_wrong'},corrupt)
except ValueError as error:corruptError=str(error)
print(json.dumps({'terminal':terminal,'first':first,'second':second,'legacy':legacyResult,'callsBefore':mutations,'callsAfter':len(calls),'errors':errors,'unknown':unknown,'corruptError':corruptError}))
`);
    expect(result.terminal).toMatchObject({ phase: 'rolled_back', deploymentId: action === 'rollback' ? 'deploy_previous' : 'deploy_old', previousDeploymentId: action === 'rollback' ? 'deploy_old' : 'deploy_11111111-2222-3333-4444-555555555555' });
    expect(result.first).toEqual(result.terminal);
    expect(result.second).toEqual(result.terminal);
    expect(result.legacy).toEqual(result.terminal);
    expect(result.callsAfter).toBe(result.callsBefore);
    expect(result.errors).toHaveLength(4);
    expect(result.unknown).toMatchObject({ phase: 'unknown' });
    expect(result.corruptError).toContain('immutable operation identity');
  });

  it('supplies immutable image inputs to every Compose call and uses Docker labels for status lookup', async () => {
    const result = await simulate(`
import importlib.util,importlib.machinery,json,sys,types,tempfile,pathlib
spec=importlib.util.spec_from_loader('stage',importlib.machinery.SourceFileLoader('stage',sys.argv[1]));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.RUNTIME_DIR=pathlib.Path(tempfile.mkdtemp());m.registry_docker_config=lambda:None
calls=[]
def run(command,**kwargs):
 calls.append({'command':command,'env':kwargs.get('env',{})})
 if command[:2]==['docker','ps']:return types.SimpleNamespace(stdout='abc123456789\\n')
 if command[:2]==['docker','exec']:return types.SimpleNamespace(stdout='006_owner_provenance.sql\\n')
 return types.SimpleNamespace(stdout='')
m.subprocess.run=run
image='ghcr.io/blossomsai/menoteam-work-map@sha256:'+'b'*64;source='a'*40
m.run_compose(['stop','app'],image,source)
try:m.run_compose(['stop','app'])
except ValueError as error:missing=str(error)
app=m.staging_container_id();app_call=calls[-1]['command'];schema=m.database_schema_latest();db_call=calls[-1]['command']
print(json.dumps({'calls':calls,'missing':missing,'app':app,'appCall':app_call,'schema':schema,'dbCall':db_call}))
`);
    const calls = result.calls as Array<{ command: string[]; env: Record<string, string> }>;
    expect(calls[0]?.command).toContain('compose');
    expect(calls[0]?.env.MENOTEAM_STAGING_IMAGE).toBe('ghcr.io/blossomsai/menoteam-work-map@sha256:' + 'b'.repeat(64));
    expect(calls[0]?.env.MENOTEAM_STAGING_SOURCE_SHA).toBe('a'.repeat(40));
    expect(result.missing).toContain('immutable image');
    expect(result.app).toBe('abc123456789');
    expect((result.appCall as string[]).slice(0, 2)).toEqual(['docker', 'ps']);
    expect(result.schema).toBe('006_owner_provenance.sql');
    expect((result.dbCall as string[]).slice(0, 3)).toEqual(['docker', 'exec', 'abc123456789']);
  });

  it('confines anonymous Compose auth and cleans its temporary config after success or failure', async () => {
    const result = await simulate(`
import importlib.util,importlib.machinery,json,sys,tempfile,pathlib,os,types,io,stat
spec=importlib.util.spec_from_loader('stage',importlib.machinery.SourceFileLoader('stage',sys.argv[1]));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=pathlib.Path(tempfile.mkdtemp());os.chmod(root,0o700);m.RUNTIME_DIR=root;m.REGISTRY_CONFIG_DIR=root/'menoteam-workbench-stage-registry';m.REGISTRY_CONFIG_DIR.mkdir(mode=0o700);os.chmod(m.REGISTRY_CONFIG_DIR,0o700);config=m.REGISTRY_CONFIG_DIR/'config.json';config.write_text(json.dumps({'auths':{'ghcr.io':{'registrytoken':'fake-root-token'}}}));os.chmod(config,0o600)
original_lstat=os.lstat
def fake_lstat(path):
 info=original_lstat(path)
 if pathlib.Path(path) in (root,m.REGISTRY_CONFIG_DIR,config):return types.SimpleNamespace(st_uid=0,st_mode=info.st_mode)
 return info
m.os.lstat=fake_lstat;ambient=root/'ambient-docker';ambient.mkdir(mode=0o700);(ambient/'config.json').write_text('{"credsStore":"sentinel-helper"}');os.environ['DOCKER_CONFIG']=str(ambient);calls=[];fail_run=False
def fake_docker(command,**kwargs):
 global fail_run
 env=kwargs['env'];passed=pathlib.Path(env['DOCKER_CONFIG']);data=json.loads((passed/'config.json').read_text());mode=stat.S_IMODE(os.stat(passed).st_mode);filemode=stat.S_IMODE(os.stat(passed/'config.json').st_mode)
 calls.append({'path':str(passed),'anonymous':data=={'auths':{'ghcr.io':{}}},'external':data=={'auths':{'ghcr.io':{'registrytoken':'fake-root-token'}}},'directoryMode':mode,'fileMode':filemode,'env':env})
 if fail_run:raise RuntimeError('mocked docker failure')
m.subprocess.run=fake_docker
image='ghcr.io/blossomsai/menoteam-work-map@sha256:'+'b'*64;source='a'*40
for action in (['pull','app'],['up','-d','app'],['up','-d','app']):m.run_compose(action,image,source)
m.REGISTRY_CONFIG_DIR=root/'missing';m.run_compose(['pull','app'],image,source);success_path=pathlib.Path(calls[-1]['path']);success_gone=not success_path.exists();fail_run=True
try:m.run_compose(['pull','app'],image,source)
except RuntimeError:failure_caught=True
failure_path=pathlib.Path(calls[-1]['path']);failure_gone=not failure_path.exists()
m.REGISTRY_CONFIG_DIR=root/'menoteam-workbench-stage-registry'
config.write_text(json.dumps({'auths':{'ghcr.io':{'registrytoken':'fake-root-token'}},'credsStore':'injected'}))
try:m.registry_docker_config()
except ValueError as error:shapeError=str(error)
config.write_text(json.dumps({'auths':{'ghcr.io':{'registrytoken':'fake-root-token'}}}));os.chmod(config,0o644)
try:m.registry_docker_config()
except ValueError as error:modeError=str(error)
os.chmod(config,0o600);real=config.with_name('real-config.json');config.rename(real);config.symlink_to(real)
try:m.registry_docker_config()
except ValueError as error:linkError=str(error)
old_stdin=m.sys.stdin;m.sys.stdin=io.TextIOWrapper(io.BytesIO(json.dumps({'action':'deploy','operationId':'run_11111111-2222-3333-4444-555555555555','targetId':'staging','commitSha':'a'*40,'imageDigest':'sha256:'+'b'*64,'expectedCurrentDeploymentId':None,'dockerConfig':'/request/injected/path'}).encode()))
try:m.parse_request()
except ValueError as error:requestError=str(error)
finally:m.sys.stdin=old_stdin
print(json.dumps({'external':calls[:3],'anonymous':calls[3:],'successGone':success_gone,'failureGone':failure_gone,'failureCaught':failure_caught,'requestError':requestError,'shapeError':shapeError,'modeError':modeError,'linkError':linkError,'fixedConfig':str(root/'menoteam-workbench-stage-registry'),'ambient':str(ambient)}))
`);
    const external = result.external as Array<{ path: string; external: boolean; env: Record<string, string> }>;
    const anonymous = result.anonymous as Array<{ path: string; anonymous: boolean; directoryMode: number; fileMode: number; env: Record<string, string> }>;
    expect(external.map(call => call.path)).toEqual(Array(3).fill(result.fixedConfig));
    expect(external.every(call => call.external && Object.keys(call.env).sort().join(',') === 'DOCKER_CONFIG,LANG,MENOTEAM_STAGING_IMAGE,MENOTEAM_STAGING_SOURCE_SHA,PATH')).toBe(true);
    expect(anonymous).toHaveLength(2);
    expect(anonymous.every(call => call.anonymous && call.directoryMode === 0o700 && call.fileMode === 0o600 && call.path.startsWith(`${result.fixedConfig.slice(0, result.fixedConfig.lastIndexOf('/'))}/menoteam-staging-registry-`) && call.path !== result.ambient && Object.keys(call.env).sort().join(',') === 'DOCKER_CONFIG,LANG,MENOTEAM_STAGING_IMAGE,MENOTEAM_STAGING_SOURCE_SHA,PATH')).toBe(true);
    expect(result.successGone).toBe(true);
    expect(result.failureGone).toBe(true);
    expect(result.failureCaught).toBe(true);
    expect(result.requestError).toContain('request schema');
    expect(result.shapeError).toContain('schema is invalid');
    expect(result.modeError).toContain('file is unsafe');
    expect(result.linkError).toContain('file is unsafe');
  });

  it('keeps a failed first bootstrap offline and never removes its database volume', async () => {
    const result = await simulate(`
import importlib.util,importlib.machinery,json,sys,tempfile,pathlib
spec=importlib.util.spec_from_loader('stage',importlib.machinery.SourceFileLoader('stage',sys.argv[1]));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.STATE=pathlib.Path(tempfile.mkdtemp())/'state.json'
calls=[];m.run_compose=lambda action,image=None,source=None:calls.append(action);m.wait_health=lambda image,commitSha,seconds=60:False;m.image_schema_max=lambda image:'006_owner_provenance.sql'
request={'action':'deploy','operationId':'run_11111111-2222-3333-4444-555555555555','targetId':'staging','commitSha':'a'*40,'imageDigest':'sha256:'+'b'*64,'expectedCurrentDeploymentId':None}
state={'deployments':{},'operations':{}};answer=m.operate({'targetId':'staging','imageRepository':'ghcr.io/blossomsai/menoteam-work-map'},request,state)
print(json.dumps({'answer':answer,'calls':calls,'current':state.get('current')}))
`);
    expect((result.answer as Record<string, unknown>).phase).toBe('target_offline');
    expect(result.current).toBeNull();
    expect(JSON.stringify(result.calls)).not.toMatch(/down|volume|prune/u);
    expect(JSON.stringify(result.calls)).toContain('stop');
  });

  it('only accepts a matching health-passed image as a rollback target', async () => {
    const result = await simulate(`
import importlib.util,importlib.machinery,json,sys,tempfile,pathlib
spec=importlib.util.spec_from_loader('stage',importlib.machinery.SourceFileLoader('stage',sys.argv[1]));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.STATE=pathlib.Path(tempfile.mkdtemp())/'state.json'
calls=[];m.run_compose=lambda action,image=None,source=None:calls.append([action,image,source]);m.wait_health=lambda image,commitSha,seconds=60:True;m.image_schema_max=lambda image:'006_owner_provenance.sql';m.database_schema_latest=lambda:'006_owner_provenance.sql'
request={'action':'rollback','operationId':'run_11111111-2222-3333-4444-555555555555','targetId':'staging','commitSha':'a'*40,'imageDigest':'sha256:'+'b'*64,'previousDeploymentId':'deploy_previous','expectedCurrentDeploymentId':'deploy_current'}
state={'current':{'id':'deploy_current','commitSha':'c'*40,'imageDigest':'sha256:'+'d'*64,'healthPassed':True,'schemaMax':'006_owner_provenance.sql'},'deployments':{'deploy_previous':{'id':'deploy_previous','commitSha':'a'*40,'imageDigest':request['imageDigest'],'healthPassed':True,'schemaMax':'006_owner_provenance.sql'}},'operations':{}}
answer=m.operate({'targetId':'staging','imageRepository':'ghcr.io/blossomsai/menoteam-work-map'},request,state)
print(json.dumps({'answer':answer,'calls':calls,'current':state['current']}))
`);
    expect((result.answer as Record<string, unknown>).phase).toBe('rolled_back');
    expect((result.current as Record<string, unknown>).id).toBe('deploy_previous');
    expect(JSON.stringify(result.calls)).toContain('sha256:');
  });

  it('does not permit rolling back to an unverified deployment', async () => {
    const result = await simulate(`
import importlib.util,importlib.machinery,json,sys,tempfile,pathlib
spec=importlib.util.spec_from_loader('stage',importlib.machinery.SourceFileLoader('stage',sys.argv[1]));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.STATE=pathlib.Path(tempfile.mkdtemp())/'state.json'
request={'action':'rollback','operationId':'run_11111111-2222-3333-4444-555555555555','targetId':'staging','commitSha':'a'*40,'imageDigest':'sha256:'+'b'*64,'previousDeploymentId':'deploy_previous','expectedCurrentDeploymentId':None}
try:m.operate({'targetId':'staging','imageRepository':'ghcr.io/blossomsai/menoteam-work-map'},request,{'deployments':{'deploy_previous':{'id':'deploy_previous','commitSha':'a'*40,'imageDigest':request['imageDigest'],'healthPassed':False}},'operations':{}})
except ValueError as e:print(json.dumps({'error':str(e)}))
`);
    expect(result.error).toContain('health-passed');
  });

  it('reconciles an uncertain operation only from the exact running image identity', async () => {
    const result = await simulate(`
import importlib.util,importlib.machinery,json,sys,hashlib,tempfile,pathlib
spec=importlib.util.spec_from_loader('stage',importlib.machinery.SourceFileLoader('stage',sys.argv[1]));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.STATE=pathlib.Path(tempfile.mkdtemp())/'state.json'
original={'action':'deploy','operationId':'run_11111111-2222-3333-4444-555555555555','targetId':'staging','commitSha':'a'*40,'imageDigest':'sha256:'+'b'*64,'expectedCurrentDeploymentId':None}
status={**original,'action':'status'};m.healthy=lambda image,commitSha: image.endswith(original['imageDigest']) and commitSha==original['commitSha'];m.image_schema_max=lambda image:'006_owner_provenance.sql'
digest=hashlib.sha256(json.dumps(original,sort_keys=True,separators=(',',':')).encode()).hexdigest()
state={'deployments':{},'operations':{original['operationId']:{'requestHash':digest,'pending':True,'request':original}}}
answer=m.operate({'targetId':'staging','imageRepository':'ghcr.io/blossomsai/menoteam-work-map'},status,state)
print(json.dumps({'answer':answer,'operation':state['operations'][original['operationId']]}))
`);
    expect((result.answer as Record<string, unknown>).phase).toBe('health_passed');
    expect((result.operation as Record<string, unknown>).pending).toBeUndefined();
  });

  it('blocks a new mutation while another operation remains unknown', async () => {
    const result = await simulate(`
import importlib.util,importlib.machinery,json,sys,hashlib,tempfile,pathlib
spec=importlib.util.spec_from_loader('stage',importlib.machinery.SourceFileLoader('stage',sys.argv[1]));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.STATE=pathlib.Path(tempfile.mkdtemp())/'state.json'
old={'action':'deploy','operationId':'run_11111111-2222-3333-4444-555555555555','targetId':'staging','commitSha':'a'*40,'imageDigest':'sha256:'+'b'*64,'expectedCurrentDeploymentId':None}
new={**old,'operationId':'run_22222222-2222-3333-4444-555555555555','commitSha':'c'*40,'imageDigest':'sha256:'+'d'*64}
digest=hashlib.sha256(json.dumps(old,sort_keys=True,separators=(',',':')).encode()).hexdigest()
state={'deployments':{},'operations':{old['operationId']:{'requestHash':digest,'pending':True,'request':old}}}
try:m.operate({'targetId':'staging','imageRepository':'ghcr.io/blossomsai/menoteam-work-map'},new,state)
except ValueError as error:print(json.dumps({'error':str(error)}))
`);
    expect(result.error).toContain('unknown');
  });

  it('fails closed on stale expected-current receipts and schema-incompatible rollback', async () => {
    const result = await simulate(`
import importlib.util,importlib.machinery,json,sys,tempfile,pathlib
spec=importlib.util.spec_from_loader('stage',importlib.machinery.SourceFileLoader('stage',sys.argv[1]));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.STATE=pathlib.Path(tempfile.mkdtemp())/'state.json'
calls=[];m.run_compose=lambda action,image=None,source=None:calls.append(action);m.image_schema_max=lambda image:'005_old.sql';m.database_schema_latest=lambda:'006_new.sql'
request={'action':'rollback','operationId':'run_11111111-2222-3333-4444-555555555555','targetId':'staging','commitSha':'a'*40,'imageDigest':'sha256:'+'b'*64,'previousDeploymentId':'deploy_previous','expectedCurrentDeploymentId':'deploy_current'}
state={'current':{'id':'deploy_current','commitSha':'c'*40,'imageDigest':'sha256:'+'d'*64,'healthPassed':True},'deployments':{'deploy_previous':{'id':'deploy_previous','commitSha':'a'*40,'imageDigest':request['imageDigest'],'healthPassed':True,'schemaMax':'005_old.sql'}},'operations':{}}
try:m.operate({'targetId':'staging','imageRepository':'ghcr.io/blossomsai/menoteam-work-map'}, {**request,'expectedCurrentDeploymentId':None},state)
except ValueError as e:stale=str(e)
answer=m.operate({'targetId':'staging','imageRepository':'ghcr.io/blossomsai/menoteam-work-map'},request,state)
print(json.dumps({'stale':stale,'answer':answer,'calls':calls,'current':state['current']}))
`);
    expect(result.stale).toContain('current deployment changed');
    expect((result.answer as Record<string, unknown>).phase).toBe('target_offline');
    expect(result.current).toBeNull();
    expect(JSON.stringify(result.calls)).not.toContain('up');
    expect(JSON.stringify(result.calls)).toContain('stop');
  });

  it('keeps a bootstrap operation unknown when no app container is currently running', async () => {
    const result = await simulate(`
import importlib.util,importlib.machinery,json,sys,hashlib,tempfile,pathlib
spec=importlib.util.spec_from_loader('stage',importlib.machinery.SourceFileLoader('stage',sys.argv[1]));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.STATE=pathlib.Path(tempfile.mkdtemp())/'state.json'
request={'action':'deploy','operationId':'run_11111111-2222-3333-4444-555555555555','targetId':'staging','commitSha':'a'*40,'imageDigest':'sha256:'+'b'*64,'expectedCurrentDeploymentId':None}
status={**request,'action':'status'};digest=hashlib.sha256(json.dumps(request,sort_keys=True,separators=(',',':')).encode()).hexdigest()
state={'deployments':{},'operations':{request['operationId']:{'requestHash':digest,'pending':True,'request':request}}};m.healthy=lambda image,commitSha:False;m.staging_container_id=lambda:''
answer=m.operate({'targetId':'staging','imageRepository':'ghcr.io/blossomsai/menoteam-work-map'},status,state)
print(json.dumps({'answer':answer,'operation':state['operations'][request['operationId']]}))
`);
    expect((result.answer as Record<string, unknown>).phase).toBe('unknown');
    expect((result.operation as Record<string, unknown>).pending).toBe(true);
  });

  it('keeps a pending deployment unknown while the previous image is still healthy', async () => {
    const result = await simulate(`
import importlib.util,importlib.machinery,json,sys,hashlib,tempfile,pathlib
spec=importlib.util.spec_from_loader('stage',importlib.machinery.SourceFileLoader('stage',sys.argv[1]));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.STATE=pathlib.Path(tempfile.mkdtemp())/'state.json'
original={'action':'deploy','operationId':'run_11111111-2222-3333-4444-555555555555','targetId':'staging','commitSha':'a'*40,'imageDigest':'sha256:'+'b'*64,'expectedCurrentDeploymentId':'deploy_current'}
status={**original,'action':'status'};m.healthy=lambda image,commitSha:image.endswith('sha256:'+'d'*64) and commitSha=='c'*40
digest=hashlib.sha256(json.dumps(original,sort_keys=True,separators=(',',':')).encode()).hexdigest()
current={'id':'deploy_current','commitSha':'c'*40,'imageDigest':'sha256:'+'d'*64,'healthPassed':True,'schemaMax':'006_owner_provenance.sql'}
state={'current':current,'deployments':{'deploy_current':current},'operations':{original['operationId']:{'requestHash':digest,'pending':True,'request':original}}}
answer=m.operate({'targetId':'staging','imageRepository':'ghcr.io/blossomsai/menoteam-work-map'},status,state)
new_request={'action':'deploy','operationId':'run_22222222-3333-4444-5555-666666666666','targetId':'staging','commitSha':'e'*40,'imageDigest':'sha256:'+'f'*64,'expectedCurrentDeploymentId':'deploy_current'}
try:m.operate({'targetId':'staging','imageRepository':'ghcr.io/blossomsai/menoteam-work-map'},new_request,state)
except ValueError as error:blocked=str(error)
print(json.dumps({'answer':answer,'operation':state['operations'][original['operationId']],'current':state['current'],'blocked':blocked}))
`);
    expect((result.answer as Record<string, unknown>).phase).toBe('unknown');
    expect((result.operation as Record<string, unknown>).pending).toBe(true);
    expect((result.current as Record<string, unknown>).id).toBe('deploy_current');
    expect(result.blocked).toContain('unknown');
  });

  it('does not report a pending rollback complete while the pre-rollback image is still active', async () => {
    const result = await simulate(`
import importlib.util,importlib.machinery,json,sys,hashlib,tempfile,pathlib
spec=importlib.util.spec_from_loader('stage',importlib.machinery.SourceFileLoader('stage',sys.argv[1]));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.STATE=pathlib.Path(tempfile.mkdtemp())/'state.json'
original={'action':'rollback','operationId':'run_11111111-2222-3333-4444-555555555555','targetId':'staging','commitSha':'a'*40,'imageDigest':'sha256:'+'b'*64,'previousDeploymentId':'deploy_previous','expectedCurrentDeploymentId':'deploy_current'}
status={**original,'action':'status'}
class Response:
 status=200
 def __enter__(self):return self
 def __exit__(self,*args):return False
m.running_image_identity=lambda:{'image':'ghcr.io/blossomsai/menoteam-work-map@sha256:'+'d'*64,'commitSha':'c'*40,'running':True,'health':'healthy'}
m.urllib.request.urlopen=lambda *args,**kwargs:Response()
digest=hashlib.sha256(json.dumps(original,sort_keys=True,separators=(',',':')).encode()).hexdigest()
current={'id':'deploy_current','commitSha':'c'*40,'imageDigest':'sha256:'+'d'*64,'healthPassed':True,'schemaMax':'006_owner_provenance.sql'}
previous={'id':'deploy_previous','commitSha':'a'*40,'imageDigest':original['imageDigest'],'healthPassed':True,'schemaMax':'006_owner_provenance.sql'}
state={'current':current,'deployments':{'deploy_current':current,'deploy_previous':previous},'operations':{original['operationId']:{'requestHash':digest,'pending':True,'request':original}}}
answer=m.operate({'targetId':'staging','imageRepository':'ghcr.io/blossomsai/menoteam-work-map'},status,state)
print(json.dumps({'answer':answer,'operation':state['operations'][original['operationId']],'current':state['current']}))
`);
    expect((result.answer as Record<string, unknown>).phase).toBe('unknown');
    expect((result.operation as Record<string, unknown>).pending).toBe(true);
    expect((result.current as Record<string, unknown>).id).toBe('deploy_current');
  });

  it('reconciles a pending rollback only when the exact saved target image is active', async () => {
    const result = await simulate(`
import importlib.util,importlib.machinery,json,sys,hashlib,tempfile,pathlib
spec=importlib.util.spec_from_loader('stage',importlib.machinery.SourceFileLoader('stage',sys.argv[1]));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.STATE=pathlib.Path(tempfile.mkdtemp())/'state.json'
original={'action':'rollback','operationId':'run_11111111-2222-3333-4444-555555555555','targetId':'staging','commitSha':'a'*40,'imageDigest':'sha256:'+'b'*64,'previousDeploymentId':'deploy_previous','expectedCurrentDeploymentId':'deploy_current'}
status={**original,'action':'status'}
class Response:
 status=200
 def __enter__(self):return self
 def __exit__(self,*args):return False
m.running_image_identity=lambda:{'image':'ghcr.io/blossomsai/menoteam-work-map@'+original['imageDigest'],'commitSha':original['commitSha'],'running':True,'health':'healthy'}
m.urllib.request.urlopen=lambda *args,**kwargs:Response()
digest=hashlib.sha256(json.dumps(original,sort_keys=True,separators=(',',':')).encode()).hexdigest()
current={'id':'deploy_current','commitSha':'c'*40,'imageDigest':'sha256:'+'d'*64,'healthPassed':True,'schemaMax':'006_owner_provenance.sql'}
previous={'id':'deploy_previous','commitSha':original['commitSha'],'imageDigest':original['imageDigest'],'healthPassed':True,'schemaMax':'006_owner_provenance.sql'}
state={'current':current,'deployments':{'deploy_current':current,'deploy_previous':previous},'operations':{original['operationId']:{'requestHash':digest,'pending':True,'request':original}}}
answer=m.operate({'targetId':'staging','imageRepository':'ghcr.io/blossomsai/menoteam-work-map'},status,state)
print(json.dumps({'answer':answer,'operation':state['operations'][original['operationId']],'current':state['current']}))
`);
    expect((result.answer as Record<string, unknown>).phase).toBe('rolled_back');
    expect((result.answer as Record<string, unknown>).activeImageDigest).toBe('sha256:' + 'b'.repeat(64));
    expect((result.current as Record<string, unknown>).id).toBe('deploy_previous');
    expect((result.operation as Record<string, unknown>).pending).toBeUndefined();
  });
});
