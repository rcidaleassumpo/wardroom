#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { CommitMessageInput, ListMessagesInput, RoomsCLIBackend, SendPromptInput, SessionCreateInput, SessionRegisterInput } from "./backend.js";
import { createDefaultRoomsCLIBackend } from "./default-backend.js";
import { runRoomsSetup } from "./setup.js";
import { runInteractiveRuntimeAttach } from "./runtime-attach.js";
import type { AuthorityId } from "../identity/authority.js";
import { loadFederationModule, requireFederationModule } from "../federation-loader.js";
import { runRoomsDoctor } from "../provisioning/doctor.js";
import { runRoomsInstall, runRoomsRollback, runRoomsUpgrade, runRoomsDrain } from "../provisioning/lifecycle.js";
import { composeRoomsAgentBriefing } from "./agent-briefing.js";
import { roomsShellenv } from "./shellenv.js";
import { roomsSkills, type RoomsSkillsCommand } from "./skills.js";
import { runRoomsProvider } from "./provider-run.js";
import { providerLaunchCommand } from "./codex-session-import.js";
import { argsAlreadySetReasoningEffort, parseReasoningEffort, reasoningEffortArguments, type ReasoningEffort } from "./reasoning-effort.js";
import { applyCodexNakedProfile, listCodexSkills } from "./codex-minimal-profile.js";
import { discoverProviders, listRegisteredProviders, providerName, registerProvider, registeredProviderExecutable, unregisterProvider, type RoomsProvider } from "./provider-registry.js";
import { runRoomsService, type RoomsServiceCommand } from "../provisioning/launchd.js";

const VERSION = "0.1.0";

/**
 * Rooms session identity is deliberately provider-neutral. Provider kind and
 * provider-native thread identity are stored as metadata, not encoded into
 * the session ID.
 */
export function createSessionId(): string {
  return `session-${randomUUID()}`;
}

type Parsed = {
  positionals: string[];
  flags: Map<string, string>;
};

