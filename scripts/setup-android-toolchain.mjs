#!/usr/bin/env node
/**
 * setup-android-toolchain.mjs - installs what is needed to build the Android app, for your user only.
 * No administrator rights, nothing system-wide. Works on Windows, macOS and Linux with just Node.js.
 *
 *   node scripts/setup-android-toolchain.mjs --check                 report what is missing, change nothing
 *   node scripts/setup-android-toolchain.mjs --accept-licenses       install (after you have read the licences, see below)
 *   options: --dir <folder>   where to install (default: ~/.freefield-android)
 *            --own-jdk        always use the pinned JDK, ignoring any Java already installed
 *
 * Disk space: about 3 GB for the tools (JDK ~0.4 GB, Android SDK ~1.5 GB) plus ~2 GB for the first build's caches.
 * Downloads come from: github.com (Temurin JDK), dl.google.com (Android SDK), maven.google.com / repo.maven.apache.org /
 * services.gradle.org (the build itself later). Every download is verified against a pinned SHA-256.
 *
 * Licences: the Android SDK is under Google's terms (https://developer.android.com/studio/terms) and the
 * JDK under GPLv2 with Classpath Exception (Eclipse Temurin). --accept-licenses means you accepted them.
 *
 * Safe to run again: finished parts are skipped. Writes <dir>/toolchain.json (used by scripts/build-android.mjs),
 * apps/mobile/android/local.properties (sdk.dir; git-ignored) and prints the JAVA_HOME / ANDROID_HOME values.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { homedir, arch as osArch, platform as osPlatform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

export const ANDROID_PLATFORM = "android-35";
export const ANDROID_BUILD_TOOLS = "35.0.0";
const CMDLINE_VERSION = "11076708";
const JDK_RELEASE = "jdk-21.0.13.1+2";
const JDK_BASE = "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13.1%2B2/OpenJDK21U-jdk_";
const JDK_PINS = {
  "linux-x64": ["x64_linux_hotspot_21.0.13.1_2.tar.gz", "bb8a93f9ae6e7a693b2b721e85dbeff26ae1a77447985a8d7afcdd9c7cf6222e"],
  "linux-arm64": ["aarch64_linux_hotspot_21.0.13.1_2.tar.gz", "8c72816a6b308842d5ed1f13e5826b69c567da4784f7238d7e800efa71fe54b1"],
  "darwin-x64": ["x64_mac_hotspot_21.0.13.1_2.tar.gz", "1b5eff1741bb83d32e2e19aade71452bb42e40f047c01d3e178d438304c9a26d"],
  "darwin-arm64": ["aarch64_mac_hotspot_21.0.13.1_2.tar.gz", "48067f2b7c958ed104a9d8a5749be7d25220b0a356b4d2d1bcfaab3e16ad0b14"],
  "win32-x64": ["x64_windows_hotspot_21.0.13.1_2.zip", "bbebea1469996b276683c9299c227b294f85c847039c82633218186a4ad4fbf2"],
  "win32-arm64": ["x64_windows_hotspot_21.0.13.1_2.zip", "bbebea1469996b276683c9299c227b294f85c847039c82633218186a4ad4fbf2"], // runs under emulation
};
const CMDLINE_PINS = {
  linux: "2d2d50857e4eb553af5a6dc3ad507a17adf43d115264b1afc116f95c92e5e258",
  darwin: "7bc5c72ba0275c80a8f19684fb92793b83a6b5c94d4d179fc5988930282d7e64",
  win32: "4d6931209eebb1bfb7c7e8b240a6a3cb3ab24479ea294f3539429574b1eec862",
};
const CMDLINE_OS = { linux: "linux", darwin: "mac", win32: "win" };
const NEEDED_GB = 5;

const WIN = osPlatform() === "win32";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const CHECK = flag("--check");
const OWN_JDK = flag("--own-jdk"); // ignore any JDK already on this computer and use the pinned one
const DIR = resolve(opt("--dir", join(homedir(), ".freefield-android")));
const SDK = join(DIR, "sdk");
const JDK_DIR = join(DIR, "jdk");
const exe = (n) => (WIN ? `${n}.exe` : n);
const bat = (n) => (WIN ? `${n}.bat` : n);
const say = (m) => console.log(m);
const fail = (m) => {
  console.error(`\nSTOP: ${m}\n`);
  process.exit(1);
};

// ---------------------------------------------------------------- what is already there
const isJdk = (home) => !!home && existsSync(join(home, "bin", exe("javac"))) && existsSync(join(home, "bin", exe("keytool")));
function javaMajor(javaHome) {
  const bin = javaHome ? join(javaHome, "bin", exe("java")) : "java";
  const r = spawnSync(bin, ["-version"], { encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  const m = /version "(\d+)(?:\.(\d+))?/.exec(`${r.stderr}${r.stdout}`);
  return m ? Number(m[1] === "1" ? m[2] : m[1]) : null;
}
/** A usable JDK 21: JAVA_HOME, our own install, or `java` on the PATH (then JAVA_HOME is found from it). */
function findJdk() {
  const own = ownJdkHome();
  if (isJdk(own) && javaMajor(own) === 21) return own;
  if (!OWN_JDK && isJdk(process.env.JAVA_HOME) && javaMajor(process.env.JAVA_HOME) === 21) return process.env.JAVA_HOME;
  if (!OWN_JDK && javaMajor() === 21) {
    const r = spawnSync("java", ["-XshowSettings:properties", "-version"], { encoding: "utf8" });
    const home = /java\.home = (.+)/.exec(`${r.stderr}${r.stdout}`)?.[1]?.trim();
    if (isJdk(home)) return home;
  }
  return null;
}
function ownJdkHome() {
  if (!existsSync(JDK_DIR)) return null;
  const top = readdirSync(JDK_DIR).find((d) => d.startsWith("jdk-"));
  if (!top) return null;
  const mac = join(JDK_DIR, top, "Contents", "Home");
  return existsSync(mac) ? mac : join(JDK_DIR, top);
}
const sdkHas = {
  cmdline: () => existsSync(join(SDK, "cmdline-tools", "latest", "bin", bat("sdkmanager"))),
  platformTools: () => existsSync(join(SDK, "platform-tools", exe("adb"))),
  platform: () => existsSync(join(SDK, "platforms", ANDROID_PLATFORM, "android.jar")),
  buildTools: () => existsSync(join(SDK, "build-tools", ANDROID_BUILD_TOOLS, exe("aapt2"))) && existsSync(join(SDK, "build-tools", ANDROID_BUILD_TOOLS, bat("apksigner"))),
  licences: () => existsSync(join(SDK, "licenses", "android-sdk-license")),
};
const freeGb = () => {
  try {
    mkdirSync(DIR, { recursive: true });
    const s = statfsSync(DIR);
    return (s.bavail * s.bsize) / 1024 ** 3;
  } catch {
    return null;
  }
};

