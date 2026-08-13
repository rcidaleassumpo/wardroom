// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { discoverProviders, listRegisteredProviders, type RoomsProvider } from "./provider-registry.js";

const BEGIN = "# >>> rooms shellenv >>>";
const END = "# <<< rooms shellenv <<<";

export function roomsShellenv(command: "install" | "uninstall" | "status" | "print" = "print", shell = "zsh", stateDir?: string): unknown {
  if (shell !== "zsh") throw new Error(`Rooms shellenv currently supports zsh only (requested ${shell})`);
  const config = process.env.ROOMS_SHELL_CONFIG ?? join(homedir(), ".zshrc");
  const managed = process.env.ROOMS_SHELLENV_FILE ?? join(homedir(), ".config", "rooms", "shellenv.zsh");
  if (command === "print") return shellenvScript(listRegisteredProviders(stateDir).map(item => item.name));
  if (command === "status") {
    const text = readOptional(config);
    return { installed: text.includes(BEGIN) && text.includes(END), config, managed, providers: listRegisteredProviders(stateDir) };
  }
  if (command === "install") {
    const registry = discoverProviders(stateDir);
    mkdirSync(dirname(managed), { recursive: true, mode: 0o700 });
    writeFileSync(managed, shellenvScript(registry.providers.map(item => item.name)), { encoding: "utf8", mode: 0o600 });
    const current = readOptional(config);
    if (!current.includes(BEGIN)) {
      mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
      appendFileSync(config, `${current.endsWith("\n") || current.length === 0 ? "" : "\n"}${BEGIN}\nsource ${shellQuote(managed)}\n${END}\n`, { encoding: "utf8", mode: 0o600 });
    }
    return { installed: true, config, managed, providers: registry.providers };
  }
  const current = readOptional(config);
  const pattern = new RegExp(`\\n?${escapeRegExp(BEGIN)}\\n[\\s\\S]*?${escapeRegExp(END)}\\n?`, "g");
  writeFileSync(config, current.replace(pattern, ""), { encoding: "utf8", mode: 0o600 });
  try { unlinkSync(managed); } catch { /* already absent */ }
  return { uninstalled: true, config, managed };
}

export const shellenvScript = (providers: readonly RoomsProvider[] = []): string => `${BEGIN}\n# Managed by Rooms; edit with: rooms shellenv install|uninstall\n_rooms_provider() {\n  local provider="$1"; shift\n  local credential_args=()\n  if [[ -n "\${ROOMS_OPERATOR_CREDENTIAL:-}" ]]; then\n    credential_args=(--credential "$ROOMS_OPERATOR_CREDENTIAL")\n  elif [[ -n "\${ROOMS_SESSION_ID:-}" ]]; then\n    credential_args=(--credential "$ROOMS_SESSION_ID")\n  fi\n  rooms run "$provider" "\${credential_args[@]}" "$@"\n}\n${providers.map(provider => `${provider}() { _rooms_provider ${provider} "$@"; }`).join("\n")}\n${END}\n`;

function readOptional(path: string): string { try { return readFileSync(path, "utf8"); } catch { return ""; } }
function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&"); }