export async function runRoomsCLI(argv: readonly string[], backend?: RoomsCLIBackend): Promise<string> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    if (await loadFederationModule()) return `${usage()}\n`;
    const federated = (line: string) => ["rooms federation ", "rooms machine ", "rooms session locate"].some((prefix) => line.trimStart().startsWith(prefix));
    return `${usage().split("\n").filter((line) => !federated(line)).join("\n")}\n`;
  }
  if (argv[0] === "--version" || argv[0] === "version") {
    return `rooms ${VERSION}\nrelease=${process.env.ROOMS_RELEASE_VERSION ?? "installed-or-source"}\n`;
  }

  const parsed = argv[0] === "run" && argv[1] ? parseProviderInvocation(argv) : parse(argv);
  const [scope, command, name] = parsed.positionals;
  if (scope === "setup" && (command === undefined || command === "status")) {
    return formatResult(runRoomsSetup(command === "status" ? "status" : "setup", parsed.flags.get("state-dir")));
  }
  if (scope === "provider" && command) {
    const stateDir = parsed.flags.get("state-dir");
    if (command === "discover") return formatResult(discoverProviders(stateDir));
    if (command === "list") return formatResult({ providers: listRegisteredProviders(stateDir) });
    if (command === "register" && name) return formatResult(registerProvider(providerName(name), parsed.flags.get("executable"), stateDir));
    if (command === "unregister" && name) return formatResult(unregisterProvider(providerName(name), stateDir));
    throw new Error(`unknown provider command\n\n${usage()}`);
  }
  if (scope === "skills") {
    const skillsCommand = command ?? "status";
    if (!["install", "uninstall", "status", "print"].includes(skillsCommand)) throw new Error(`unknown skills command\n\n${usage()}`);
    const selected = parsed.flags.get("provider");
    return formatResult(roomsSkills(skillsCommand as RoomsSkillsCommand, { provider: selected ? providerName(selected) : undefined, stateDir: parsed.flags.get("state-dir") }));
  }
  if (scope === "machine" && command === "list") return formatResult((await requireFederationModule("rooms machine list")).listMachines(parsed.flags.get("state-dir")));
  if (scope === "machine" && command === "route" && name) return formatResult((await requireFederationModule("rooms machine route")).configureMachineRoute(name as AuthorityId, parsed.flags));
  if (scope === "install") return formatResult(runRoomsInstall(parsed.flags.get("release-dir") ?? bundledReleaseDirectory(), provisioningOptions(parsed.flags)));
  if (scope === "upgrade") return formatResult(runRoomsUpgrade(parsed.flags.get("release-dir") ?? bundledReleaseDirectory(), provisioningOptions(parsed.flags)));
  if (scope === "rollback") return formatResult(runRoomsRollback(parsed.flags.get("version"), provisioningOptions(parsed.flags)));
  if (scope === "drain") return formatResult(runRoomsDrain(provisioningOptions(parsed.flags)));
  if (scope === "doctor") return formatResult(runRoomsDoctor(provisioningOptions(parsed.flags)));
  if (scope === "service") {
    const serviceCommand = command;
    if (!serviceCommand || !["install", "start", "stop", "restart", "status", "uninstall"].includes(serviceCommand)) throw new Error(`unknown service command\n\n${usage()}`);
    return formatResult(runRoomsService(serviceCommand as RoomsServiceCommand, provisioningOptions(parsed.flags)));
  }
  if (scope === "federation" && command === "peer" && name) {
    const federation = await requireFederationModule("rooms federation peer");
    if (!federation.FEDERATION_PEER_COMMANDS.includes(name)) throw new Error(`unknown federation peer command\n\n${usage()}`);
    return formatResult(await federation.runRoomsFederationPeerCommand(name, parsed.flags));
  }
  if (scope === "federation" && command === "enroll" && name) {
    const federation = await requireFederationModule("rooms federation enroll");
    if (!federation.FEDERATION_ENROLL_COMMANDS.includes(name)) throw new Error(`unknown federation enroll command\n\n${usage()}`);
    return formatResult(federation.runRoomsFederationEnrollCommand(name, parsed.flags));
  }
  if (scope === "federation" && command === "relay" && name) {
    const federation = await requireFederationModule("rooms federation relay");
    if (!federation.FEDERATION_RELAY_COMMANDS.includes(name)) throw new Error(`unknown federation relay command\n\n${usage()}`);
    await federation.runRoomsFederationRelayCommand(name, parsed.flags);
    return "";
  }
  if (scope === "federation" && command === "channel" && name) {
    const federation = await requireFederationModule("rooms federation channel");
    if (!federation.FEDERATION_CHANNEL_COMMANDS.includes(name)) throw new Error(`unknown federation channel command\n\n${usage()}`);
    return formatResult(await federation.runRoomsFederationChannelCommand(name, parsed.flags));
  }
  if (scope === "federation" && command === "capability" && name) {
    const federation = await requireFederationModule("rooms federation capability");
    if (!federation.FEDERATION_CAPABILITY_COMMANDS.includes(name)) throw new Error(`unknown federation capability command\n\n${usage()}`);
    return formatResult(federation.runRoomsFederationCapabilityCommand(name, parsed.flags));
  }
  const routedRemoteAttach = (scope === "session" || scope === "sessions") && command === "attach" && name
    ? parseFederatedSessionTarget(name)
    : undefined;
  if (routedRemoteAttach && !parsed.flags.has("ssh-host") && !parsed.flags.has("peer-authority-id")) {
    if (parsed.flags.has("json")) throw new Error("session attach is interactive and does not support --json");
    const federation = await requireFederationModule("remote session attach");
    const route = federation.readMachineRoute(routedRemoteAttach.authorityId, parsed.flags.get("local-state-dir"));
    if (!route?.sshHost) throw new Error(`no Rooms machine route for ${routedRemoteAttach.authorityId}`);
    await federation.runInteractiveRemoteRuntimeAttach({
      sessionId: routedRemoteAttach.sessionId,
      sshHost: route.sshHost,
      peerAuthorityId: routedRemoteAttach.authorityId,
      localStateDir: parsed.flags.get("local-state-dir"),
      remoteStateDir: route.remoteStateDir ?? undefined,
      mode: (parsed.flags.get("mode") ?? "controller") as "observe" | "controller",
      outputCursor: parsed.flags.get("cursor") ?? "0",
    });
    return "";
  }
  if ((scope === "session" || scope === "sessions") && command === "attach" && name && (parsed.flags.has("ssh-host") || parsed.flags.has("peer-authority-id"))) {
    if (parsed.flags.has("json")) throw new Error("session attach is interactive and does not support --json");
    const federation = await requireFederationModule("remote session attach");
    await federation.runInteractiveRemoteRuntimeAttach({ sessionId: name, sshHost: required(parsed.flags, "ssh-host"), peerAuthorityId: required(parsed.flags, "peer-authority-id") as AuthorityId, capabilityFile: required(parsed.flags, "capability-file"), localStateDir: parsed.flags.get("local-state-dir"), remoteStateDir: parsed.flags.get("remote-state-dir"), mode: (parsed.flags.get("mode") ?? "controller") as "observe" | "controller", outputCursor: parsed.flags.get("cursor") ?? "0" });
    return "";
  }
  const resolvedBackend = backend ?? await loadBackend();
  let result: unknown;

  if (scope === "whoami" || ((scope === "session" || scope === "sessions") && command === "whoami")) {
    if (!resolvedBackend.whoami) throw new Error("identity support is unavailable");
    result = await resolvedBackend.whoami();
  } else if (scope === "machine" && command === "inspect") {
    const federation = await requireFederationModule("rooms machine inspect");
    result = await federation.inspectMachine(name, resolvedBackend, { stateDir: parsed.flags.get("state-dir"), includeEnded: booleanFlag(parsed.flags, "all"), sshHost: parsed.flags.get("ssh-host"), remoteStateDir: parsed.flags.get("remote-state-dir") });
  } else if (scope === "run" && command) {
    if (command === "codex" && parsed.flags.has("naked") && parsed.positionals[2] === "list-skills") {
      result = { lines: listCodexSkills().map(skill => `${skill.name}\t${skill.path}`) };
    } else if (parsed.flags.has("native")) result = await runRoomsProvider(command, [...parsed.positionals.slice(2), "--native"]);
    else result = await runRoomsSession(command as "codex" | "claude" | "grok", parsed.positionals.slice(2), resolvedBackend, parsed.flags);
  } else if (scope === "terminal" && command === "open") {
    await runRoomsTerminal(resolvedBackend, parsed.flags);
    return "";
  } else if (scope === "shellenv") {
    const shellCommand = command ?? "print";
    if (!["install", "uninstall", "status", "print"].includes(shellCommand)) throw new Error(`unknown shellenv command\n\n${usage()}`);
    result = roomsShellenv(shellCommand as "install" | "uninstall" | "status" | "print", parsed.flags.get("shell") ?? "zsh", parsed.flags.get("state-dir"));
  } else if (scope === "briefing") {
    result = composeRoomsAgentBriefing({ sessionId: required(parsed.flags, "session"), channel: required(parsed.flags, "channel"), goal: parsed.flags.get("goal") ?? "", peers: parsed.flags.get("peers")?.split(",").filter(Boolean) });
  } else if (scope === "channel" && command === "members" && name) {
    if (!resolvedBackend.channelMembers) throw new Error("channel roster support is unavailable");
    result = await resolvedBackend.channelMembers(name);
  } else if (scope === "channel" && command === "send" && name) {
    if (!resolvedBackend.channelSend) throw new Error("channel messaging support is unavailable");
    result = await resolvedBackend.channelSend({ channel: name, sender: process.env.ROOMS_SESSION_ID || "", body: required(parsed.flags, "body") });
  } else if ((scope === "session" || scope === "sessions") && command === "locate" && name) {
    const federation = await requireFederationModule("rooms session locate");
    result = await federation.locateSession(name, resolvedBackend, { stateDir: parsed.flags.get("state-dir"), includeEnded: booleanFlag(parsed.flags, "all") });
  } else if (scope === "session" && command === "send" && name) {
    if (!resolvedBackend.sessionSend) throw new Error("session messaging support is unavailable");
    try {
      result = await resolvedBackend.sessionSend({ target: name, sender: process.env.ROOMS_SESSION_ID || "", body: required(parsed.flags, "body") });
    } catch (error) {
      if (!name.startsWith("federation:") && isUnknownRecipient(error)) {
        throw new Error(`unknown Rooms recipient session "${name}" on this machine; run \`rooms session locate ${name}\` to search registered machines, then resend to the returned target`);
      }
      throw error;
    }
  } else if (scope === "channel" && command === "create" && name) {
    // Rooms stores no channel goal, so accepting --goal here would discard it
    // silently and leave the caller believing it was recorded.
    if (parsed.flags.has("goal")) throw new Error("rooms channel create does not accept --goal: Rooms does not store a channel goal. Pass --goal to `rooms run`, which puts it in the launched agent's briefing.");
    result = await resolvedBackend.createChannel({ name, credential: parsed.flags.get("credential") });
  } else if (scope === "channel" && command === "list") {
    result = await resolvedBackend.listChannels();
  } else if (scope === "channel" && command === "label" && name) {
    if (!resolvedBackend.labelChannel) throw new Error("channel labeling support is unavailable");
    if (!parsed.flags.has("label")) throw new Error("rooms channel label requires --label <text>; pass an empty value to clear it");
    result = await resolvedBackend.labelChannel(
      name,
      normalizeChannelLabel(parsed.flags.get("label") ?? ""),
      parsed.flags.get("credential") ?? process.env.ROOMS_SESSION_ID ?? "",
    );
  } else if (scope === "channel" && command === "status" && name) {
    result = await resolvedBackend.channelStatus(name);
  } else if (scope === "channel" && command === "suspend" && name) {
    result = await resolvedBackend.suspendChannel(name);
  } else if (scope === "channel" && command === "resume" && name) {
    result = await resolvedBackend.resumeChannel(name);
  } else if (scope === "channel" && command === "close" && name) {
    if (!resolvedBackend.closeChannel) throw new Error("channel closure support is unavailable");
    result = await resolvedBackend.closeChannel(name, parsed.flags.get("credential") ?? process.env.ROOMS_SESSION_ID ?? "");
  } else if (scope === "session" && command === "create") {
    const input: SessionCreateInput = {
      credential: required(parsed.flags, "credential"),
      channel: required(parsed.flags, "channel"),
      name: required(parsed.flags, "name"),
      agent: codexAgent(required(parsed.flags, "agent")),
      cwd: parsed.flags.get("cwd") ?? process.cwd(),
      prompt: required(parsed.flags, "prompt"),
    };
    result = await resolvedBackend.createSession(input);
  } else if (scope === "session" && command === "launch") {
    const role = (parsed.flags.get("role") ?? "worker") as SessionCreateInput["role"];
    if (!role || !["planner", "worker", "reviewer"].includes(role)) throw new Error("session launch role must be planner, worker, or reviewer");
    const agent = codexAgent(required(parsed.flags, "agent"));
    const name = required(parsed.flags, "name");
    const channel = required(parsed.flags, "channel");
    const prompt = required(parsed.flags, "prompt");
    const input: SessionCreateInput = {
      credential: required(parsed.flags, "credential"),
      channel,
      name,
      agent,
      role,
      cwd: parsed.flags.get("cwd") ?? process.cwd(),
      prompt,
      command: [agent, ...withReasoningEffort(agent, parsed.flags.has("provider-args-json") ? jsonArray(required(parsed.flags, "provider-args-json")) : [], parsed.flags.get("effort"))],
    };
    let launched = false;
    try {
      result = await resolvedBackend.createSession(input);
      launched = true;
      await new Promise(resolve => setTimeout(resolve, 1_000));
      await resolvedBackend.sendPrompt({ channel, session: name, prompt });
      result = { ...(result as Record<string, unknown>), promptDelivered: true };
    } catch (error) {
      if (launched) {
        try { await resolvedBackend.runtimeTerminateSession?.(name, name); } catch { /* preserve the launch error */ }
        try { await resolvedBackend.endSession?.(name, name); } catch { /* preserve the launch error */ }
      }
      throw error;
    }
  } else if (scope === "session" && command === "register") {
    const input: SessionRegisterInput = {
      channel: required(parsed.flags, "channel"), name: required(parsed.flags, "name"),
      role: (parsed.flags.get("role") ?? "worker") as SessionRegisterInput["role"],
      externalId: parsed.flags.get("external-id") ?? null,
    };
    if (!["operator", "planner", "worker", "reviewer"].includes(input.role)) throw new Error("invalid --role");
    if (!resolvedBackend.registerSession) throw new Error("session register is unavailable");
    result = await resolvedBackend.registerSession(input);
  } else if (scope === "session" && command === "inspect" && name) {
    if (!resolvedBackend.inspectSession) throw new Error("session inspection is unavailable");
    result = await resolvedBackend.inspectSession(name);
  } else if (scope === "session" && command === "list") {
    if (!resolvedBackend.listSessions) throw new Error("session list is unavailable");
    result = await resolvedBackend.listSessions({ includeEnded: booleanFlag(parsed.flags, "all") });
  } else if ((scope === "session" || scope === "sessions") && command === "attach" && name) {
    if (parsed.flags.has("json")) throw new Error("session attach is interactive and does not support --json");
    if (!resolvedBackend.runtimeResolveSessionAttach || !resolvedBackend.runtimeAttachInteractive) throw new Error("interactive session attach is unavailable");
    const input = await resolvedBackend.runtimeResolveSessionAttach(name, parsed.flags.get("credential") ?? name, (parsed.flags.get("mode") ?? "controller") as "observe" | "controller", parsed.flags.get("cursor"));
    await runInteractiveRuntimeAttach(input, resolvedBackend);
    return "";
  } else if ((scope === "session" || scope === "sessions") && command === "terminate" && name) {
    if (!resolvedBackend.runtimeTerminateSession) throw new Error("session termination is unavailable");
    result = await resolvedBackend.runtimeTerminateSession(name, parsed.flags.get("credential") ?? name);
  } else if (scope === "message" && command === "commit") {
    const input: CommitMessageInput = {
      channel: parsed.flags.get("channel") ?? null,
      sender: required(parsed.flags, "sender"),
      body: required(parsed.flags, "body"),
      target: parsed.flags.get("target") ?? null,
    };
    result = await resolvedBackend.commitMessage(input);
  } else if (scope === "message" && command === "list") {
    const input: ListMessagesInput = {
      session: required(parsed.flags, "session"),
      since: parsed.flags.get("since") ?? "0",
      channel: parsed.flags.get("channel") ?? null,
      limit: boundedLimit(parsed.flags.get("limit")),
    };
    if (!resolvedBackend.listMessages) throw new Error("message list is unavailable");
    result = await resolvedBackend.listMessages(input);
  } else if (scope === "prompt" && command === "send") {
    const input: SendPromptInput = {
      channel: required(parsed.flags, "channel"),
      session: required(parsed.flags, "session"),
      prompt: required(parsed.flags, "prompt"),
    };
    result = await resolvedBackend.sendPrompt(input);
  } else if (scope === "runtime" && command === "create") {
    if (!resolvedBackend.runtimeCreate) throw new Error("runtime support is unavailable");
    result = await resolvedBackend.runtimeCreate({ credential: required(parsed.flags, "credential"), runtimeId: parsed.flags.get("runtime-id"), homeAuthorityId: parsed.flags.get("home-authority-id"), sessionId: required(parsed.flags, "session"), generation: parsed.flags.has("generation") ? Number(required(parsed.flags, "generation")) : undefined, machineId: parsed.flags.get("machine-id"), stateDir: parsed.flags.get("state-dir"), shell: parsed.flags.get("shell"), command: parsed.flags.has("command-json") ? jsonArray(required(parsed.flags, "command-json")) : undefined, cwd: parsed.flags.get("cwd"), channelId: parsed.flags.get("channel"), adapterKind: parsed.flags.get("adapter-kind"), providerThreadId: parsed.flags.get("provider-thread-id") ?? null });
  } else if (scope === "runtime" && command === "list") {
    if (!resolvedBackend.runtimeList) throw new Error("runtime support is unavailable");
    result = await resolvedBackend.runtimeList(required(parsed.flags, "credential"));
  } else if (scope === "runtime" && command === "status") {
    if (!resolvedBackend.runtimeStatus) throw new Error("runtime support is unavailable");
    result = await resolvedBackend.runtimeStatus(name ?? required(parsed.flags, "runtime-id"), required(parsed.flags, "credential"));
  } else if (scope === "runtime" && command === "attach") {
    if (parsed.flags.has("json")) throw new Error("runtime attach is interactive and does not support --json");
    const attachInput = { credential: required(parsed.flags, "credential"), runtimeId: name ?? required(parsed.flags, "runtime-id"), homeAuthorityId: required(parsed.flags, "home-authority-id"), sessionId: required(parsed.flags, "session"), generation: Number(required(parsed.flags, "generation")), viewerId: required(parsed.flags, "viewer-id"), mode: (parsed.flags.get("mode") ?? "observe") as "observe" | "controller", outputCursor: parsed.flags.get("cursor"), stateDir: parsed.flags.get("state-dir") };
    if (!resolvedBackend.runtimeAttachInteractive) throw new Error("interactive runtime attach is unavailable");
    await runInteractiveRuntimeAttach(attachInput, resolvedBackend);
    return "";
  } else if (scope === "runtime" && command === "detach") {
    if (!resolvedBackend.runtimeDetach) throw new Error("runtime support is unavailable");
    result = await resolvedBackend.runtimeDetach(name ?? required(parsed.flags, "attachment-id"), required(parsed.flags, "credential"));
  } else if (scope === "runtime" && command === "input") {
    if (!resolvedBackend.runtimeInput) throw new Error("runtime support is unavailable");
    result = await resolvedBackend.runtimeInput({ credential: required(parsed.flags, "credential"), attachmentId: required(parsed.flags, "attachment-id"), bytes: required(parsed.flags, "bytes") });
  } else if (scope === "runtime" && command === "resize") {
    if (!resolvedBackend.runtimeResize) throw new Error("runtime support is unavailable");
    result = await resolvedBackend.runtimeResize({ credential: required(parsed.flags, "credential"), attachmentId: required(parsed.flags, "attachment-id"), columns: Number(required(parsed.flags, "columns")), rows: Number(required(parsed.flags, "rows")) });
  } else if (scope === "runtime" && command === "signal") {
    if (!resolvedBackend.runtimeSignal) throw new Error("runtime support is unavailable");
    result = await resolvedBackend.runtimeSignal({ credential: required(parsed.flags, "credential"), attachmentId: required(parsed.flags, "attachment-id"), signal: required(parsed.flags, "signal") as "SIGHUP" | "SIGINT" | "SIGTERM" | "SIGWINCH" });
  } else if (scope === "runtime" && command === "terminate") {
    if (!resolvedBackend.runtimeTerminate) throw new Error("runtime support is unavailable");
    result = await resolvedBackend.runtimeTerminate({ credential: required(parsed.flags, "credential"), runtimeId: name ?? required(parsed.flags, "runtime-id"), generation: Number(required(parsed.flags, "generation")), attachmentId: parsed.flags.get("attachment-id") });
  } else if (scope === "runtime" && command === "recover") {
    if (!resolvedBackend.runtimeRecover) throw new Error("runtime support is unavailable");
    result = await resolvedBackend.runtimeRecover({ credential: required(parsed.flags, "credential"), runtimeId: name ?? required(parsed.flags, "runtime-id"), homeAuthorityId: required(parsed.flags, "home-authority-id"), sessionId: required(parsed.flags, "session"), generation: Number(required(parsed.flags, "generation")), viewerId: required(parsed.flags, "viewer-id"), mode: (parsed.flags.get("mode") ?? "observe") as "observe" | "controller", outputCursor: parsed.flags.get("cursor") });
  } else if (scope === "runtime" && command === "deliver-message") {
    if (!resolvedBackend.runtimeDeliverMessage) throw new Error("runtime support is unavailable");
    const frames = jsonArray(required(parsed.flags, "frames"));
    const delaysMs = jsonValues(required(parsed.flags, "delays-ms")).map(Number);
    result = await resolvedBackend.runtimeDeliverMessage({ credential: required(parsed.flags, "credential"), runtimeId: name ?? required(parsed.flags, "runtime-id"), generation: Number(required(parsed.flags, "generation")), messageId: required(parsed.flags, "message-id"), frames, delaysMs });
  } else if (scope === "runtime" && command === "events") {
    if (!resolvedBackend.runtimeEvents) throw new Error("runtime support is unavailable");
    result = await resolvedBackend.runtimeEvents(name ?? required(parsed.flags, "runtime-id"), Number(required(parsed.flags, "generation")), Number(parsed.flags.get("after") ?? "0"), required(parsed.flags, "credential"));
  } else {
    throw new Error(`unknown command\n\n${usage()}`);
  }

  return formatResult(result);
}

