import type { OAuthStateCodec, StatelessDcrClientStore } from '@arc-mcp/xsuaa-auth';
import type { RequestHandler } from 'express';

/**
 * IAS owns a separate consent and sealed-token protocol. The XSUAA callback in
 * xsuaa-auth 1.2.0 requires its own browser binding and emits a different code
 * format, so it cannot serve this IAS provider. Keep the existing IAS consent guard on this route.
 * This adapter preserves the existing IAS protocol; it is not the XSUAA fix.
 */
export function createIasOAuthCallbackHandler(
  stateCodec: OAuthStateCodec,
  clientStore: StatelessDcrClientStore,
  consentGuard: RequestHandler,
): RequestHandler {
  return (req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    consentGuard(req, res, (error?: unknown) => {
      if (error) {
        next(error);
        return;
      }
      void (async () => {
        const decoded = stateCodec.decode(typeof req.query.state === 'string' ? req.query.state : '');
        if (
          decoded.kind !== 'ok' ||
          !decoded.clientId ||
          (await clientStore.checkRedirectUri(decoded.clientId, decoded.clientRedirectUri)) !== 'ok'
        ) {
          res.status(400).send('Invalid or expired IAS sign-in. Restart from your MCP client.');
          return;
        }
        const target = new URL(decoded.clientRedirectUri);
        if (decoded.clientState !== undefined) target.searchParams.set('state', decoded.clientState);
        const errorCode = typeof req.query.error === 'string' ? req.query.error : '';
        if (errorCode) {
          if (target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) {
            res.status(400).send('IAS sign-in failed. Restart sign-in from your MCP client.');
            return;
          }
          target.searchParams.set('error', errorCode);
          if (typeof req.query.error_description === 'string')
            target.searchParams.set('error_description', req.query.error_description);
        } else {
          const code = typeof req.query.code === 'string' ? req.query.code : '';
          if (!code) {
            res.status(400).send('IAS did not return an authorization code.');
            return;
          }
          target.searchParams.set('code', code);
        }
        res.redirect(302, target.toString());
      })().catch(next);
    });
  };
}
