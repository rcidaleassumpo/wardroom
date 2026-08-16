#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { get } from "node:https";
import { homedir } from "node:os";
import { arch, platform } from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const releaseNode = Object.freeze({
  version: "v22.23.2",
  archive: "node-v22.23.2-darwin-arm64.tar.gz",
  sha256: "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
});

const seaFuse = Buffer.from("NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:0");
const scriptDirectory = dirname(fileURLToPath(import.meta.url));

export function isReleaseNode(version, executable) {
  return version === releaseNode.version && readFileSync(executable).includes(seaFuse);
}

export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function main() {
  if (platform !== "darwin" || arch !== "arm64") {
    throw new Error("ROOMS_RELEASE_NODE001: release builds require native Apple Silicon macOS");
  }

  const builder = isReleaseNode(process.version, process.execPath)
    ? process.execPath
    : await installReleaseNode();
  execFileSync(builder, [join(scriptDirectory, "build-release.mjs")], {
    env: process.env,
    stdio: "inherit",
  });
}

async function installReleaseNode() {
  const cacheRoot = resolve(process.env.ROOMS_RELEASE_NODE_CACHE ?? join(homedir(), "Library", "Caches", "rooms", "release-node"));
  const installation = join(cacheRoot, releaseNode.version);
  const executable = join(installation, "bin", "node");
  if (existsSync(executable) && isReleaseNode(releaseNode.version, executable)) return executable;
  rmSync(installation, { recursive: true, force: true });

  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  const staging = join(cacheRoot, `.install-${randomUUID()}`);
  const archive = join(cacheRoot, `.download-${randomUUID()}.tar.gz`);
  try {
    await download(`https://nodejs.org/dist/${releaseNode.version}/${releaseNode.archive}`, archive);
    const actualChecksum = sha256(archive);
    if (actualChecksum !== releaseNode.sha256) {
      throw new Error(`ROOMS_RELEASE_NODE002: official Node archive checksum is ${actualChecksum}, expected ${releaseNode.sha256}`);
    }
    mkdirSync(staging, { mode: 0o700 });
    execFileSync("/usr/bin/tar", ["-xzf", archive, "--strip-components=1", "-C", staging], { stdio: "inherit" });
    if (!isReleaseNode(releaseNode.version, join(staging, "bin", "node"))) {
      throw new Error("ROOMS_RELEASE_NODE003: downloaded Node executable does not contain the SEA fuse");
    }
    if (existsSync(executable) && isReleaseNode(releaseNode.version, executable)) return executable;
    renameSync(staging, installation);
    return executable;
  } finally {
    rmSync(archive, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

function download(url, destination, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error("ROOMS_RELEASE_NODE004: too many redirects while downloading Node"));
  return new Promise((resolveDownload, reject) => {
    const request = get(url, response => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        download(new URL(response.headers.location, url).href, destination, redirects + 1).then(resolveDownload, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`ROOMS_RELEASE_NODE005: Node download returned HTTP ${response.statusCode ?? "unknown"}`));
        return;
      }
      const file = createWriteStream(destination, { flags: "wx", mode: 0o600 });
      response.pipe(file);
      file.on("finish", () => file.close(resolveDownload));
      file.on("error", reject);
    });
    request.on("error", reject);
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
