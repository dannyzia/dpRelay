#!/usr/bin/env node
/**
 * Reads NUL-delimited paths on stdin, prints the ones NOT matched by the
 * allowlist globs, NUL-delimited.
 *
 * Hand-rolled glob matching on purpose: the obvious tools (minimatch via npm,
 * git check-ignore with a custom exclude file) would each add a dependency or
 * a surprising git-config interaction to a gate that must be obvious to read.
 *
 * Gitignore-like semantics, because that is what a reader expects from a file
 * named "allowlist" next to a .gitignore:
 *   - a pattern containing "/" is matched against the whole path
 *   - a pattern without "/" is matched against the basename, so a bare
 *     `google-services.json` covers it at any depth
 *   - `**` matches across "/", `*` and `?` do not
 *
 * Every non-comment entry must be preceded by a "#" justification line. An
 * unexplained allowlist entry is the failure mode that turns a gate into
 * decoration, so it is a usage error rather than a warning.
 */
const { readFileSync } = require("node:fs");

const allowlistPath = process.argv[2];
if (!allowlistPath) {
  process.stderr.write("usage: filter-allowlist.cjs <allowlist-file>\n");
  process.exit(2);
}

function globToRegExp(glob) {
  let out = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` should also match zero directories, so `a/**/b` matches `a/b`.
        if (glob[i + 2] === "/") { out += "(?:.*/)?"; i += 2; } else { out += ".*"; i += 1; }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`${out}$`);
}

const lines = readFileSync(allowlistPath, "utf8").split("\n");
const patterns = [];
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i].trim();
  if (line === "" || line.startsWith("#")) continue;
  // Walk back over blank lines and neighbouring entries until a comment is
  // found. A single comment block therefore justifies the group of entries
  // beneath it, which is how the file is meant to be read.
  let j = i - 1;
  let justified = false;
  while (j >= 0) {
    const prev = lines[j].trim();
    if (prev.startsWith("#")) {
      justified = true;
      break;
    }
    j -= 1;
  }
  if (!justified) {
    process.stderr.write(
      `allowlist entry "${line}" (${allowlistPath}:${i + 1}) has no justification comment above it\n`,
    );
    process.exit(2);
  }
  const wholePath = line.includes("/");
  patterns.push({ re: globToRegExp(line), wholePath });
}

const isAllowed = (p) =>
  patterns.some((r) => r.re.test(r.wholePath ? p : p.split("/").pop()));

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  const parts = buf.split("\0");
  buf = parts.pop() ?? "";
  for (const p of parts) if (p !== "" && !isAllowed(p)) process.stdout.write(`${p}\0`);
});
process.stdin.on("end", () => {
  if (buf !== "" && !isAllowed(buf)) process.stdout.write(`${buf}\0`);
});