function jsonValues(value: string): unknown[] { const parsed: unknown = JSON.parse(value); if (!Array.isArray(parsed)) throw new Error("expected a JSON array"); return parsed; }
function jsonArray(value: string): string[] { const parsed = jsonValues(value); if (!parsed.every((item) => typeof item === "string")) throw new Error("expected a JSON string array"); return parsed as string[]; }

async function main(argv: readonly string[]): Promise<void> {
  process.stdout.write(await runRoomsCLI(argv));
}

async function loadBackend(): Promise<RoomsCLIBackend> {
  const modulePath = process.env.ROOMS_CLI_BACKEND_MODULE;
  if (!modulePath) return createDefaultRoomsCLIBackend();
  const loaded = await import(pathToFileURL(modulePath).href) as {
    default?: RoomsCLIBackend;
    backend?: RoomsCLIBackend;
  };
  const backend = loaded.default ?? loaded.backend;
  if (!backend) throw new Error(`backend module ${modulePath} must export default or backend`);
  return backend;
}

function parse(argv: readonly string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    if (equals > 2) {
      flags.set(token.slice(2, equals), token.slice(equals + 1));
      continue;
    }
    if (token === "--json" || token === "--native") {
      flags.set("json", "true");
      if (token === "--native") flags.set("native", "true");
      continue;
    }
    if (token === "--dangerously-skip-permissions") {
      flags.set("dangerously-skip-permissions", "true");
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      flags.set(token.slice(2), "true");
      continue;
    }
    flags.set(token.slice(2), value);
    index += 1;
  }
  return { positionals, flags };
}

