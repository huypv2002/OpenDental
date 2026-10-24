const { spawn } = require("node:child_process");
const path = require("node:path");
class WindowsAdapter {
  constructor(resourceDir, emit, demo = false) {
    this.resourceDir = resourceDir;
    this.emit = emit;
    this.demo = demo;
    this.child = null;
  }
  async run(payload) {
    if (this.demo) {
      await new Promise((r) => setTimeout(r, 80));
      this.emit({
        type: "activity",
        message: `DEMO: ${payload.action} simulated; no SMS sent.`,
      });
      return { ok: true, mode: payload.mode };
    }
    if (process.platform !== "win32")
      throw new Error(
        "Phone Link and Open Dental automation require Windows. You can review the interface on this computer.",
      );
    if (this.child)
      throw new Error("A Windows automation operation is already running.");
    return new Promise((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-STA",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(this.resourceDir, "automation.ps1"),
        ],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      this.child = child;
      let output = "",
        errors = "",
        lineBuffer = "",
        settled = false;
      const timeout = setTimeout(() => {
        child.kill();
        finish(
          new Error(
            "Windows automation timed out. Inspect Phone Link before retrying.",
          ),
        );
      }, 90000);
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.child = null;
        error ? reject(error) : resolve(result);
      };
      child.on("error", finish);
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop();
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            if (event.type === "trace")
              this.emit({ type: "activity", message: event.message });
          } catch {
            /* PowerShell diagnostics handled on exit. */
          }
        }
      });
      child.stderr.on("data", (chunk) => {
        errors += chunk.toString();
      });
      child.on("close", (code) => {
        const lines = output.trim().split(/\r?\n/).reverse();
        let result;
        for (const line of lines) {
          try {
            const value = JSON.parse(line);
            if ("ok" in value) {
              result = value;
              break;
            }
          } catch {}
        }
        if (code !== 0 || !result?.ok)
          finish(
            new Error(
              result?.error ||
                errors.trim().slice(-1200) ||
                "Windows automation did not return a successful result.",
            ),
          );
        else finish(null, result);
      });
      child.stdin.on("error", (error) => finish(error));
      child.stdin.end(JSON.stringify(payload));
    });
  }
}
module.exports = { WindowsAdapter };
