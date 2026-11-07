"""Run on hare after building the spike image; only creates/removes our own container."""
import json, os, subprocess, tempfile, time, urllib.request
name='supercal-spike-gnomon-platform'
image='supercal-spike-gnomon-platform'
base='http://localhost:55316'
def run(*args):
    return subprocess.check_output(args,text=True).strip()
def call(path, body=None, cookie=None):
    headers={'Origin':base}
    if body is not None: headers['Content-Type']='application/json'
    if cookie: headers['Cookie']=cookie
    request=urllib.request.Request(base+path,data=None if body is None else json.dumps(body).encode(),headers=headers)
    with urllib.request.urlopen(request,timeout=3) as response:
        return response.status, json.load(response), response.headers
start=time.monotonic()
container=run('docker','run','--detach','--rm','--name',name,'--network','host','-e','DATABASE_URL=postgres://supercal:spike@127.0.0.1:55432/spike_platform','-e','BASE_URL='+base,'-e','PORT=55316',image)
try:
    for _ in range(100):
        try:
            status,health,_=call('/health')
            break
        except Exception:
            time.sleep(.02)
    else: raise RuntimeError('container never became healthy')
    cold_ms=round((time.monotonic()-start)*1000)
    suffix=str(time.time_ns())
    signup,_,headers=call('/api/auth/sign-up/email',{'email':'docker-'+suffix+'@example.invalid','password':'docker-fixture-password-123','name':'Docker Gnomon'})
    cookie='; '.join(value.split(';')[0] for value in headers.get_all('Set-Cookie',[]))
    org,organization,_=call('/api/auth/organization/create',{'name':'Docker tenant','slug':'docker-'+suffix},cookie)
    active,_,_=call('/api/auth/organization/set-active',{'organizationId':organization['id']},cookie)
    protected,principal,_=call('/api/v1/principal',cookie=cookie)
    org_key,key,_=call('/api/auth/api-key/create',{'name':'Docker key','configId':'tenant','organizationId':organization['id']},cookie)
    image_info=json.loads(run('docker','image','inspect',image))[0]
    with tempfile.TemporaryDirectory(prefix='supercal-spike-gnomon-binary-') as directory:
        path=os.path.join(directory,'platform')
        run('docker','cp',container+':/app/platform',path)
        binary_size=os.stat(path).st_size
    print(json.dumps({'bun':health['bun'],'architecture':image_info['Architecture'],'imageBytes':image_info['Size'],'binaryBytes':binary_size,'runtimeUser':image_info['Config']['User'],'coldStartThroughHealthMs':cold_ms,'signup':signup,'organization':org,'activeOrganization':active,'protectedRoute':protected,'principalVia':principal['via'],'nativeOrgKeyCreate':org_key,'nativeOrgKeyBoundToTenant':key['referenceId']==organization['id'],'logs':run('docker','logs',container)},indent=2))
finally:
    run('docker','stop','--time','2',container)