/**
 * Parse only flags owned by Rooms and preserve the provider argv byte-for-byte
 * otherwise. Provider booleans such as `--yolo` must never consume a command
 * token such as `resume` merely because Rooms does not know their grammar.
 */
export function parseProviderInvocation(argv: readonly string[]): Parsed {
  const positionals = [argv[0]!, argv[1]!];
  const flags = new Map<string, string>();
  const valueFlags = new Set(["credential", "channel", "name", "prompt", "cwd", "goal", "role", "effort"]);
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index]!;
    // Everything after a bare `--` belongs to the provider verbatim, so a
    // provider flag that shares a Rooms flag name is not swallowed here.
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    const equals = token.startsWith("--") ? token.indexOf("=") : -1;
    const key = equals > 2 ? token.slice(2, equals) : token.startsWith("--") ? token.slice(2) : "";
    if (key === "native" || key === "naked") {
      flags.set(key, equals > 2 ? token.slice(equals + 1) : "true");
      continue;
    }
    if (valueFlags.has(key)) {
      if (equals > 2) {
        flags.set(key, token.slice(equals + 1));
        continue;
      }
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`--${key} requires a value`);
      flags.set(key, value);
      index += 1;
      continue;
    }
    positionals.push(token);
  }
  return { positionals, flags };
}

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

