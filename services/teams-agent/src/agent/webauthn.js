/**
 * Disable WebAuthn (passkeys / security keys) inside the agent's browser.
 *
 * Why: Microsoft's sign-in probes `window.PublicKeyCredential` and, when the
 * account has a passkey/FIDO factor, launches a NATIVE browser dialog (the QR
 * "use your phone" popup). That dialog is browser chrome, not page content —
 * it never appears in the remote screenshot stream, can't be clicked or typed
 * into through the page, and in headless mode doesn't exist at all, so the
 * login just hangs on "your device will open a security window".
 *
 * With WebAuthn hidden, Microsoft treats the browser as a plain one with no
 * passkey support and immediately offers the in-page alternatives instead
 * (password, authenticator code, email code) — all of which render in the page
 * and work fine through the remote screenshot/click/type stream.
 */

const DISABLE_WEBAUTHN_SCRIPT = `
(() => {
  try { delete window.PublicKeyCredential; } catch (e) {}
  if (typeof window.PublicKeyCredential !== 'undefined') {
    try { Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true }); } catch (e) {}
  }
  try { Object.defineProperty(Navigator.prototype, 'credentials', { get: () => undefined, configurable: true }); } catch (e) {}
})();
`;

/** Apply to a Playwright BrowserContext before any page loads. */
async function disableWebAuthn(context) {
  await context.addInitScript(DISABLE_WEBAUTHN_SCRIPT);
}

module.exports = { disableWebAuthn, DISABLE_WEBAUTHN_SCRIPT };
