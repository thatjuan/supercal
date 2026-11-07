// One-tap Apple setup: an unsigned .mobileconfig with a com.apple.caldav.account payload.
// Serve with Content-Type application/x-apple-aspen-config so Safari offers to install it.
// The password is left out on purpose: iOS/macOS prompt for it during install, so the file is
// not a credential (Apple documents CalDAVPassword as for encrypted profiles only).
import { esc } from "./xml";

export type CaldavProfile = { host: string; port: number; username: string; feedName: string; feedId: string; password?: string };

export function caldavMobileconfig(p: CaldavProfile): string {
  const uuid = (seed: string) => {
    const h = new Bun.CryptoHasher("sha256").update(seed).digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
  };
  const kv = (k: string, v: string | number | boolean) =>
    `<key>${k}</key>` + (typeof v === "boolean" ? `<${v}/>` : typeof v === "number" ? `<integer>${v}</integer>` : `<string>${esc(v)}</string>`);
  const payload = [
    kv("PayloadType", "com.apple.caldav.account"),
    kv("PayloadVersion", 1),
    kv("PayloadIdentifier", `dev.supercal.feed.${p.feedId}.caldav`),
    kv("PayloadUUID", uuid(`caldav:${p.feedId}`)),
    kv("PayloadDisplayName", `${p.feedName} (CalDAV)`),
    kv("CalDAVAccountDescription", p.feedName),
    kv("CalDAVHostName", p.host),
    kv("CalDAVPort", p.port),
    kv("CalDAVUseSSL", true),
    kv("CalDAVPrincipalURL", `https://${p.host}/dav/principals/${encodeURIComponent(p.username)}/`),
    kv("CalDAVUsername", p.username),
    ...(p.password ? [kv("CalDAVPassword", p.password)] : []),
  ].join("\n      ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      ${payload}
    </dict>
  </array>
  ${kv("PayloadType", "Configuration")}
  ${kv("PayloadVersion", 1)}
  ${kv("PayloadIdentifier", `dev.supercal.feed.${p.feedId}`)}
  ${kv("PayloadUUID", uuid(`profile:${p.feedId}`))}
  ${kv("PayloadDisplayName", `Supercal: ${p.feedName}`)}
  ${kv("PayloadDescription", "Adds your Supercal feed as a read-only calendar account.")}
  ${kv("PayloadOrganization", "Supercal")}
  ${kv("PayloadRemovalDisallowed", false)}
</dict>
</plist>
`;
}

if (import.meta.main) {
  const out = new URL("../evidence/supercal-meridian.mobileconfig", import.meta.url).pathname;
  await Bun.write(out, caldavMobileconfig({ host: "cal.example.com", port: 443, username: "meridian", feedName: "Juan's feed", feedId: "1" }));
  console.log(out);
}
