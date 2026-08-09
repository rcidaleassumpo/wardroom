import { spawn } from "node:child_process";

const PROVIDERS = new Set(["codex", "claude", "grok"]);

export async function runRoomsProvider(provider: string, args: readonly string[]): Promise<number> {
  if (!PROVIDERS.has(provider)) throw new Error(`unsupported Rooms provider: ${provider}`);
  const nativeIndex = args.indexOf("--native");
  const forwarded = nativeIndex >= 0 ? [...args.slice(0, nativeIndex), ...args.slice(nativeIndex + 1)] : [...args];
  const sessionId = String(process.env.ROOMS_SESSION_ID || "").trim();
  if (!sessionId && nativeIndex < 0) throw new Error(`no Rooms session is active; create or join one first, or pass --native to run ${provider} directly`);
  return await new Promise((resolve, reject) => {
    const child = spawn(provider, forwarded, { stdio: "inherit", env: { ...process.env, ROOMS_PROVIDER: provider } });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}
