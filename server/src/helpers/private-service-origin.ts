export function privateServiceOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      url.hostname.endsWith('.svc.cluster.local') &&
      url.href === `${url.origin}/`
      ? url.origin
      : null;
  } catch {
    return null;
  }
}
