const healthUrl = process.env.ROOMS_HEALTH_URL ?? "http://127.0.0.1:43170/healthz";

try {
  const response = await fetch(healthUrl, {
    signal: AbortSignal.timeout(Number(process.env.ROOMSD_HEALTH_TIMEOUT_MS ?? 2500)),
  });
  if (!response.ok) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
