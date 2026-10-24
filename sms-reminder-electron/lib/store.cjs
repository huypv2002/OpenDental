const fs = require("node:fs");
const path = require("node:path");
class Store {
  constructor(dir, defaults) {
    this.dir = dir;
    this.defaults = defaults;
    fs.mkdirSync(dir, { recursive: true });
    this.config = this.read("sms_config.json", defaults);
    this.state = this.read("state.json", {
      lastSchedule: "",
      ledger: {},
      outbox: [],
      pendingDraft: null,
      columns: {},
    });
  }
  read(name, defaults) {
    const file = path.join(this.dir, name);
    if (!fs.existsSync(file)) return structuredClone(defaults);
    try {
      return {
        ...structuredClone(defaults),
        ...JSON.parse(fs.readFileSync(file, "utf8")),
      };
    } catch {
      throw new Error(
        `Cannot read ${file}. Restore the JSON file before starting the app.`,
      );
    }
  }
  write(name, value) {
    const file = path.join(this.dir, name),
      temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  saveConfig() {
    this.write("sms_config.json", this.config);
  }
  saveState() {
    this.write("state.json", this.state);
  }
}
module.exports = { Store };
