import { describe, it, expect } from "vitest";
import { mailAccess, ACCESS_MESSAGE } from "./access";
import type { SessionUser } from "@/lib/rbac";

const CONFIGURED = {
  MICROSOFT_MAIL: "1",
  MICROSOFT_TENANT_ID: "t",
  MICROSOFT_CLIENT_ID: "c",
  MICROSOFT_CLIENT_SECRET: "s",
  MICROSOFT_REDIRECT_URI: "https://app/api/mail/ms/callback",
};

const user = (role: string, email?: string) =>
  ({ role, email } as unknown as Pick<SessionUser, "role"> & { email?: string | null });

describe("Le drapeau ferme le module, même configuré", () => {
  it("sans MICROSOFT_MAIL, personne n'entre — pas même le Super Admin", () => {
    // C'est ce qui permet de DÉPLOYER le code avant d'ouvrir le service.
    const a = mailAccess(user("SUPER_ADMIN"), { ...CONFIGURED, MICROSOFT_MAIL: "" });
    expect(a.allowed).toBe(false);
    expect(a.reason).toBe("flag-off");
  });

  it("accepte les écritures humaines du drapeau", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE"]) {
      expect(mailAccess(user("SUPER_ADMIN"), { ...CONFIGURED, MICROSOFT_MAIL: v }).allowed, v).toBe(true);
    }
  });
});

describe("Sans configuration, on ne propose pas de se connecter", () => {
  it("dit ce qui manque, nommé", () => {
    // Proposer « Connecter ma boîte » sans configuration mène à un écran d'erreur Microsoft
    // que personne ne sait lire.
    const a = mailAccess(user("SUPER_ADMIN"), { MICROSOFT_MAIL: "1", MICROSOFT_TENANT_ID: "t" });
    expect(a.reason).toBe("not-configured");
    expect(a.missingVars).toEqual(["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "MICROSOFT_REDIRECT_URI"]);
  });
});

describe("Le pilote — une boîte d'abord, l'entreprise ensuite", () => {
  it("le Super Admin entre toujours : c'est lui qui mène le pilote", () => {
    expect(mailAccess(user("SUPER_ADMIN"), CONFIGURED).allowed).toBe(true);
  });

  it("une liste pilote VIDE ferme la porte aux autres", () => {
    // Ouvrir à tous sur une liste oubliée serait exactement la mauvaise valeur par défaut.
    const a = mailAccess(user("EMPLOYEE", "karim@adventumdz.com"), CONFIGURED);
    expect(a.allowed).toBe(false);
    expect(a.reason).toBe("not-in-pilot");
  });

  it("laisse entrer une boîte inscrite au pilote", () => {
    const env = { ...CONFIGURED, MICROSOFT_MAIL_PILOT: "amine.djouamai@adventumdz.com" };
    expect(mailAccess(user("EMPLOYEE", "amine.djouamai@adventumdz.com"), env).allowed).toBe(true);
  });

  it("ignore la casse et les espaces de la liste", () => {
    const env = { ...CONFIGURED, MICROSOFT_MAIL_PILOT: " AMINE.DJOUAMAI@ADVENTUMDZ.COM , karim@adventumdz.com " };
    expect(mailAccess(user("EMPLOYEE", "amine.djouamai@adventumdz.com"), env).allowed).toBe(true);
    expect(mailAccess(user("EMPLOYEE", "karim@adventumdz.com"), env).allowed).toBe(true);
  });

  it("refuse une boîte absente de la liste", () => {
    const env = { ...CONFIGURED, MICROSOFT_MAIL_PILOT: "amine.djouamai@adventumdz.com" };
    expect(mailAccess(user("EMPLOYEE", "autre@adventumdz.com"), env).allowed).toBe(false);
  });

  it("« * » ouvre à toute l'entreprise — un compte sans adresse reste dehors, et la liste vide reste fermée", () => {
    const env = { ...CONFIGURED, MICROSOFT_MAIL_PILOT: " * " };
    expect(mailAccess(user("EMPLOYEE", "karim@adventumdz.com"), env).allowed).toBe(true);
    expect(mailAccess(user("COORDINATOR", "samia@adventumdz.com"), env).allowed).toBe(true);
    expect(mailAccess(user("EMPLOYEE", ""), env).allowed).toBe(false);
    expect(mailAccess(user("EMPLOYEE", "karim@adventumdz.com"), CONFIGURED).allowed).toBe(false);
  });

  it("un compte sans adresse ne passe pas par inadvertance", () => {
    const env = { ...CONFIGURED, MICROSOFT_MAIL_PILOT: "amine.djouamai@adventumdz.com" };
    expect(mailAccess(user("EMPLOYEE", null as unknown as string), env).allowed).toBe(false);
    expect(mailAccess(user("EMPLOYEE", ""), env).allowed).toBe(false);
  });
});

describe("Chaque refus s'explique", () => {
  it("porte un message distinct — les actions à faire ne sont pas les mêmes", () => {
    const reasons = ["flag-off", "not-configured", "not-in-pilot"] as const;
    const messages = reasons.map((r) => ACCESS_MESSAGE[r]);
    expect(new Set(messages).size).toBe(reasons.length);
    for (const m of messages) expect(m.length).toBeGreaterThan(20);
  });
});
