import { describe, expect, it } from "vitest";
import { endpointPushAutorise } from "./endpoint-push";

describe("endpointPushAutorise — le serveur ne POSTe que vers un service push de navigateur", () => {
  it("accepte les services push des navigateurs", () => {
    expect(endpointPushAutorise("https://fcm.googleapis.com/fcm/send/abc:def")).toBe(true);
    expect(endpointPushAutorise("https://updates.push.services.mozilla.com/wpush/v2/gAAAA")).toBe(true);
    expect(endpointPushAutorise("https://web.push.apple.com/QGx1")).toBe(true);
    expect(endpointPushAutorise("https://wns2-par02p.notify.windows.com/w/?token=x")).toBe(true);
  });

  it("refuse le réseau interne et les adresses arbitraires (SSRF)", () => {
    expect(endpointPushAutorise("http://localhost:3000/api/x")).toBe(false);
    expect(endpointPushAutorise("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(endpointPushAutorise("https://evil.example.com/fcm.googleapis.com")).toBe(false);
    expect(endpointPushAutorise("https://fcm.googleapis.com.evil.example/x")).toBe(false);
    expect(endpointPushAutorise("https://notify.windows.com.evil.example/x")).toBe(false);
  });

  it("refuse le HTTP clair, un port explicite, des identifiants, une chaîne invalide", () => {
    expect(endpointPushAutorise("http://fcm.googleapis.com/fcm/send/x")).toBe(false);
    expect(endpointPushAutorise("https://fcm.googleapis.com:8443/x")).toBe(false);
    expect(endpointPushAutorise("https://u:p@fcm.googleapis.com/x")).toBe(false);
    expect(endpointPushAutorise("pas une url")).toBe(false);
    expect(endpointPushAutorise(undefined)).toBe(false);
    expect(endpointPushAutorise("https://fcm.googleapis.com/" + "a".repeat(5000))).toBe(false);
  });
});
