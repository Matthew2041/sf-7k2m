// Face ID / Touch ID unlock via a platform passkey with the WebAuthn PRF extension.
// The authenticator returns a secret that only the biometric can release; it wraps the vault key.
import { rand } from './crypto.js';

export const supported = () => !!(window.PublicKeyCredential && navigator.credentials?.create);

export async function evalPrf(credId, prfSalt) {
  const a = await navigator.credentials.get({ publicKey: {
    challenge: rand(32), allowCredentials: [{ type: 'public-key', id: credId }], userVerification: 'required',
    extensions: { prf: { eval: { first: prfSalt } } } } });
  const r = a.getClientExtensionResults().prf?.results?.first;
  if (!r) throw new Error('Face ID unlock is not supported on this device or browser.');
  return new Uint8Array(r);
}

export async function createPasskey() {
  const prfSalt = rand(32);
  const cred = await navigator.credentials.create({ publicKey: {
    rp: { name: 'Stuff Finder' },
    user: { id: rand(16), name: 'vault', displayName: 'Stuff Finder vault' },
    challenge: rand(32),
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'required' },
    extensions: { prf: { eval: { first: prfSalt } } } } });
  const ext = cred.getClientExtensionResults();
  if (!ext.prf?.enabled && !ext.prf?.results?.first) throw new Error('Face ID unlock is not supported on this device or browser.');
  const credId = new Uint8Array(cred.rawId);
  const prf = ext.prf.results?.first ? new Uint8Array(ext.prf.results.first) : await evalPrf(credId, prfSalt);
  return { credId, prfSalt, prf };
}