const plat = `${osPlatform()}-${osArch()}`;
const jdkPin = JDK_PINS[plat];
const jdkOk = findJdk();
const missing = [];
if (!jdkOk) missing.push(`JDK 21 (a pinned Temurin ${JDK_RELEASE} will be installed in ${JDK_DIR})`);
if (!sdkHas.cmdline()) missing.push("Android command-line tools");
if (!sdkHas.platformTools()) missing.push("Android platform-tools (adb)");
if (!sdkHas.platform()) missing.push(`Android platform ${ANDROID_PLATFORM}`);
if (!sdkHas.buildTools()) missing.push(`Android build-tools ${ANDROID_BUILD_TOOLS}`);

say(`FreeField Android toolchain  (folder: ${DIR})`);
say(`Disk: the tools need about 3 GB, the first build about 2 GB more. Free space here: ${freeGb()?.toFixed(1) ?? "unknown"} GB.`);
say(`JDK 21: ${jdkOk ? `found (${jdkOk})` : "missing"}`);
say(`Android SDK: ${sdkHas.cmdline() ? "command-line tools ok" : "command-line tools missing"}, platform-tools ${sdkHas.platformTools() ? "ok" : "missing"}, ${ANDROID_PLATFORM} ${sdkHas.platform() ? "ok" : "missing"}, build-tools ${ANDROID_BUILD_TOOLS} ${sdkHas.buildTools() ? "ok" : "missing"}`);