export const DEFAULT_MESSAGE_LIST_LIMIT = 50;

export function boundedLimit(value: string | undefined, fallback = DEFAULT_MESSAGE_LIST_LIMIT): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) throw new Error("--limit must be an integer between 1 and 500");
  return parsed;
}

/**
 * A documented `[--flag]` boolean accepts a bare flag or an explicit
 * true/false. Anything else is rejected rather than silently read as false,
 * which used to make `--all 1` return the filtered list with exit code 0.
 */
export function booleanFlag(flags: Map<string, string>, name: string): boolean {
  if (!flags.has(name)) return false;
  const value = flags.get(name);
  if (value === undefined || value === "" || value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${name} is a boolean flag; pass --${name}, --${name} true, or --${name} false`);
}

/** Resolve an npm or Homebrew bin symlink back to its complete Rooms release. */
export function bundledReleaseDirectory(executablePath = process.execPath): string {
  return dirname(realpathSync(executablePath));
}

function provisioningOptions(flags: Map<string, string>): { stateDir?: string; installRoot?: string } {
  return { stateDir: flags.get("state-dir"), installRoot: flags.get("install-root") };
}


function codexAgent(value: string): RoomsProvider { return providerName(value); }

async function runRoomsSession(provider: "codex" | "claude" | "grok", args: readonly string[], backend: RoomsCLIBackend, flags: Map<string, string>): Promise<string> {
  if (!backend.registerSession || !backend.createSession || !backend.runtimeResolveSessionAttach || !backend.runtimeAttachInteractive) throw new Error("Rooms interactive launch support is unavailable");
  let channel = flags.get("channel") ?? process.env.ROOMS_CHANNEL_ID;
  let credential = flags.get("credential") ?? process.env.ROOMS_OPERATOR_CREDENTIAL;
  if (!credential && backend.listSessions) {
    const listed = await backend.listSessions({ includeEnded: false }) as { sessions?: Array<{ id?: string; role?: string; endedAt?: string | null }> };
    credential = listed.sessions?.find((item) => item.role === "operator" && item.endedAt == null)?.id;
  }
  if (!credential) throw new Error("Rooms launch requires an active Rooms operator; set ROOMS_OPERATOR_CREDENTIAL or register an operator session");
  const resumeThreadId = providerResumeThreadId(provider, args);
  if (resumeThreadId && backend.runtimeResolveProviderAttach) {
    const existing = await backend.runtimeResolveProviderAttach(resumeThreadId, credential, "controller");
    if (existing) {
      const attached = await runInteractiveRuntimeAttach(existing, backend);
      if (attached.exited && backend.endSession) await backend.endSession(existing.sessionId, existing.sessionId);
      return "";
    }
  }
  const session = flags.get("name") ?? createSessionId();
  const prompt = roomsLaunchPrompt(flags);
  const goal = flags.get("goal") ?? prompt;
  let createdChannel = false;
  if (!channel) {
    if (!backend.createChannel) throw new Error("Rooms channel creation support is unavailable");
    channel = goal ? `rooms-${provider}-${process.pid}` : `rooms-${process.pid}`;
    await backend.createChannel({ name: channel, credential });
    createdChannel = true;
  }
  await backend.registerSession({ channel, name: session, role: (flags.get("role") ?? "worker") as "operator" | "planner" | "worker" | "reviewer", externalId: null });
  const providerArgs = providerArguments(provider, args, flags);
  const executable = registeredProviderExecutable(provider, flags.get("state-dir"));
  const command = providerLaunchCommand(provider, providerArgs, resumeThreadId, undefined, executable);
  await backend.createSession({ credential, channel, name: session, agent: provider, cwd: flags.get("cwd") ?? process.cwd(), prompt, command, providerThreadId: resumeThreadId ?? null });
  const briefingReadyAt = Date.now() + 1_000;
  const roster = backend.channelMembers
    ? await backend.channelMembers(channel, credential) as { members?: Array<{ sessionId?: string; id?: string; displayName?: string | null; name?: string | null }> }
    : { members: [] };
  const peers = (roster.members ?? []).map((member) => ({
    id: member.sessionId ?? member.id ?? "",
    name: member.displayName ?? member.name ?? null,
  })).filter((member) => member.id && member.id !== session);
  if (!resumeThreadId) {
    // The runtime host is ready before the provider TUI has installed its
    // input handler. Give a fresh provider a short bounded handoff. A resumed
    // provider may first present a native trust/authentication dialog, so
    // Rooms must not inject keystrokes until the operator has cleared it.
    const briefingDelay = briefingReadyAt - Date.now();
    if (briefingDelay > 0) await new Promise(resolve => setTimeout(resolve, briefingDelay));
    await backend.sendPrompt({
      channel,
      session,
      prompt: composeRoomsAgentBriefing({ sessionId: session, channel, goal, peers }),
    });
  }
  // Creation is operator-authorized, but the interactive controller belongs
  // to the newly registered provider session. This makes later recovery a
  // first-class `rooms session attach <session-id>` operation with no hidden
  // operator credential.
  const attach = await backend.runtimeResolveSessionAttach(session, session, "controller");
  const attached = await runInteractiveRuntimeAttach(attach, backend);
  if (attached.exited) {
    if (backend.endSession) await backend.endSession(session, session);
    if (createdChannel && backend.closeChannel) await backend.closeChannel(channel, credential);
  }
  return "";
}

/**
 * Create and attach one provider-free shell runtime. Detaching the CLI leaves
 * the session and runtime alive; a real shell exit ends the session and closes
 * a channel created by this invocation.
 */
async function runRoomsTerminal(backend: RoomsCLIBackend, flags: Map<string, string>): Promise<void> {
  if (!backend.registerSession || !backend.runtimeCreate || !backend.runtimeResolveSessionAttach || !backend.runtimeAttachInteractive) {
    throw new Error("Rooms terminal support is unavailable");
  }
  const channel = required(flags, "channel");
  const session = flags.get("name") ?? createSessionId();
  let credential = flags.get("credential") ?? process.env.ROOMS_OPERATOR_CREDENTIAL;
  if (!credential && backend.listSessions) {
    const listed = await backend.listSessions({ includeEnded: false }) as { sessions?: Array<{ id?: string; role?: string; endedAt?: string | null }> };
    credential = listed.sessions?.find((item) => item.role === "operator" && item.endedAt == null)?.id;
  }
  if (!credential) throw new Error("Rooms terminal creation requires an active Rooms operator; set ROOMS_OPERATOR_CREDENTIAL or register an operator session");

  const createChannel = booleanFlag(flags, "create-channel");
  let channelCreated = false;
  let sessionRegistered = false;
  let runtimeCreated = false;
  try {
    if (createChannel) {
      await backend.createChannel({ name: channel, credential });
      channelCreated = true;
    }
    await backend.registerSession({ channel, name: session, role: "operator", externalId: null });
    sessionRegistered = true;
    const shell = flags.get("shell") ?? process.env.SHELL ?? "/bin/sh";
    await backend.runtimeCreate({
      credential: session,
      sessionId: session,
      channelId: channel,
      shell,
      // A normal terminal starts a login shell so macOS path_helper and the
      // user's profile establish Homebrew and other interactive tooling.
      command: [shell, "-l"],
      cwd: flags.get("cwd") ?? process.cwd(),
      adapterKind: "shell",
      providerThreadId: null,
    });
    runtimeCreated = true;
  } catch (error) {
    if (runtimeCreated) {
      try { await backend.runtimeTerminateSession?.(session, session); } catch { /* preserve the creation error */ }
    }
    if (sessionRegistered) {
      try { await backend.endSession?.(session, session); } catch { /* preserve the creation error */ }
    }
    if (channelCreated) {
      try { await backend.closeChannel?.(channel, credential); } catch { /* preserve the creation error */ }
    }
    throw error;
  }

  const attach = await backend.runtimeResolveSessionAttach(session, session, "controller");
  const attached = await runInteractiveRuntimeAttach(attach, backend);
  if (!attached.exited) return;
  if (backend.endSession) await backend.endSession(session, session);
  if (channelCreated && backend.closeChannel) await backend.closeChannel(channel, credential);
}

export function providerResumeThreadId(provider: "codex" | "claude" | "grok", args: readonly string[]): string | undefined {
  if (provider === "claude") {
    const index = args.indexOf("--resume");
    const value = index >= 0 ? args[index + 1] : args.find(item => item.startsWith("--resume="))?.slice("--resume=".length);
    return value && !value.startsWith("-") ? value : undefined;
  }
  if (provider === "codex") {
    const index = args.indexOf("resume");
    const value = index >= 0 ? args[index + 1] : undefined;
    return value && !value.startsWith("-") ? value : undefined;
  }
  return undefined;
}

/** Rooms metadata comes only from Rooms flags, never opaque provider argv. */
export function roomsLaunchPrompt(flags: ReadonlyMap<string, string>): string {
  return flags.get("prompt") ?? flags.get("goal") ?? "";
}

function providerArguments(_provider: "codex" | "claude" | "grok", args: readonly string[], _flags: Map<string, string>): string[] {
  const base = _provider === "codex" && _flags.get("naked") === "true" ? applyCodexNakedProfile(args) : [...args];
  return withReasoningEffort(_provider, base, _flags.get("effort"));
}

/**
 * An explicit --effort must override the provider's preset and global defaults,
 * so it is prepended. A caller who passed the provider's own effort flag keeps
 * theirs, and a provider that cannot honor it fails closed rather than silently
 * running at its default.
 */
export function withReasoningEffort(provider: "codex" | "claude" | "grok", args: readonly string[], requested: string | undefined): string[] {
  if (requested === undefined) return [...args];
  const effort: ReasoningEffort = parseReasoningEffort(requested);
  const forwarded = reasoningEffortArguments(provider, effort);
  if (argsAlreadySetReasoningEffort(provider, args)) return [...args];
  return [...forwarded, ...args];
}

function formatResult(value: unknown): string {
  if (typeof value === "string") return `${value}\n`;
  if (value && typeof value === "object" && "lines" in value) {
    const lines = (value as { lines: unknown }).lines;
    if (Array.isArray(lines) && lines.every(line => typeof line === "string")) {
      return `${lines.join("\n")}\n`;
    }
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

function usage(): string {
  return [
    "Rooms checkpoint CLI",
    "",
    "Usage:",
    "  rooms whoami",
    "  rooms shellenv install|uninstall|status|print [--shell zsh]",
    "  rooms skills install|uninstall|status|print [--provider codex|claude|grok] [--state-dir <absolute-path>]",
    "  rooms provider discover|list [--state-dir <absolute-path>]",
    "  rooms provider register <codex|claude|grok> [--executable <absolute-path>] [--state-dir <absolute-path>]",
    "  rooms provider unregister <codex|claude|grok> [--state-dir <absolute-path>]",
    "  rooms machine list [--state-dir <absolute-path>]",
    "  rooms machine route <authority-id> --ssh-host <host> [--remote-state-dir <absolute-path>] [--state-dir <absolute-path>]",
    "  rooms machine route <authority-id> --remove [--state-dir <absolute-path>]",
    "  rooms machine inspect [authority-id] [--all] [--ssh-host <host>] [--state-dir <absolute-path>] [--remote-state-dir <absolute-path>]",
    "  rooms run <codex|claude|grok> [--native] [--effort low|medium|high] [provider arguments...]",
    "  rooms briefing --session <session-id> --channel <channel> [--goal <text>] [--peers <id,...>]",
    "  rooms setup [--state-dir <absolute-path>]",
    "  rooms setup status [--state-dir <absolute-path>]",
    "  rooms install [--release-dir <absolute-path>] [--state-dir <absolute-path>] [--install-root <absolute-path>]",
    "  rooms upgrade [--release-dir <absolute-path>] [--state-dir <absolute-path>] [--install-root <absolute-path>]",
    "  rooms rollback [--version <version>] [--state-dir <absolute-path>] [--install-root <absolute-path>]",
    "  rooms drain [--state-dir <absolute-path>] [--install-root <absolute-path>]",
    "  rooms doctor [--state-dir <absolute-path>] [--install-root <absolute-path>]",
    "  rooms service install|start|stop|restart|status|uninstall [--state-dir <absolute-path>] [--install-root <absolute-path>]",
    "  rooms federation peer prepare --authority-id <id> --public-key-file <path> --transport <json> [--state-dir <path>]",
    "  rooms federation peer revoke --authority-id <id> --reason <text> [--state-dir <path>]",
    "  rooms federation peer list [--state-dir <path>]",
    "  rooms federation peer show --authority-id <id> [--state-dir <path>]",
    "  rooms federation peer connect --transport ssh --ssh-host <alias-or-user@host> [--remote-state-dir <absolute>] [--local-state-dir <absolute>]",
    "  rooms federation enroll offer --peer-authority-id <id> --transport <json> --out <path> [--ttl-seconds <n>] [--state-dir <path>]",
    "  rooms federation enroll challenge --offer-file <path> --transport <json> --out <path> [--state-dir <path>]",
    "  rooms federation enroll accept --challenge-file <path> --out <path> [--state-dir <path>]",
    "  rooms federation enroll confirm --accept-file <path> --out <path> [--state-dir <path>]",
    "  rooms federation enroll finalize --confirm-file <path> [--state-dir <path>]",
    "  rooms federation enroll remote-step   (internal: stdin/stdout JSON framing for `peer connect --transport ssh`; not for manual operator use)",
    "  rooms federation relay serve-stdio   (internal fixed remote entry point invoked by `federation relay connect`; not for manual operator use)",
    "  rooms federation relay connect --ssh-host <alias-or-user@host> --peer-authority-id <id> [--remote-state-dir <absolute>] [--local-state-dir <absolute>] [--heartbeat-interval-ms <n>] [--idle-timeout-ms <n>] [--handshake-timeout-ms <n>] [--duration-ms <n>] [--echo-payload <text>]",
    "  rooms federation channel admit --credential <owner-session-or-token> --peer-authority-id <peer> --channel <channel> [--state-dir <path>]",
    "  rooms federation channel revoke-admission --credential <owner-session-or-token> --peer-authority-id <peer> --channel <channel> [--state-dir <path>]",
    "  rooms federation channel admissions --credential <owner-session-or-token> --channel <channel> [--state-dir <path>]",
    "  rooms federation channel register --ssh-host <host> --peer-authority-id <channel-home-authority> --session <local-session> --channel <channel>",
    "  rooms federation channel direct-send --ssh-host <host> --peer-authority-id <channel-home-authority> --session <local-session> --target-session <home-session> --body <text>",
    "  rooms federation channel send --ssh-host <host> --peer-authority-id <channel-home-authority> --session <local-session> --channel <channel> --body <text>",
    "  rooms federation channel snapshot|messages|leave --ssh-host <host> --peer-authority-id <channel-home-authority> --session <local-session> --channel <channel> [--after-cursor <n>]",
    "  rooms federation capability issue --credential <token> --session <home-session> --peer-authority-id <audience> --out <path> [--mode observe|controller] [--ttl-seconds <n>] [--state-dir <path>]",
    "  rooms channel create <name> [--credential <operator-session-or-token>]",
    "  rooms channel list",
    "  rooms channel label <name> --label <text> [--credential <operator-session-or-token>]   (empty label clears)",
    "  rooms channel members <name>",
    "  rooms channel send <name> --body <text>",
    "  rooms channel status <name>",
    "  rooms channel suspend <name>",
    "  rooms channel resume <name>",
    "  rooms channel close <name> [--credential <operator-session-or-token>]",
    "  rooms session create --credential <token> --channel <name> --name <name> --agent codex --prompt <text> [--cwd <path>]",
    "  rooms session launch --credential <token> --channel <name> --name <name> --agent codex|claude|grok --role planner|worker|reviewer --prompt <text> [--cwd <path>] [--effort low|medium|high] [--provider-args-json <json-array>]",
    "  rooms session register --channel <name> --name <name> [--role operator|planner|worker|reviewer] [--external-id <id>]",
    "  rooms session attach <session-id> [--credential <token>] [--mode observe|controller] [--cursor <n>]",
    "  rooms session attach federation:<home-authority>:<session-id> [--mode observe|controller] [--cursor <n>]",
    "  rooms session attach <remote-session-id> --ssh-host <host> --peer-authority-id <home-authority> --capability-file <path> [--mode observe|controller] [--cursor <n>]",
    "  rooms terminal open --channel <name> [--name <session-id>] [--create-channel] [--credential <operator-session-or-token>] [--shell <path>] [--cwd <path>]",
    "  rooms sessions attach <session-id> ...  (plural alias)",
    "  rooms session inspect <session-id>",
    "  rooms session list [--all]   (--all, --all true, or --all false)",
    "  rooms session locate <session-id> [--all] [--state-dir <absolute-path>]",
    "  rooms session send <session-id> --body <text>",
    "  rooms message commit --sender <session> --body <text> [--channel <name>] [--target <session>]",
    "  rooms message list --session <session> [--since <cursor>] [--limit <1-500>] [--channel <name>] [--json]",
    "  rooms prompt send --channel <name> --session <session> --prompt <text>",
    "  rooms runtime create --credential <token> --session <session> [--runtime-id <id>] [--home-authority-id <id>] [--provider-thread-id <id>] [--shell <path>] [--state-dir <path>]",
    "  rooms runtime list|status|detach|events ... --credential <token>",
    "  rooms runtime attach <runtime-id> --credential <token> --home-authority-id <id> --session <id> --generation <n> --viewer-id <id> [--mode observe|controller] [--cursor <n>]",
    "  rooms runtime input|resize|signal ... --credential <token> --attachment-id <id>",
    "  rooms runtime terminate|recover|deliver-message ... --credential <token>",
    "",
    "Environment:",
    "  ROOMS_CLI_BACKEND_MODULE  optional backend module override",
  ].join("\n");
}

function normalizeChannelLabel(input: string): string | null {
  const label = input.trim();
  if (label === "") return null;
  if (label.length > 200) throw new Error("channel label must be at most 200 characters");
  if (/\p{Cc}/u.test(label)) throw new Error("channel label must not contain control characters");
  return label;
}

function isUnknownRecipient(error: unknown): boolean {
  return error instanceof Error && /unknown Rooms recipient session/.test(error.message);
}

function parseFederatedSessionTarget(value: string): { authorityId: AuthorityId; sessionId: string } | undefined {
  const match = /^federation:(authority-[0-9a-f]{64}):(.+)$/.exec(value);
  if (!match) return undefined;
  return { authorityId: match[1] as AuthorityId, sessionId: match[2]! };
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (isDirectRun()) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`rooms: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
