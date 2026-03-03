export type Permission = "allow" | "deny" | "always_allow";

const sessionAllowlist = new Set<string>();

export function alwaysAllow(key: string): void {
  sessionAllowlist.add(key);
}

export function isAlwaysAllowed(key: string): boolean {
  return sessionAllowlist.has(key);
}

export async function askPermission(
  prompt: string,
  key?: string
): Promise<Permission> {
  if (key && sessionAllowlist.has(key)) return "allow";

  return new Promise((resolve) => {
    process.stdout.write(`${prompt} [y/N/a(lways)] `);

    // Use raw single-char read to avoid double-echo issues
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const onKey = (key: string) => {
      process.stdin.removeListener("data", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();

      const ch = key.toLowerCase().trim();
      process.stdout.write(ch + "\n");

      if (ch === "a") {
        if (key) sessionAllowlist.add(key);
        resolve("always_allow");
      } else if (ch === "y") {
        resolve("allow");
      } else {
        resolve("deny");
      }
    };

    process.stdin.on("data", onKey);
  });
}

export type RiskLevel = "safe" | "moderate" | "dangerous";

const DANGEROUS_PATTERNS = [
  /\brm\s+-rf?\b/,
  /\bdd\b/,
  /\bmkfs\b/,
  /\bchmod\s+777\b/,
  /\bsudo\b/,
  /\bcurl\b.*\|\s*(?:bash|sh|zsh)/,
  /\bwget\b.*\|\s*(?:bash|sh|zsh)/,
  />\s*\/dev\/(sd|nvme|vd)/,
  /\bdrop\s+(?:table|database)\b/i,
];

const MODERATE_PATTERNS = [
  /\brm\b/,
  /\bmv\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bnpm\s+(install|uninstall|publish)\b/,
  /\bgit\s+(push|reset|rebase|force)\b/,
  /\bkill\b/,
  /\bpkill\b/,
  />\s*\//,
];

export function classifyRisk(command: string): RiskLevel {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) return "dangerous";
  }
  for (const pattern of MODERATE_PATTERNS) {
    if (pattern.test(command)) return "moderate";
  }
  return "safe";
}

export function sanitizeCommand(command: string): { safe: boolean; reason?: string } {
  if (/`/.test(command)) {
    return { safe: false, reason: "Command contains backticks (injection risk)" };
  }
  if (/\$\(/.test(command)) {
    return { safe: false, reason: "Command contains $() subshell (injection risk)" };
  }
  return { safe: true };
}
