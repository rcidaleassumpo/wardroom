import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const BASE_ARGS = [
  "-c", "project_doc_max_bytes=0",
  "-c", "project_doc_fallback_filenames=[]",
  "-c", "skills.include_instructions=false",
  "-c", "features.plugins=false",
  "-c", "features.apps=false",
  "-c", "features.hooks=false",
  "-c", "features.memories=false",
  "-c", "features.skill_search=false",
  "-c", "features.skill_mcp_dependency_install=false",
  "-c", "features.multi_agent=false",
  "-c", "agents.enabled=false",
  "-c", "notify=[]",
  "-c", "mcp_servers.computer-use.enabled=false",
  "-c", "mcp_servers.node_repl.enabled=false",
  "-c", "mcp_servers.changebench.enabled=false",
  "-c", "mcp_servers.gitagent.enabled=false",
  "-c", "mcp_servers.linear.enabled=false",
] as const;

export interface CodexSkill { name: string; path: string }

/** Rooms-owned minimal Codex profile selected by the `--naked` launch flag. */
export function applyCodexNakedProfile(args: readonly string[], homeDirectory = homedir()): string[] {
  const requested: string[] = [];
  const forwarded: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--skill") {
      const name = args[index + 1];
      if (!name || name.startsWith("--")) throw new Error("codex --naked: --skill requires a skill name");
      requested.push(name);
      index += 1;
    } else if (value.startsWith("--skill=")) {
      const name = value.slice("--skill=".length);
      if (!name) throw new Error("codex --naked: --skill requires a skill name");
      requested.push(name);
    } else {
      forwarded.push(value);
    }
  }
  const skillArgs = requested.length > 0 ? selectedSkillArguments(requested, homeDirectory) : [];
  return [...BASE_ARGS, ...skillArgs, ...forwarded];
}

export function listCodexSkills(homeDirectory = homedir()): CodexSkill[] {
  const roots = [join(homeDirectory, ".agents", "skills"), join(homeDirectory, ".codex", "skills"), join(homeDirectory, ".codex", "plugins")];
  const paths = roots.flatMap(root => skillFiles(root)).sort();
  return paths.map(path => ({ name: skillName(path), path })).filter((item): item is CodexSkill => Boolean(item.name));
}

function selectedSkillArguments(requested: readonly string[], homeDirectory: string): string[] {
  const skills = listCodexSkills(homeDirectory);
  const selected = new Set<string>();
  for (const requestedName of requested) {
    const matches = skills.filter(skill => skill.name === requestedName || basename(dirname(skill.path)) === requestedName);
    if (matches.length === 0) throw new Error(`codex --naked: unknown skill: ${requestedName}`);
    if (matches.length > 1) throw new Error(`codex --naked: ambiguous skill: ${requestedName}\n${matches.map(item => item.path).join("\n")}`);
    selected.add(matches[0]!.path);
  }
  const disabled = skills.filter(skill => !selected.has(skill.path)).map(skill => `{path=${JSON.stringify(skill.path)},enabled=false}`);
  return ["-c", "skills.include_instructions=true", "-c", `skills.config=[${disabled.join(",")}]`];
}

function skillFiles(root: string): string[] {
  const result: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile() && entry.name === "SKILL.md") result.push(path);
      }
    } catch { /* optional skill roots may not exist */ }
  }
  return result;
}

function skillName(path: string): string {
  try {
    const frontmatter = readFileSync(path, "utf8").slice(0, 16_384);
    const match = frontmatter.match(/^---\s*$[\s\S]*?^name:\s*["']?([^\n"']+)["']?\s*$/m);
    return match?.[1]?.trim() ?? "";
  } catch { return ""; }
}
