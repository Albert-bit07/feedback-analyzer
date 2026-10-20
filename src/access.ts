/** Shared analyst credentials protect this single-team prototype, including reporter data. */
export async function authorize(request: Request, password?: string): Promise<Response | null> {
  const headers = { 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Basic realm="Feedback triage", charset="UTF-8"' };
  if (!password) return new Response('Configure DASHBOARD_PASSWORD before serving feedback', { status: 503, headers });
  let supplied = '';
  try {
    const value = request.headers.get('Authorization') ?? '';
    if (value.startsWith('Basic ')) supplied = atob(value.slice(6));
  } catch { /* Malformed credentials are treated as an authentication failure. */ }
  const encoder = new TextEncoder();
  const [actual, expected] = await Promise.all([supplied, `analyst:${password}`].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const a = new Uint8Array(actual), b = new Uint8Array(expected);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  if (difference !== 0) return new Response('Authentication required', { status: 401, headers });
  const origin = request.headers.get('Origin');
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    return new Response('Cross-site requests are not allowed', { status: 403, headers });
  }
  return null;
}
