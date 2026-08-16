// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";

const PROVIDERS = new Set(["codex", "claude", "grok", "gemini"]);

export async function runRoomsProvider(provider: string, args: readonly string[], envOverrides: Readonly<Record<string, string>> = {}, scrubEnv: readonly string[] = []): Promise<number> {
  if (!PROVIDERS.has(provider)) throw new Error(`unsupported Rooms provider: ${provider}`);
  const nativeIndex = args.indexOf("--native");
  const forwarded = nativeIndex >= 0 ? [...args.slice(0, nativeIndex), ...args.slice(nativeIndex + 1)] : [...args];
  const sessionId = String(process.env.ROOMS_SESSION_ID || "").trim();
  if (!sessionId && nativeIndex < 0) throw new Error(`no Rooms session is active; create or join one first, or pass --native to run ${provider} directly`);
  const environment: Record<string, string | undefined> = { ...process.env, ...envOverrides, ROOMS_PROVIDER: provider };
  for (const name of scrubEnv) delete environment[name];
  return await new Promise((resolve, reject) => {
    const child = spawn(provider, forwarded, { stdio: "inherit", env: environment });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}
