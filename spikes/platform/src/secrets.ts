const encoder=new TextEncoder();
const decoder=new TextDecoder('utf-8',{fatal:true});
const encode=(value:Uint8Array)=>Buffer.from(value).toString('base64url');
function decode(value:string){
  if(!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('Invalid base64url ciphertext');
  return new Uint8Array(Buffer.from(value,'base64url'));
}
export async function createSecretBox(setting=process.env.SUPERCAL_KEYS??'') {
  const entries=setting.split(',').map(entry=>{
    const match=/^([A-Za-z0-9_-]+):([A-Za-z0-9+/]+={0,2})$/.exec(entry.trim());
    if(!match?.[1]||!match[2]) throw new Error('SUPERCAL_KEYS must be version:base64 entries');
    const raw=new Uint8Array(Buffer.from(match[2],'base64'));
    if(raw.length!==32) throw new Error('Master keys must be 32 bytes');
    return {version:match[1],raw};
  });
  const first=entries[0];if(!first) throw new Error('No active master key');
  const activeVersion=first.version;
  if(new Set(entries.map(e=>e.version)).size!==entries.length) throw new Error('Duplicate key version');
  const keys=new Map(await Promise.all(entries.map(async({version,raw})=>[version,await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt'])] as const)));
  function aad(version:string,context:string){return encoder.encode(JSON.stringify(['supercal','sc1',version,context]));}
  async function encrypt(plaintext:string,context:string){
    const master=keys.get(activeVersion);if(!master)throw new Error('Missing active master key');
    const rawDEK=crypto.getRandomValues(new Uint8Array(32));
    const dek=await crypto.subtle.importKey('raw',rawDEK,'AES-GCM',false,['encrypt','decrypt']);
    const iv=crypto.getRandomValues(new Uint8Array(12)),wrapIv=crypto.getRandomValues(new Uint8Array(12));
    const additionalData=aad(activeVersion,context);
    const data=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData},dek,encoder.encode(plaintext)));
    const wrapped=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:wrapIv,additionalData},master,rawDEK));
    rawDEK.fill(0);
    return ['sc1',activeVersion,encode(wrapIv),encode(wrapped),encode(iv),encode(data)].join('.');
  }
  async function decrypt(ciphertext:string,context:string){
    const [format,version,wrappedIv,wrapped,iv,data,...extra]=ciphertext.split('.');
    if(format!=='sc1'||!version||!wrappedIv||!wrapped||!iv||!data||extra.length)throw new Error('Invalid ciphertext format');
    const master=keys.get(version);if(!master)throw new Error(`Unknown master key version ${version}`);
    const additionalData=aad(version,context);
    const rawDEK=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(wrappedIv),additionalData},master,decode(wrapped));
    const dek=await crypto.subtle.importKey('raw',rawDEK,'AES-GCM',false,['decrypt']);
    new Uint8Array(rawDEK).fill(0);
    const plaintext=decoder.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(iv),additionalData},dek,decode(data)));
    return {plaintext,rotatedCiphertext:version===activeVersion?null:await encrypt(plaintext,context)};
  }
  return {encrypt,decrypt,activeVersion};
}
