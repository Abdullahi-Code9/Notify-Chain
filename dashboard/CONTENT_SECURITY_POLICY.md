# Content Security Policy (CSP) Configuration

## Overview
This document outlines the Content Security Policy implemented for the NotifyChain Dashboard to protect against script injection, content-loading attacks, and other security threats.

## Current CSP Configuration

The CSP is configured in `vite.config.ts` and applies to both development (`dev`) and production preview (`preview`) modes:

```typescript
'Content-Security-Policy': [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' http://localhost:8787 ws://localhost:8787",
  "media-src 'self'",
  "object-src 'none'",
  "frame-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "upgrade-insecure-requests",
].join('; ')
```

## Directive Breakdown

### Source Restrictions

1. **`default-src 'self'`**
   - Default fallback for all resource types
   - Restricts to same origin only

2. **`script-src 'self' 'unsafe-inline'`**
   - Allows scripts from same origin
   - `'unsafe-inline'` is required for Vite's development mode and React's inline scripts
   - **Production Recommendation**: Replace with hash-based nonces for better security

3. **`style-src 'self' 'unsafe-inline'`**
   - Allows styles from same origin
   - `'unsafe-inline'` is required for CSS-in-JS libraries and component styles

4. **`font-src 'self' data:`**
   - Allows fonts from same origin
   - `data:` protocol allowed for inline font data (e.g., base64 encoded fonts)

5. **`img-src 'self' data: blob:`**
   - Allows images from same origin
   - `data:` and `blob:` protocols allowed for inline images and canvas-generated content

6. **`connect-src 'self' http://localhost:8787 ws://localhost:8787`**
   - Allows fetch/XHR connections to same origin
   - Allows WebSocket and HTTP connections to local API server (port 8787)
   - **Environment Configuration**: API URL is configurable via `VITE_EVENTS_API_URL` environment variable

7. **`media-src 'self'`**
   - Allows audio/video from same origin only

8. **`object-src 'none'`**
   - Blocks all plugin content (Flash, Java applets, etc.)
   - Critical for preventing Flash-based attacks

9. **`frame-src 'self'`**
   - Allows iframes from same origin only

10. **`base-uri 'self'`**
    - Restricts `<base>` tag URLs to same origin
    - Prevents base tag injection attacks

11. **`form-action 'self'`**
    - Restricts form submissions to same origin
    - Prevents form data exfiltration

12. **`frame-ancestors 'self'`**
    - Restricts embedding to same origin
    - Provides clickjacking protection (redundant with `X-Frame-Options: SAMEORIGIN`)

13. **`upgrade-insecure-requests`**
    - Automatically upgrades HTTP requests to HTTPS
    - Protects against mixed content issues

## Third-Party Integrations

### Allowed External Resources

1. **Stellar Wallet SDK** (`@creit.tech/stellar-wallets-kit`, `@stellar/stellar-sdk`)
   - These are bundled dependencies, not loaded from CDN
   - No external script sources required

2. **API Endpoints**
   - Local development: `http://localhost:8787`
   - Production: Configurable via `VITE_EVENTS_API_URL` environment variable
   - WebSocket connections for real-time updates

### Blocked Resources
- All external CDN resources (fonts, scripts, styles)
- External iframes and embeds
- Plugin content (Flash, Java, Silverlight)
- Cross-origin form submissions
- External media resources

## Development vs Production Considerations

### Development Mode
- `'unsafe-inline'` is required for Vite's hot module replacement
- Local API server connections are explicitly allowed
- WebSocket connections enabled for live reload

### Production Deployment
1. **Remove `'unsafe-inline'` directives**
   - Implement hash-based nonces for scripts
   - Use CSP-compatible CSS-in-JS solutions
   - Consider extracting critical CSS

2. **Update API URLs**
   - Configure `VITE_EVENTS_API_URL` for production API endpoint
   - Update CSP `connect-src` directive accordingly

3. **Additional Security Headers**
   ```typescript
   // Recommended for production
   'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
   'X-XSS-Protection': '1; mode=block',
   'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
   ```

## Testing and Verification

### Testing CSP Compliance
1. **Browser Developer Tools**
   - Check Console for CSP violation reports
   - Network tab shows blocked resources

2. **CSP Evaluation Tools**
   - Use online CSP validators
   - Test with CSP evaluator browser extensions

3. **Violation Reporting** (Optional)
   ```typescript
   // Add to CSP header for violation reporting
   "report-uri /api/csp-violation-report"
   "report-to default"
   ```

### Common Issues and Solutions

1. **Inline Script Violations**
   - **Issue**: React components generating inline scripts
   - **Solution**: Use `nonce` attributes or hash-based CSP

2. **Style Violations**
   - **Issue**: CSS-in-JS libraries injecting styles
   - **Solution**: Configure libraries for CSP compliance or use `'unsafe-inline'`

3. **External Resource Violations**
   - **Issue**: Attempting to load fonts/images from CDN
   - **Solution**: Bundle all assets locally or update CSP directives

## Monitoring and Maintenance

### Regular Updates
1. Review CSP directives quarterly
2. Update when adding new third-party integrations
3. Test after major dependency updates

### Security Audits
1. Use CSP audit tools regularly
2. Monitor violation reports
3. Review browser console warnings

### Deployment Checklist
- [ ] Update API URLs in CSP for production
- [ ] Test CSP in staging environment
- [ ] Verify all dashboard functionality works
- [ ] Check for CSP violations in browser console
- [ ] Update documentation for new integrations

## References
- [MDN Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
- [CSP Level 3 Specification](https://www.w3.org/TR/CSP3/)
- [Google CSP Evaluator](https://csp-evaluator.withgoogle.com/)
- [Vite Security Headers Documentation](https://vitejs.dev/config/server-options.html#server-headers)