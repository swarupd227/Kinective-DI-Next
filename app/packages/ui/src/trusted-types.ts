// Trusted Types default policy (spec 11.9: require-trusted-types-for 'script'). Our code never
// writes HTML; third-party libraries clear containers with innerHTML = '', which is the only
// HTML this policy lets through. Scripts and script URLs are always refused.
// Import this module first, before any library that touches the DOM.
import { setNonce } from 'get-nonce';

interface TrustedTypePolicyFactoryLike {
  createPolicy: (name: string, rules: { createHTML?: (s: string) => string | null; createScript?: () => null; createScriptURL?: () => null }) => unknown;
  defaultPolicy?: unknown;
}

const tt = (globalThis as { trustedTypes?: TrustedTypePolicyFactoryLike }).trustedTypes;

if (tt && !tt.defaultPolicy) {
  tt.createPolicy('default', {
    createHTML: (input) => {
      if (input === '') return input;
      console.warn('[trusted-types] blocked HTML write', input.slice(0, 80));
      return null;
    },
    createScript: () => null,
    createScriptURL: () => null,
  });
}

// Radix dialogs lock page scroll with a <style> tag (react-remove-scroll), which style-src 'self'
// blocks. When the host page carries a per-response nonce (<meta name="csp-nonce">, added by the
// production server), hand it to the style injector so the tag is allowed.
const nonce = typeof document !== 'undefined' ? document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content : undefined;
if (nonce) setNonce(nonce);
