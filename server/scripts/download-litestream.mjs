// Downloads Litestream static binary (cross-platform, uses curl/wget).
import { mkdirSync, existsSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const binDir = join(root, "bin");
const litestreamPath = join(binDir, "litestream");

const VERSION = "0.3.12";
const PLATFORM = process.platform === "win32" ? "windows" : "linux";
const ARCH = process.arch === "arm64" ? "arm64" : "amd64";
const EXT = PLATFORM === "windows" ? ".zip" : ".tar.gz";
const URL = `https://github.com/benbjohnson/litestream/releases/download/v${VERSION}/litestream-v${VERSION}-${PLATFORM}-${ARCH}${EXT}`;

mkdirSync(join(root, "bin"), { recursive: true });

if (!existsSync(litestreamPath)) {
  console.log(`Downloading Litestream v${VERSION} (${PLATFORM}/${ARCH})...`);
  const archive = join(root, "bin", `litestream-${VERSION}${EXT}`);
  // curl handles redirects, retries, TLS — available on Render and Linux dev machines
  execSync(`curl -L --fail --silent --show-error -o "${archive}" "${URL}"`, { stdio: "inherit" });
  // extract
  if (EXT === ".zip") {
    execSync(`unzip -o "${archive}" -d "${dirname(litestreamPath)}"`, { stdio: "inherit" });
  } else {
    execSync(`tar -xzf "${archive}" -C "${dirname(litestreamPath)}"`, { stdio: "inherit" });
  }
  if (!existsSync(litestreamPath)) throw new Error("litestream binary not found after extract");
  chmodSync(litestreamPath, 0o755);
  console.log(`Litestream installed → ${litestreamPath}`);
} else {
  console.log(`Litestream already present → ${litestreamPath}`);
}

// copy migrations
import { cpSync } from "node:fs";
cpSync(join(root, "src", "migrations"), join(root, "dist", "migrations"), { recursive: true });
console.log("migrations copied → dist/migrations");