if (CHECK) {
  if (missing.length === 0) say("\nEverything needed is installed.");
  else say(`\nMissing:\n${missing.map((m) => `  - ${m}`).join("\n")}\nRun: node scripts/setup-android-toolchain.mjs --accept-licenses`);
  process.exit(missing.length ? 1 : 0);
}
if (missing.length === 0 && existsSync(join(DIR, "toolchain.json"))) {
  say("\nNothing to do: the toolchain is complete.");
  writeOutputs(jdkOk);
  process.exit(0);
}

if (!flag("--accept-licenses")) {
  say(
    `\nBefore installing, please read and accept the licences:\n  Android SDK terms: https://developer.android.com/studio/terms\n  Eclipse Temurin JDK (GPLv2 + Classpath Exception): https://adoptium.net/about/\n` +
      "When you have accepted them, run the same command with --accept-licenses added.",
  );
  process.exit(2);
}
if (!WIN && osArch() === "arm64" && osPlatform() === "linux") say("Note: Linux on ARM is not supported by Google's SDK build tools (x86-64 only); the build may fail.");
if ((freeGb() ?? 99) < NEEDED_GB) fail(`Not enough free disk space: ${freeGb()?.toFixed(1)} GB free, about ${NEEDED_GB} GB needed. Free some space or use --dir <another drive>.`);

