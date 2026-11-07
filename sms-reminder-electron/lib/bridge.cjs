const GETS = new Set([
  "/health",
  "/api/admin/patients",
  "/api/sms-reminders/appointments",
  "/api/sms-reminders/recall-candidates",
  "/api/sms-reminders/treatment-candidates",
  "/api/sms-reminders/birthday-candidates",
  "/api/sms-reminders/patient-logs",
  "/api/sms-reminders/patient-history",
  "/api/sms-reminders/logs",
  "/api/sms-templates",
  "/api/sms-templates/init",
  "/api/sms-settings",
]);
const WRITES = new Map([
  ["/api/sms-templates", new Set(["POST", "PUT", "DELETE"])],
  ["/api/sms-settings", new Set(["PUT"])],
  ...[
    "log",
    "patient-log",
    "recall-log",
    "recall-claim",
    "treatment-log",
    "campaign-log",
    "reset-log",
    "reset-patient-log",
    "clear-dry-run",
  ].map((p) => [`/api/sms-reminders/${p}`, new Set(["POST"])]),
]);
class Bridge {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }
  async request(method, route, params = {}, body) {
    if (!(method === "GET" ? GETS.has(route) : WRITES.get(route)?.has(method)))
      throw new Error("Unsupported Bridge operation.");
    const config = this.config();
    if (!config.api_token?.trim())
      throw new Error("Set Bridge URL and API token in Settings.");
    const url = new URL(config.bridge_url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error(
        "Bridge URL must use HTTP or HTTPS without embedded credentials.",
      );
    url.pathname = `${url.pathname.replace(/\/$/, "")}${route}`;
    url.search = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v != null),
    );
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.api_token}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    });
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`Bridge returned non-JSON (HTTP ${response.status}).`);
    }
    if (!response.ok || !data.ok)
      throw new Error(data.error || `Bridge HTTP ${response.status}`);
    return data.data || {};
  }
}
module.exports = { Bridge };
