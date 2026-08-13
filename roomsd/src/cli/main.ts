#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { CommitMessageInput, ListMessagesInput, ListRepliesInput, RoomsCLIBackend, SendPromptInput, SessionCreateInput, SessionRegisterInput, ShowMessageInput } from "./backend.js";
import { createDefaultRoomsCLIBackend } from "./default-backend.js";
import { runRoomsSetup } from "./setup.js";
import { runInteractiveRuntimeAttach } from "./runtime-attach.js";
import { drainRuntimeOutput, waitForProviderReady } from "./runtime-drain.js";
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
import { launchPermissionArguments, parseLaunchPermissionMode } from "./launch-permissions.js";
import { applyCodexNakedProfile, listCodexSkills } from "./codex-minimal-profile.js";
import { discoverProviders, inspectProvider, listRegisteredProviders, providerName, registerProvider, registeredProvider, removeProvider, updateProvider, type ProviderRegistrationInput, type RoomsProvider } from "./provider-registry.js";
import { providerLaunchArguments, providerLaunchOptionsSchema, type ProviderLaunchOptions } from "./provider-launch-options.js";
import { runRoomsService, type RoomsServiceCommand } from "../provisioning/launchd.js";
import { formatRoomsVersion } from "../provisioning/version.js";
import { runRoomsMcpStdio } from "../mcp/stdio.js";

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
    return formatRoomsVersion(VERSION);
  }

  const parsed = argv[0] === "run" && argv[1] ? parseProviderInvocation(argv) : parse(argv);
  const [scope, command, name] = parsed.positionals;
  if (scope === "setup" && (command === undefined || command === "status")) {
    return formatResult(runRoomsSetup(command === "status" ? "status" : "setup", parsed.flags.get("state-dir")));
  }
  if (scope === "provider" && command) {
    const stateDir = parsed.flags.get("state-dir");
    if (command === "discover") return formatResult(discoverProviders(stateDir));
    if (command === "list") return formatResult({ providers: listRegisteredProviders(stateDir).map(describeProvider) });
    if (command === "inspect" && name) return formatResult(describeProvider(inspectProvider(providerName(name), stateDir)));
    if (command === "register" && name) return formatResult(registerProvider(providerName(name), providerRegistrationInput(parsed.flags), stateDir));
    if (command === "update" && name) return formatResult(updateProvider(providerName(name), providerRegistrationInput(parsed.flags), stateDir));
    if ((command === "remove" || command === "unregister") && name) return formatResult(removeProvider(providerName(name), stateDir));
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
  if (scope === "install") return formatResult(runRoomsInstall(required(parsed.flags, "release-dir"), { ...provisioningOptions(parsed.flags), allowIdentityChange: parsed.flags.get("allow-identity-change") === "true" }));
  if (scope === "upgrade") return formatResult(runRoomsUpgrade(required(parsed.flags, "release-dir"), { ...provisioningOptions(parsed.flags), allowIdentityChange: parsed.flags.get("allow-identity-change") === "true" }));
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
    else result = await runRoomsSession(providerName(command), parsed.positionals.slice(2), resolvedBackend, parsed.flags);
  } else if (scope === "shellenv") {
    const shellCommand = command ?? "print";
    if (!["install", "uninstall", "status", "print"].includes(shellCommand)) throw new Error(`unknown shellenv command\n\n${usage()}`);
    result = roomsShellenv(shellCommand as "install" | "uninstall" | "status" | "print", parsed.flags.get("shell") ?? "zsh", parsed.flags.get("state-dir"));
  } else if (scope === "briefing") {
    result = composeRoomsAgentBriefing({ sessionId: required(parsed.flags, "session"), channel: required(parsed.flags, "channel"), goal: parsed.flags.get("goal") ?? "", peers: parsed.flags.get("peers")?.split(",").filter(Boolean) });
  } else if (scope === "mcp" && command === "serve" && name === undefined) {
    runRoomsMcpStdio(resolvedBackend);
    return "";
  } else if (scope === "channel" && command === "members" && name) {
    if (!resolvedBackend.channelMembers) throw new Error("channel roster support is unavailable");
    result = await resolvedBackend.channelMembers(name);
  } else if (scope === "channel" && command === "state" && name) {
    if (!resolvedBackend.channelStateSnapshots) throw new Error("channel state snapshot support is unavailable");
    result = await resolvedBackend.channelStateSnapshots([name]);
  } else if (scope === "channel" && command === "states") {
    if (!resolvedBackend.channelStateSnapshots) throw new Error("channel state snapshot support is unavailable");
    result = await resolvedBackend.channelStateSnapshots(jsonArray(required(parsed.flags, "channels-json")));
  } else if ((scope === "channel" || scope === "session") && command === "usage" && name) {
    if (!resolvedBackend.usageSeries) throw new Error("usage history support is unavailable");
    result = await resolvedBackend.usageSeries(scope, name, parsed.flags.get("window") ?? "1h", booleanFlag(parsed.flags, "collect"));
  } else if (scope === "channel" && command === "send" && name) {
    if (!resolvedBackend.channelSend) throw new Error("channel messaging support is unavailable");
    const replyToEventId = optionalReplyTo(parsed.flags);
    result = await resolvedBackend.channelSend({ channel: name, sender: process.env.ROOMS_SESSION_ID || "", body: required(parsed.flags, "body"), ...(replyToEventId ? { replyToEventId } : {}) });
  } else if (scope === "control" && command === "commit") {
    if (!resolvedBackend.commitControl) throw new Error("control commit support is unavailable");
    result = await resolvedBackend.commitControl({
      channel: parsed.flags.get("channel") ?? process.env.ROOMS_CHANNEL_ID ?? "",
      sender: process.env.ROOMS_SESSION_ID || "",
      kind: required(parsed.flags, "kind"),
      payload: JSON.parse(required(parsed.flags, "payload-json")),
      requestId: required(parsed.flags, "request-id"),
    });
  } else if (scope === "control" && command === "list") {
    if (!resolvedBackend.listControls) throw new Error("control list support is unavailable");
    result = await resolvedBackend.listControls({ channel: parsed.flags.get("channel") ?? process.env.ROOMS_CHANNEL_ID ?? "", sender: process.env.ROOMS_SESSION_ID || "", since: parsed.flags.get("since") ?? "0", limit: Number(parsed.flags.get("limit") ?? 100) });
  } else if ((scope === "session" || scope === "sessions") && command === "locate" && name) {
    const federation = await requireFederationModule("rooms session locate");
    result = await federation.locateSession(name, resolvedBackend, { stateDir: parsed.flags.get("state-dir"), includeEnded: booleanFlag(parsed.flags, "all") });
  } else if (scope === "session" && command === "send" && name) {
    if (!resolvedBackend.sessionSend) throw new Error("session messaging support is unavailable");
    try {
      const replyToEventId = optionalReplyTo(parsed.flags);
      result = await resolvedBackend.sessionSend({ target: name, sender: process.env.ROOMS_SESSION_ID || "", body: required(parsed.flags, "body"), ...(replyToEventId ? { replyToEventId } : {}) });
    } catch (error) {
      if (!name.startsWith("federation:") && isUnknownRecipient(error)) {
        throw new Error(`unknown Rooms recipient session "${name}" on this machine; run \`rooms session locate ${name}\` to search registered machines, then resend to the returned target`);
      }
      throw error;
    }
  } else if (scope === "session" && command === "end" && name) {
    if (!resolvedBackend.endSession) throw new Error("session lifecycle support is unavailable");
    const credential = required(parsed.flags, "credential");
    if (resolvedBackend.runtimeTerminateSession) {
      try { await resolvedBackend.runtimeTerminateSession(name, credential); }
      catch (error) { if (!(error instanceof Error) || !/has no active Rooms runtime/.test(error.message)) throw error; }
    }
    result = await resolvedBackend.endSession(name, credential);
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
  } else if (scope === "channel" && command === "policy" && name) {
    if (!resolvedBackend.setChannelBroadcastPolicy) throw new Error("channel policy support is unavailable");
    const policy = parsed.flags.get("broadcast");
    if (policy !== "all" && policy !== "privileged") throw new Error("rooms channel policy requires --broadcast all|privileged");
    result = await resolvedBackend.setChannelBroadcastPolicy(name, policy, parsed.flags.get("credential") ?? process.env.ROOMS_SESSION_ID ?? "");
  } else if (scope === "channel" && command === "status" && name) {
    result = await resolvedBackend.channelStatus(name);
  } else if (scope === "channel" && command === "suspend" && name) {
    result = await resolvedBackend.suspendChannel(name);
  } else if (scope === "channel" && command === "resume" && name) {
    result = await resolvedBackend.resumeChannel(name);
  } else if (scope === "channel" && command === "close" && name) {
    if (!resolvedBackend.closeChannel) throw new Error("channel closure support is unavailable");
    result = await resolvedBackend.closeChannel(name, parsed.flags.get("credential") ?? process.env.ROOMS_SESSION_ID ?? "");
  } else if (scope === "channel" && command === "archive" && name) {
    if (!resolvedBackend.archiveChannel) throw new Error("channel archive support is unavailable");
    result = await resolvedBackend.archiveChannel({
      channel: name,
      credential: parsed.flags.get("credential") ?? process.env.ROOMS_SESSION_ID ?? "",
      force: booleanFlag(parsed.flags, "force"),
    });
  } else if (scope === "thread" && command && name && ["show", "resolve", "reopen"].includes(command)) {
    const input = { eventId: name, channel: parsed.flags.get("channel") ?? null, credential: parsed.flags.get("credential") ?? process.env.ROOMS_SESSION_ID ?? "" };
    if (command === "show") {
      if (!resolvedBackend.threadLifecycle) throw new Error("thread lifecycle support is unavailable");
      result = await resolvedBackend.threadLifecycle(input);
    } else if (command === "resolve") {
      if (!resolvedBackend.resolveThread) throw new Error("thread lifecycle support is unavailable");
      result = await resolvedBackend.resolveThread(input);
    } else {
      if (!resolvedBackend.reopenThread) throw new Error("thread lifecycle support is unavailable");
      result = await resolvedBackend.reopenThread(input);
    }
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
    const providerArgs = parsed.flags.has("provider-args-json") ? jsonArray(required(parsed.flags, "provider-args-json")) : [];
    const options = launchOptions(parsed.flags);
    const registration = backend ? undefined : registeredProvider(agent, parsed.flags.get("state-dir"));
    const executable = resolvedBackend.providerExecutable?.(agent) ?? registration?.executable ?? agent;
    const adapter = registration?.adapter ?? (agent === "gemini" ? "agy" : agent);
    const translatedArgs = providerLaunchArguments(agent, adapter, options, registration?.defaults ?? {}, providerArgs);
    const input: SessionCreateInput = {
      credential: required(parsed.flags, "credential"),
      channel,
      name,
      agent,
      adapter,
      role,
      cwd: parsed.flags.get("cwd") ?? process.cwd(),
      prompt,
      command: [executable, ...translatedArgs],
    };
    let launched = false;
    try {
      if (!resolvedBackend.registerSession) throw new Error("session launch requires channel membership support");
      await resolvedBackend.registerSession({ channel, name: input.credential, role: "operator", externalId: null });
      result = await resolvedBackend.createSession(input);
      launched = true;
      const readiness = await awaitProviderReadiness(resolvedBackend, name, input.credential);
      // Prefix the first prompt with the Rooms session id so concurrent
      // same-cwd provider-thread discovery can claim only this launch's
      // transcript (ownershipMarker in create() matches this exact line).
      const launchPrompt = `You are a Rooms session ${name}.\n\n${prompt}`;
      const delivery = await deliverLaunchPrompt(
        resolvedBackend,
        { credential: input.credential, channel, session: name, prompt: launchPrompt },
        { timeoutMs: promptTimeoutMs(parsed.flags.get("prompt-timeout-ms")), verify: () => confirmProviderAccepted(resolvedBackend, name, input.credential, readiness?.cursor) },
      );
      result = { ...(result as Record<string, unknown>), promptDelivered: true, promptAccepted: delivery.verified, promptDeliveryAttempts: delivery.attempts, providerReady: readiness };
    } catch (error) {
      if (launched) {
        // Use the launch credential (operator or planner), not the worker session
        // id, so cleanup is authorized the same way create was (internal work item).
        try { await resolvedBackend.runtimeTerminateSession?.(name, input.credential); } catch { /* preserve the launch error */ }
        try { await resolvedBackend.endSession?.(name, input.credential); } catch { /* preserve the launch error */ }
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
    const deliveryFlag = parsed.flags.get("delivery");
    if (deliveryFlag !== undefined) {
      if (!["runtime", "log"].includes(deliveryFlag)) throw new Error("invalid --delivery: expected runtime or log");
      input.deliveryMode = deliveryFlag as "runtime" | "log";
    }
    if (!resolvedBackend.registerSession) throw new Error("session register is unavailable");
    result = await resolvedBackend.registerSession(input);
  } else if (scope === "session" && command === "role" && name) {
    const role = required(parsed.flags, "role") as "planner" | "worker" | "reviewer";
    if (!["planner", "worker", "reviewer"].includes(role)) throw new Error("invalid --role: expected planner, worker, or reviewer");
    if (!resolvedBackend.updateSessionRole) throw new Error("session role update is unavailable");
    result = await resolvedBackend.updateSessionRole({
      channel: required(parsed.flags, "channel"),
      sessionId: name,
      role,
      credential: parsed.flags.get("credential") ?? process.env.ROOMS_SESSION_ID ?? "",
    });
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
  } else if ((scope === "session" || scope === "sessions") && command === "observe" && name) {
    // Observation is what attach cannot do without a terminal: read the
    // provider's screen from a script, a supervisor, or a wedged-session
    // diagnosis. It never writes, so it cannot disturb what it inspects.
    if (!resolvedBackend.runtimeResolveSessionAttach || !resolvedBackend.runtimeAttachInteractive) throw new Error("session observation is unavailable");
    const input = await resolvedBackend.runtimeResolveSessionAttach(name, parsed.flags.get("credential") ?? name, "observe", parsed.flags.get("cursor"));
    result = await drainRuntimeOutput(input, resolvedBackend, {
      durationMs: positiveMs(parsed.flags.get("duration-ms"), "--duration-ms"),
      idleMs: positiveMs(parsed.flags.get("idle-ms"), "--idle-ms"),
      plain: booleanFlag(parsed.flags, "plain"),
    });
  } else if ((scope === "session" || scope === "sessions") && command === "terminate" && name) {
    if (!resolvedBackend.runtimeTerminateSession) throw new Error("session termination is unavailable");
    result = await resolvedBackend.runtimeTerminateSession(name, parsed.flags.get("credential") ?? name);
  } else if (scope === "message" && command === "commit") {
    const replyToEventId = optionalReplyTo(parsed.flags);
    const input: CommitMessageInput = {
      channel: parsed.flags.get("channel") ?? null,
      sender: required(parsed.flags, "sender"),
      body: required(parsed.flags, "body"),
      target: parsed.flags.get("target") ?? null,
      ...(replyToEventId ? { replyToEventId } : {}),
    };
    result = await resolvedBackend.commitMessage(input);
  } else if (scope === "message" && command === "list") {
    const replyToEventId = optionalReplyTo(parsed.flags);
    const input: ListMessagesInput = {
      session: required(parsed.flags, "session"),
      since: parsed.flags.get("since") ?? "0",
      channel: parsed.flags.get("channel") ?? null,
      limit: boundedLimit(parsed.flags.get("limit")),
      ...(replyToEventId ? { replyToEventId } : {}),
    };
    if (!resolvedBackend.listMessages) throw new Error("message list is unavailable");
    result = await resolvedBackend.listMessages(input);
  } else if (scope === "message" && command === "show" && name) {
    const input: ShowMessageInput = { eventId: name, channel: parsed.flags.get("channel") ?? null };
    if (!resolvedBackend.showMessage) throw new Error("message inspection is unavailable");
    result = await resolvedBackend.showMessage(input);
  } else if (scope === "message" && command === "replies" && name) {
    const input: ListRepliesInput = {
      eventId: name,
      session: parsed.flags.get("session"),
      since: parsed.flags.get("since") ?? "0",
      channel: parsed.flags.get("channel") ?? null,
      limit: boundedLimit(parsed.flags.get("limit")),
    };
    if (!resolvedBackend.listReplies) throw new Error("message reply query is unavailable");
    result = await resolvedBackend.listReplies(input);
  } else if (scope === "prompt" && command === "send") {
    const input: SendPromptInput = {
      credential: required(parsed.flags, "credential"),
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
  } else if (scope === "runtime" && command === "quota") {
    if (!resolvedBackend.runtimeQuotaGet || !resolvedBackend.runtimeQuotaSet || !resolvedBackend.runtimeQuotaReset) throw new Error("runtime quota support is unavailable");
    const action = name;
    if (action === "set") {
      const limit = Number(required(parsed.flags, "limit"));
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
      result = await resolvedBackend.runtimeQuotaSet(required(parsed.flags, "machine"), limit, required(parsed.flags, "credential"));
    } else if (action === "reset") {
      result = await resolvedBackend.runtimeQuotaReset(required(parsed.flags, "machine"), required(parsed.flags, "credential"));
    } else {
      if (action) throw new Error(`unknown runtime quota action "${action}"`);
      result = await resolvedBackend.runtimeQuotaGet(parsed.flags.get("machine"));
    }
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
  } else if (scope === "rotation" && command === "inspect") {
    if (!resolvedBackend.rotationInspect) throw new Error("rotation support is unavailable");
    result = await resolvedBackend.rotationInspect(required(parsed.flags, "channel"), required(parsed.flags, "session"), required(parsed.flags, "credential"));
  } else if (scope === "rotation" && command === "prepare") {
    if (!resolvedBackend.rotationPrepare) throw new Error("rotation support is unavailable");
    result = await resolvedBackend.rotationPrepare(required(parsed.flags, "channel"), required(parsed.flags, "session"), required(parsed.flags, "credential"));
  } else if (scope === "rotation" && command === "acknowledge") {
    if (!resolvedBackend.rotationAcknowledge) throw new Error("rotation support is unavailable");
    result = await resolvedBackend.rotationAcknowledge(required(parsed.flags, "rotation"), required(parsed.flags, "nonce"), required(parsed.flags, "credential"));
  } else if (scope === "rotation" && command === "commit") {
    if (!resolvedBackend.rotationCommit) throw new Error("rotation support is unavailable");
    result = await resolvedBackend.rotationCommit(required(parsed.flags, "rotation"), required(parsed.flags, "credential"));
  } else if (scope === "rotation" && command === "cancel") {
    if (!resolvedBackend.rotationCancel) throw new Error("rotation support is unavailable");
    result = await resolvedBackend.rotationCancel(required(parsed.flags, "rotation"), required(parsed.flags, "reason"), required(parsed.flags, "credential"));
  } else {
    throw new Error(`unknown command\n\n${usage()}`);
  }

  return formatResult(result);
}

function jsonValues(value: string): unknown[] { const parsed: unknown = JSON.parse(value); if (!Array.isArray(parsed)) throw new Error("expected a JSON array"); return parsed; }
function jsonArray(value: string): string[] { const parsed = jsonValues(value); if (!parsed.every((item) => typeof item === "string")) throw new Error("expected a JSON string array"); return parsed as string[]; }
function jsonObject(value: string): Record<string, unknown> { const parsed: unknown = JSON.parse(value); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object"); return parsed as Record<string, unknown>; }

function providerRegistrationInput(flags: Map<string, string>): ProviderRegistrationInput {
  return {
    ...(flags.has("executable") ? { executable: flags.get("executable") } : {}),
    ...(flags.has("adapter") ? { adapter: flags.get("adapter") } : {}),
    ...(flags.has("enabled") ? { enabled: booleanFlag(flags, "enabled") } : {}),
    ...(flags.has("defaults-json") ? { defaults: jsonObject(required(flags, "defaults-json")) as ProviderRegistrationInput["defaults"] } : {}),
  };
}

function describeProvider(registration: ReturnType<typeof inspectProvider>): unknown {
  return { ...registration, launchOptions: providerLaunchOptionsSchema(registration.name) };
}

function launchOptions(flags: Map<string, string>): ProviderLaunchOptions {
  const options = flags.has("provider-options-json") ? jsonObject(required(flags, "provider-options-json")) : {};
  if (flags.has("permissions")) options.permissions = parseLaunchPermissionMode(required(flags, "permissions"));
  if (flags.has("effort")) options.reasoningEffort = parseReasoningEffort(required(flags, "effort"));
  return options;
}

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
      if (token === "--reply-to" || token === "--reply-to-event") throw new Error(`${token} requires an event id`);
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
  const valueFlags = new Set(["credential", "channel", "name", "prompt", "cwd", "goal", "role", "effort", "permissions", "provider-options-json", "state-dir"]);
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

function optionalReplyTo(flags: ReadonlyMap<string, string>): string | undefined {
  const replyTo = flags.get("reply-to")?.trim();
  const replyToEvent = flags.get("reply-to-event")?.trim();
  if (flags.has("reply-to") && !replyTo) throw new Error("--reply-to requires an event id");
  if (flags.has("reply-to-event") && !replyToEvent) throw new Error("--reply-to-event requires an event id");
  if (replyTo && replyToEvent && replyTo !== replyToEvent) throw new Error("--reply-to and --reply-to-event must name the same event");
  return replyTo ?? replyToEvent;
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

function provisioningOptions(flags: Map<string, string>): { stateDir?: string; installRoot?: string } {
  return { stateDir: flags.get("state-dir"), installRoot: flags.get("install-root") };
}


function codexAgent(value: string): RoomsProvider { return providerName(value); }

async function runRoomsSession(provider: RoomsProvider, args: readonly string[], backend: RoomsCLIBackend, flags: Map<string, string>): Promise<string> {
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
  const registration = registeredProvider(provider, flags.get("state-dir"));
  const providerArgs = providerLaunchArguments(provider, registration.adapter, launchOptions(flags), registration.defaults, providerArguments(provider, args, flags));
  const executable = registration.executable;
  const command = providerLaunchCommand(provider, providerArgs, resumeThreadId, undefined, executable);
  await backend.createSession({ credential, channel, name: session, agent: provider, adapter: registration.adapter, cwd: flags.get("cwd") ?? process.cwd(), prompt, command, providerThreadId: resumeThreadId ?? null });
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
      credential,
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

export function providerResumeThreadId(provider: RoomsProvider, args: readonly string[]): string | undefined {
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

function providerArguments(_provider: RoomsProvider, args: readonly string[], _flags: Map<string, string>): string[] {
  const base = _provider === "codex" && _flags.get("naked") === "true" ? applyCodexNakedProfile(args) : [...args];
  return withReasoningEffort(_provider, base, _flags.get("effort"));
}

/**
 * An explicit --effort must override the provider's preset and global defaults,
 * so it is prepended. A caller who passed the provider's own effort flag keeps
 * theirs, and a provider that cannot honor it fails closed rather than silently
 * running at its default.
 */
export function withReasoningEffort(provider: RoomsProvider, args: readonly string[], requested: string | undefined): string[] {
  if (requested === undefined) return [...args];
  const effort: ReasoningEffort = parseReasoningEffort(requested);
  const forwarded = reasoningEffortArguments(provider, effort);
  if (argsAlreadySetReasoningEffort(provider, args)) return [...args];
  return [...forwarded, ...args];
}

/**
 * A freshly created runtime is not ready to receive the moment createSession
 * returns: the provider process still has to boot its TUI before Rooms can
 * write into it. The old launch slept a flat second and then reported
 * promptDelivered whatever happened, so a slow provider silently lost its first
 * prompt and the session sat idle forever (internal work item).
 *
 * Delivery is therefore attempted immediately and retried until Rooms has
 * evidence the runtime took the prompt, or the deadline passes and the launch
 * fails outright. A backend that reports no per-recipient status cannot be
 * second-guessed, so an unreported status counts as accepted; a reported one
 * that is not "delivered" does not.
 */
export async function deliverLaunchPrompt(
  backend: Pick<RoomsCLIBackend, "sendPrompt">,
  input: SendPromptInput,
  options: { timeoutMs?: number; sleep?: (ms: number) => Promise<void>; verify?: () => Promise<boolean> } = {},
): Promise<{ attempts: number; verified: boolean }> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  const backoffMs = [250, 500, 1_000, 2_000];
  let attempts = 0;
  let lastFailure = "the runtime never accepted the prompt";
  while (true) {
    attempts += 1;
    try {
      const status = promptDeliveryStatus(await backend.sendPrompt(input), input.session);
      if (status === undefined || status === "delivered") {
        if (!options.verify) return { attempts, verified: false };
        if (await options.verify()) return { attempts, verified: true };
        lastFailure = "the runtime took the prompt but the provider never acted on it";
      } else {
        lastFailure = `the runtime reported delivery status "${status}"`;
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    const wait = backoffMs[Math.min(attempts - 1, backoffMs.length - 1)]!;
    if (Date.now() + wait >= deadline) {
      throw new Error(`session ${input.session} launched but its first prompt was never delivered after ${attempts} attempts: ${lastFailure}`);
    }
    await sleep(wait);
  }
}

/**
 * Wait for the launched provider to finish drawing before writing its prompt.
 * A backend without observation support keeps the previous behavior rather than
 * failing the launch, which is what the CLI test doubles exercise.
 */
async function awaitProviderReadiness(backend: RoomsCLIBackend, session: string, credential: string): Promise<{ settled: boolean; byteCount: number; cursor: string } | null> {
  if (!backend.runtimeResolveSessionAttach || !backend.runtimeAttachInteractive) return null;
  return waitForProviderReady(await backend.runtimeResolveSessionAttach(session, credential, "observe"), backend);
}

/**
 * Provider acceptance, as distinct from runtime acceptance. Writing the prompt
 * into the PTY proves only that the bytes landed; a provider that took the
 * prompt starts working and its screen keeps changing, while one that dropped
 * it goes quiet. Near-silence after delivery is therefore the signal that the
 * prompt was written but never submitted.
 */
async function confirmProviderAccepted(backend: RoomsCLIBackend, session: string, credential: string, cursor: string | undefined): Promise<boolean> {
  if (!backend.runtimeResolveSessionAttach || !backend.runtimeAttachInteractive || cursor === undefined) return true;
  try {
    // Replaying from the pre-delivery cursor is the whole point: counting the
    // boot paint again would call every launch accepted.
    const input = await backend.runtimeResolveSessionAttach(session, credential, "observe", cursor);
    const drained = await drainRuntimeOutput(input, backend, { durationMs: 8_000, idleMs: 3_000, awaitFirstOutput: true, minBytes: PROVIDER_ACTIVITY_BYTES });
    return drained.byteCount >= PROVIDER_ACTIVITY_BYTES;
  } catch {
    return true; // an unobservable runtime is not evidence of a lost prompt
  }
}

/** Output a provider produces when it is actually working on a prompt. */
const PROVIDER_ACTIVITY_BYTES = 400;

/** A millisecond window flag, rejected rather than silently coerced. */
function positiveMs(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

/** How long a launch waits for the provider to boot far enough to take its prompt. */
function promptTimeoutMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("--prompt-timeout-ms must be a non-negative integer");
  return parsed;
}

/** The recipient's delivery status in a send result, when the backend reports one. */
function promptDeliveryStatus(result: unknown, session: string): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const event = (result as { event?: unknown }).event;
  const carrier = (event && typeof event === "object" ? event : result) as { recipientStatuses?: unknown };
  const statuses = carrier.recipientStatuses;
  if (!statuses || typeof statuses !== "object") return undefined;
  const status = (statuses as Record<string, unknown>)[session];
  return typeof status === "string" ? status : undefined;
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
    "  rooms skills install|uninstall|status|print [--provider codex|claude|grok|gemini] [--state-dir <absolute-path>]",
    "  rooms provider discover|list [--state-dir <absolute-path>]",
    "  rooms provider inspect <codex|claude|grok|gemini> [--state-dir <absolute-path>]",
    "  rooms provider register|update <codex|claude|grok|gemini> [--executable <absolute-path>] [--adapter <name>] [--enabled true|false] [--defaults-json <object>] [--state-dir <absolute-path>]",
    "  rooms provider remove <codex|claude|grok|gemini> [--state-dir <absolute-path>]",
    "  rooms machine list [--state-dir <absolute-path>]",
    "  rooms machine route <authority-id> --ssh-host <host> [--remote-state-dir <absolute-path>] [--state-dir <absolute-path>]",
    "  rooms machine route <authority-id> --remove [--state-dir <absolute-path>]",
    "  rooms machine inspect [authority-id] [--all] [--ssh-host <host>] [--state-dir <absolute-path>] [--remote-state-dir <absolute-path>]",
    "  rooms run <codex|claude|grok|gemini> [--native] [--provider-options-json <object>] [provider arguments...]",
    "  rooms briefing --session <session-id> --channel <channel> [--goal <text>] [--peers <id,...>]",
    "  rooms control commit --channel <channel> --kind <kind> --payload-json <json> --request-id <id>",
    "  rooms control list --channel <channel> [--since <cursor>] [--limit <count>]",
    "  rooms session usage <session-id> [--window 15m|1h|6h|24h|7d] [--collect true|false]",
    "  rooms channel usage <channel-id> [--window 15m|1h|6h|24h|7d] [--collect true|false]",
    "  rooms mcp serve",
    "  rooms setup [--state-dir <absolute-path>]",
    "  rooms setup status [--state-dir <absolute-path>]",
    "  rooms install --release-dir <absolute-path> [--state-dir <absolute-path>] [--install-root <absolute-path>] [--allow-identity-change]",
    "  rooms upgrade --release-dir <absolute-path> [--state-dir <absolute-path>] [--install-root <absolute-path>] [--allow-identity-change]",
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
    "  rooms federation channel direct-send --ssh-host <host> --peer-authority-id <channel-home-authority> --session <local-session> --target-session <home-session> --body <text> [--reply-to <event-id>]",
    "  rooms federation channel send --ssh-host <host> --peer-authority-id <channel-home-authority> --session <local-session> --channel <channel> --body <text> [--reply-to <event-id>]",
    "  rooms federation channel snapshot|messages|leave --ssh-host <host> --peer-authority-id <channel-home-authority> --session <local-session> --channel <channel> [--after-cursor <n>]",
    "  rooms federation capability issue --credential <token> --session <home-session> --peer-authority-id <audience> --out <path> [--mode observe|controller] [--ttl-seconds <n>] [--state-dir <path>]",
    "  rooms channel create <name> [--credential <operator-session-or-token>]",
    "  rooms channel list",
    "  rooms channel label <name> --label <text> [--credential <operator-session-or-token>]   (empty label clears)",
    "  rooms channel policy <name> --broadcast all|privileged [--credential <operator-session-or-token>]   (privileged: only operator and planner may broadcast)",
    "  rooms channel members <name>",
    "  rooms channel state <name>",
    "  rooms channel states --channels-json <json-array>",
    "  rooms channel send <name> --body <text> [--reply-to <event-id>]",
    "  rooms channel status <name>",
    "  rooms channel suspend <name>",
    "  rooms channel archive <name> [--credential <operator-session>] [--force]",
    "  rooms thread show|resolve|reopen <thread-root-event-id> [--channel <name>] [--credential <session>]",
    "  rooms channel resume <name>",
    "  rooms channel close <name> [--credential <operator-session-or-token>]",
    "  rooms session create --credential <token> --channel <name> --name <name> --agent codex --prompt <text> [--cwd <path>]",
    "  rooms session launch --credential <token> --channel <name> --name <name> --agent codex|claude|grok|gemini --role planner|worker|reviewer --prompt <text> [--cwd <path>] [--provider-options-json <object>] [--prompt-timeout-ms <n>] [--provider-args-json <json-array>]",
    "  rooms session register --channel <name> --name <name> [--role operator|planner|worker|reviewer] [--external-id <id>] [--delivery runtime|log]",
    "  rooms session role <session-id> --channel <name> --role planner|worker|reviewer --credential <operator-session-or-token>",
    "  rooms session attach <session-id> [--credential <token>] [--mode observe|controller] [--cursor <n>]",
    "  rooms session attach <remote-session-id> --ssh-host <host> --peer-authority-id <home-authority> --capability-file <path> [--mode observe|controller] [--cursor <n>]",
    "  rooms sessions attach <session-id> ...  (plural alias)",
    "  rooms session observe <session-id> [--credential <token>] [--cursor <n>] [--duration-ms <n>] [--idle-ms <n>] [--plain]",
    "  rooms session inspect <session-id>",
    "  rooms session list [--all]   (--all, --all true, or --all false)",
    "  rooms session locate <session-id> [--all] [--state-dir <absolute-path>]",
    "  rooms session send <session-id> --body <text> [--reply-to <event-id>]",
    "  rooms session end <session-id> --credential <operator-session-or-token>",
    "  rooms message commit --sender <session> --body <text> [--channel <name>] [--target <session>] [--reply-to <event-id>]",
    "  rooms message list --session <session> [--reply-to <event-id>] [--since <cursor>] [--limit <1-500>] [--channel <name>] [--json]",
    "  rooms message show <event-id> [--channel <name>] [--json]",
    "  rooms message replies <event-id> [--session <session>] [--since <cursor>] [--limit <1-500>] [--channel <name>] [--json]",
    "  rooms prompt send --credential <token> --channel <name> --session <session> --prompt <text>",
    "  rooms runtime create --credential <token> --session <session> [--runtime-id <id>] [--home-authority-id <id>] [--provider-thread-id <id>] [--shell <path>] [--state-dir <path>]",
    "  rooms runtime list|status|detach|events ... --credential <token>",
    "  rooms runtime quota [--machine <machine-id>]",
    "  rooms runtime quota set --machine <machine-id> --limit <n> --credential <operator-session-or-token>",
    "  rooms runtime quota reset --machine <machine-id> --credential <operator-session-or-token>",
    "  rooms runtime attach <runtime-id> --credential <token> --home-authority-id <id> --session <id> --generation <n> --viewer-id <id> [--mode observe|controller] [--cursor <n>]",
    "  rooms runtime input|resize|signal ... --credential <token> --attachment-id <id>",
    "  rooms runtime terminate|recover|deliver-message ... --credential <token>",
    "  rooms rotation inspect|prepare --channel <channel> --session <worker> --credential <planner>",
    "  rooms rotation acknowledge --rotation <id> --nonce <nonce> --credential <worker>",
    "  rooms rotation commit|cancel --rotation <id> --credential <planner> [--reason <text>]",
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
