import {test,expect} from 'bun:test';
import {createSecretBox} from './secrets';
const key=()=>Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
test('envelope round trip, Unicode, empty payload, random ciphertext',async()=>{
  const box=await createSecretBox(`v1:${key()}`);
  for(const plaintext of ['','token-secret-ñ-📅']){
    const a=await box.encrypt(plaintext,'tenant:a/account:1');
    const b=await box.encrypt(plaintext,'tenant:a/account:1');
    expect(a).not.toEqual(b);expect((await box.decrypt(a,'tenant:a/account:1')).plaintext).toEqual(plaintext);
    expect((await box.decrypt(a,'tenant:a/account:1')).rotatedCiphertext).toBeNull();
  }
});
test('context and ciphertext authentication reject swaps/tampering',async()=>{
  const box=await createSecretBox(`v1:${key()}`);const encrypted=await box.encrypt('secret','a');
  await expect(box.decrypt(encrypted,'b')).rejects.toThrow();
  const parts=encrypted.split('.');const data=parts[5];if(!data)throw new Error('missing fixture');parts[5]=(data.startsWith('A')?'B':'A')+data.slice(1);
  await expect(box.decrypt(parts.join('.'),'a')).rejects.toThrow();
});
test('lazy master-key rotation and retiring the old key',async()=>{
  const v1=key(),v2=key();const old=await createSecretBox(`v1:${v1}`);
  const encrypted=await old.encrypt('provider-refresh-token','tenant:1');
  const rotating=await createSecretBox(`v2:${v2},v1:${v1}`);const opened=await rotating.decrypt(encrypted,'tenant:1');
  expect(opened.plaintext).toBe('provider-refresh-token');expect(opened.rotatedCiphertext).toStartWith('sc1.v2.');
  const retired=await createSecretBox(`v2:${v2}`);
  await expect(retired.decrypt(encrypted,'tenant:1')).rejects.toThrow('Unknown master key');
  expect((await retired.decrypt(opened.rotatedCiphertext??'','tenant:1')).plaintext).toBe('provider-refresh-token');
});
test('reject malformed key rings',async()=>{
  for(const value of ['',`v1:${key()},v1:${key()}`,'v1:AAAA','v1:not base64'])await expect(createSecretBox(value)).rejects.toThrow();
});