// ---------------------------------------------------------------- helpers
async function download(url, dest, sha256, label) {
  say(`Downloading ${label} ...`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) fail(`Download failed (${res.status}) from ${new URL(url).host}. If a company proxy blocks it, ask IT to allow that host (docs/company/IT-REQUEST.md).`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let got = 0;
  let lastPct = -10;
  const body = Readable.fromWeb(res.body);
  body.on("data", (c) => {
    got += c.length;
    if (total) {
      const pct = Math.min(100, Math.floor((got / total) * 100));
      if (pct >= lastPct + 10) {
        lastPct = pct;
        say(`  ${pct}%`);
      }
    }
  });
  await pipeline(body, createWriteStream(dest));
  const h = createHash("sha256");
  await pipeline(createReadStream(dest), h);
  if (h.digest("hex") !== sha256) {
    rmSync(dest, { force: true });
    fail(`The downloaded ${label} does not match its expected checksum. It was deleted. Try again; if it repeats, a proxy may be altering downloads: tell IT.`);
  }
  say(`  checksum ok`);
}
function extract(archive, into) {
  mkdirSync(into, { recursive: true });
  let r;
  if (archive.endsWith(".tar.gz")) r = spawnSync("tar", ["-xzf", archive, "-C", into], { stdio: "inherit" });
  else if (osPlatform() !== "linux") r = spawnSync("tar", ["-xf", archive, "-C", into], { stdio: "inherit" }); // bsdtar reads zip
  else {
    r = spawnSync("unzip", ["-q", "-o", archive, "-d", into], { stdio: "inherit" });
    if (r.error) r = spawnSync("python3", ["-m", "zipfile", "-e", archive, into], { stdio: "inherit" });
  }
  if (r.error || r.status !== 0) fail(`Could not unpack ${archive}. On Linux install "unzip" (sudo apt install unzip) and run this again.`);
}

// ---------------------------------------------------------------- install
const tmp = join(DIR, "downloads");
mkdirSync(tmp, { recursive: true });
let javaHome = jdkOk;
if (!javaHome) {
  if (!jdkPin) fail(`No pinned JDK for this system (${plat}). Install a JDK 21 yourself and set JAVA_HOME, then run this again.`);
  const file = join(tmp, `temurin-${jdkPin[0]}`);
  await download(JDK_BASE + jdkPin[0], file, jdkPin[1], `Temurin ${JDK_RELEASE}`);
  rmSync(JDK_DIR, { recursive: true, force: true });
  extract(file, JDK_DIR);
  rmSync(file, { force: true });
  javaHome = ownJdkHome();
  if (!javaHome || javaMajor(javaHome) !== 21) fail("The JDK was unpacked but does not run. Delete the folder " + JDK_DIR + " and try again.");
  say(`JDK 21 installed: ${javaHome}`);
}

if (!sdkHas.cmdline()) {
  const os = CMDLINE_OS[osPlatform()];
  const file = join(tmp, `cmdline-${os}.zip`);
  await download(`https://dl.google.com/android/repository/commandlinetools-${os}-${CMDLINE_VERSION}_latest.zip`, file, CMDLINE_PINS[osPlatform()], "Android command-line tools");
  const x = join(tmp, "cmdline-x");
  rmSync(x, { recursive: true, force: true });
  extract(file, x);
  mkdirSync(join(SDK, "cmdline-tools"), { recursive: true });
  rmSync(join(SDK, "cmdline-tools", "latest"), { recursive: true, force: true });
  renameSync(join(x, "cmdline-tools"), join(SDK, "cmdline-tools", "latest"));
  rmSync(x, { recursive: true, force: true });
  rmSync(file, { force: true });
}

const sdkmanager = join(SDK, "cmdline-tools", "latest", "bin", bat("sdkmanager"));
const sdkEnv = { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: SDK, ANDROID_SDK_ROOT: SDK };
const runSdk = (args, input) => spawnSync(sdkmanager, [`--sdk_root=${SDK}`, ...args], { encoding: "utf8", input, env: sdkEnv, shell: WIN, stdio: input ? ["pipe", "inherit", "inherit"] : "inherit" });
say("Accepting the Android SDK licences (you confirmed them with --accept-licenses) ...");
runSdk(["--licenses"], "y\n".repeat(30));
const wanted = [];
if (!sdkHas.platformTools()) wanted.push("platform-tools");
if (!sdkHas.platform()) wanted.push(`platforms;${ANDROID_PLATFORM}`);
if (!sdkHas.buildTools()) wanted.push(`build-tools;${ANDROID_BUILD_TOOLS}`);
if (wanted.length) {
  say(`Installing Android SDK parts: ${wanted.join(", ")} (this takes a few minutes) ...`);
  const r = runSdk(wanted);
  if (r.status !== 0) fail("sdkmanager failed (see the messages above). A proxy or no internet is the usual cause.");
}
for (const [k, ok] of Object.entries(sdkHas)) if (!ok()) fail(`After installing, "${k}" is still missing. Run with --check to see details.`);
rmSync(tmp, { recursive: true, force: true });
writeOutputs(javaHome);
say("\nDone. Next: node scripts/build-android.mjs");

function writeOutputs(jdk) {
  writeFileSync(join(DIR, "toolchain.json"), JSON.stringify({ javaHome: jdk, androidHome: SDK }, null, 2) + "\n");
  const lp = join(ROOT, "apps", "mobile", "android", "local.properties");
  writeFileSync(lp, `sdk.dir=${SDK.replace(/\\/g, "\\\\")}\n`);
  say(`\nJAVA_HOME=${jdk}\nANDROID_HOME=${SDK}`);
  say(`(also saved in ${join(DIR, "toolchain.json")} and ${lp}; scripts/build-android.mjs uses them by itself)`);
}
