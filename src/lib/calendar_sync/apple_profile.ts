import { createHash } from "node:crypto";

function xml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}
/** The profile contains account settings only. The app password is entered in
 *  macOS during installation, never embedded in a downloaded file or URL. */
export function appleCalendarProfile(baseUrl: string, user: { id: string; email: string }): string {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("calendar_requires_https_origin");
  }
  const id = createHash("sha256").update(base.origin + ":" + user.id).digest("hex");
  const identifier = "cn.bywave.calendar.account." + id.slice(0, 24);
  const uuid = (suffix: string) => {
    const h = createHash("sha256").update(id + suffix).digest("hex");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-5" + h.slice(13, 16) + "-a" + h.slice(17, 20) + "-" + h.slice(20, 32);
  };
  const label = "ByWave · " + user.email + " · " + base.hostname;
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0"><dict>' +
    '<key>PayloadType</key><string>Configuration</string><key>PayloadVersion</key><integer>1</integer>' +
    '<key>PayloadIdentifier</key><string>' + identifier + '</string><key>PayloadUUID</key><string>' + uuid("profile") + '</string>' +
    '<key>PayloadDisplayName</key><string>' + xml(label) + '</string><key>PayloadScope</key><string>User</string>' +
    '<key>PayloadContent</key><array><dict>' +
    '<key>PayloadType</key><string>com.apple.caldav.account</string><key>PayloadVersion</key><integer>1</integer>' +
    '<key>PayloadIdentifier</key><string>' + identifier + '.caldav</string><key>PayloadUUID</key><string>' + uuid("calendar") + '</string>' +
    '<key>PayloadDisplayName</key><string>' + xml(label) + '</string><key>CalDAVAccountDescription</key><string>' + xml(label) + '</string>' +
    '<key>CalDAVHostName</key><string>' + xml(base.hostname) + '</string><key>CalDAVPort</key><integer>' + (base.port || "443") + '</integer>' +
    '<key>CalDAVUseSSL</key><true/><key>CalDAVUsername</key><string>' + xml(user.email) + '</string>' +
    '<key>CalDAVPrincipalURL</key><string>' + xml(base.origin + "/caldav/principals/" + encodeURIComponent(user.id) + "/") + '</string>' +
    '</dict></array></dict></plist>\n';
}
