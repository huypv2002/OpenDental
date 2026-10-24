const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        !["node_modules", "dist", "test-results", ".git"].includes(entry.name)
      )
        scan(file);
    } else if (/\.(cjs|mjs)$/.test(file)) {
      execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
    }
  }
}
scan(path.resolve(__dirname, ".."));
console.log("JavaScript syntax checks passed.");
