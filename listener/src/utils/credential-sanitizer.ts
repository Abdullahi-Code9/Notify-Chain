/**
 * Sanitizes URLs, tokens, and error messages so secrets and webhook credentials
 * are never exposed in logs or diagnostic health endpoints.
 */
export function sanitizeCredentials(input: string | undefined | null): string {
  if (!input) return '';

  return (
    input
      // Redact Discord webhook token: /api/webhooks/<id>/<token> -> /api/webhooks/<id>/***
      .replace(/(https?:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/)[^/\s?#]+/gi, '$1***')
      // Redact Slack webhook token: /services/T.../B.../<token> -> /services/T.../B.../***
      .replace(/(https?:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/)[^/\s?#]+/gi, '$1***')
      // Redact Basic Auth: http://user:pass@host -> http://***:***@host
      .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1***:***@')
      // Redact sensitive query parameters: ?key=..., &token=..., etc.
      .replace(/([?&](?:token|key|secret|api_key|webhook|auth)=)[^&\s]+/gi, '$1***')
      // Redact Bearer tokens in headers or strings
      .replace(/(bearer\s+)[a-zA-Z0-9_\-\.]{8,}/gi, '$1***')
  );
}