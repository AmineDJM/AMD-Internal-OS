import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  diagnosticVariables, formeUrl, hotePrive, lireErreur, messageErreurReseau, pointRetourDocumentServer, rapportOk,
  urlApplication, verdictApiJs, verdictHealthcheck, verdictNavigateur, verdictRouteApplication,
} from "./onlyoffice-diagnostic";

describe("hotePrive — ce qu'Internet ne voit pas", () => {
  it("reconnaît localhost, les plages privées et les noms internes", () => {
    for (const h of ["localhost", "app.localhost", "127.0.0.1", "10.2.3.4", "172.16.0.1", "172.31.255.255", "192.168.1.10",
      "169.254.1.1", "0.0.0.0", "[::1]", "fd12:3456::1", "onlyoffice", "office.local", "ds.internal"]) {
      expect(hotePrive(h), h).toBe(true);
    }
  });
  it("laisse passer les adresses publiques — 172.15 et 172.32 sont HORS de la plage privée", () => {
    for (const h of ["office.adventum.dz", "172.15.0.1", "172.32.0.1", "8.8.8.8", "193.168.1.1"]) {
      expect(hotePrive(h), h).toBe(false);
    }
  });
});

describe("formeUrl — la forme d'une adresse, avant tout appel", () => {
  it("https public sans barre finale : correct", () => {
    const p = formeUrl("https://office.adventum.dz", "editeur");
    expect(p.etat).toBe("ok");
    expect(p.correctif).toBeUndefined();
  });
  it("http:// est un ÉCHEC pour l'éditeur et explique la mise à niveau forcée en https", () => {
    const p = formeUrl("http://office.adventum.dz", "editeur");
    expect(p.etat).toBe("echec");
    expect(p.detail).toMatch(/force en https/);
    expect(p.correctif).toMatch(/HTTPS/);
  });
  it("http:// pour l'application n'est qu'une attention", () => {
    expect(formeUrl("http://erp.adventum.dz", "application").etat).toBe("attention");
  });
  it("adresse interne → « non joignable depuis Internet »", () => {
    for (const u of ["https://192.168.1.20", "https://10.0.0.5:8443", "https://onlyoffice", "https://localhost:8443"]) {
      const p = formeUrl(u, "editeur");
      expect(p.etat, u).toBe("echec");
      expect(p.detail, u).toMatch(/non joignable depuis Internet/);
    }
  });
  it("barre finale : attention seulement (elle est retirée par le code)", () => {
    const p = formeUrl("https://office.adventum.dz/", "editeur");
    expect(p.etat).toBe("attention");
    expect(p.detail).toMatch(/Barre/);
  });
  it("un chemin interne du Document Server dans la variable est refusé", () => {
    expect(formeUrl("https://office.adventum.dz/web-apps/apps/api/documents/api.js", "editeur").etat).toBe("echec");
  });
  it("une adresse illisible le dit", () => {
    const p = formeUrl("office.adventum.dz", "editeur");
    expect(p.etat).toBe("echec");
    expect(p.detail).toMatch(/pas une adresse complète/);
  });
});

describe("diagnosticVariables — jamais la valeur du secret", () => {
  it("dit « défini, N caractères » et ne contient JAMAIS le secret", () => {
    const secret = "s3cr3t-tres-long-et-aleatoire-0123456789";
    const points = diagnosticVariables({ ONLYOFFICE_URL: "https://office.adventum.dz", ONLYOFFICE_JWT_SECRET: secret, APP_URL: "https://erp.adventum.dz" });
    expect(points.map((p) => p.etat)).toEqual(["ok", "ok", "ok"]);
    expect(points[1]!.detail).toBe(`Défini, ${secret.length} caractères.`);
    expect(JSON.stringify(points)).not.toContain(secret);
  });
  it("chaque absence est un échec avec son correctif", () => {
    const points = diagnosticVariables({});
    expect(points.map((p) => p.etat)).toEqual(["echec", "echec", "echec"]);
    for (const p of points) expect(p.correctif).toBeTruthy();
  });
  it("APP_URL absente : la variable de repli utilisée est NOMMÉE (même ordre que appBaseUrl)", () => {
    const env = { NEXTAUTH_URL: "https://a.dz", AUTH_URL: "https://b.dz" };
    const p = diagnosticVariables(env)[2]!;
    expect(p.etat).toBe("ok");
    expect(p.detail).toMatch(/NEXTAUTH_URL/);
    expect(urlApplication(env)).toBe("https://a.dz");
  });
  it("des espaces autour du secret sont signalés", () => {
    expect(diagnosticVariables({ ONLYOFFICE_JWT_SECRET: " abc " })[1]!.etat).toBe("attention");
  });
});

describe("erreurs réseau → phrases distinctes", () => {
  const cas: [Record<string, unknown>, RegExp][] = [
    [{ name: "TimeoutError" }, /Pas de réponse en 8 s/],
    [{ cause: { code: "ENOTFOUND" } }, /DNS/],
    [{ cause: { code: "ECONNREFUSED" } }, /Connexion refusée/],
    [{ cause: { code: "CERT_HAS_EXPIRED" } }, /expiré/],
    [{ cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } }, /auto-signé/],
    [{ cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" } }, /ne couvre pas/],
    [{ cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } }, /intermédiaire/],
    [{ cause: { code: "ERR_SSL_WRONG_VERSION_NUMBER" } }, /HTTP, pas en HTTPS/],
  ];
  it.each(cas)("%j", (err, attendu) => {
    // `fetch` de Node range le code utile dans `cause` : `lireErreur` doit aller l'y chercher.
    const m = messageErreurReseau(lireErreur(Object.assign(new TypeError("fetch failed"), err)), "office.adventum.dz");
    expect(m.detail).toMatch(attendu);
    expect(m.correctif).toBeTruthy();
  });
  it("le nom de domaine fautif est cité pour le DNS", () => {
    expect(messageErreurReseau({ code: "ENOTFOUND" }, "office.adventum.dz").detail).toContain("office.adventum.dz");
  });
});

describe("codes HTTP du Document Server", () => {
  it("healthcheck : seul « true » en 200 est bon", () => {
    expect(verdictHealthcheck(200, "true\n").etat).toBe("ok");
    expect(verdictHealthcheck(200, "false").detail).toMatch(/services internes/);
    expect(verdictHealthcheck(200, "<html>").etat).toBe("echec");
  });
  it("502/503 = endormi ou en démarrage", () => {
    for (const s of [502, 503, 504]) {
      expect(verdictHealthcheck(s, "").detail).toMatch(/endormi ou en cours de démarrage/);
      expect(verdictApiJs(s, "text/html").detail).toMatch(/endormi/);
    }
  });
  it("api.js : 200 + JavaScript, sinon le type reçu est nommé", () => {
    // Render SUSPENDU (x-render-routing: suspend-by-user) : pas « endormi », il faut le reprendre.
    expect(verdictHealthcheck(503, "", "suspend-by-user").detail).toMatch(/SUSPENDU/);
    expect(verdictHealthcheck(503, "", "suspend-by-user").correctif).toMatch(/Resume Service/);
    expect(verdictApiJs(503, "text/html", "suspend-by-user").detail).toMatch(/SUSPENDU/);
    expect(verdictHealthcheck(503, "", null).detail).toMatch(/endormi/);
    expect(verdictApiJs(200, "application/javascript; charset=utf-8").etat).toBe("ok");
    const p = verdictApiJs(200, "text/html");
    expect(p.etat).toBe("echec");
    expect(p.detail).toContain("text/html");
    expect(verdictApiJs(404, "").detail).toMatch(/introuvable/);
  });
});

describe("le retour vers l'application", () => {
  it("401 sans jeton = la route est en ligne", () => {
    expect(verdictRouteApplication(401, null).etat).toBe("ok");
  });
  it("une redirection vers /login est un échec qui nomme la correction", () => {
    const p = verdictRouteApplication(307, "https://erp.adventum.dz/login?callbackUrl=%2Fapi%2Fonlyoffice%2Ffile");
    expect(p.etat).toBe("echec");
    expect(p.correctif).toMatch(/auth\.config/);
  });
  it("une autre redirection : APP_URL n'est pas l'adresse finale", () => {
    expect(verdictRouteApplication(301, "https://www.erp.adventum.dz/api/onlyoffice/file").etat).toBe("attention");
  });
  it("le point d'information cite les deux routes", () => {
    const p = pointRetourDocumentServer("https://erp.adventum.dz/");
    expect(p.etat).toBe("info");
    expect(p.detail).toContain("https://erp.adventum.dz/api/onlyoffice/file");
    expect(p.detail).toContain("/api/onlyoffice/callback");
  });
});

describe("l'essai dans le navigateur", () => {
  const url = "https://office.adventum.dz/web-apps/apps/api/documents/api.js";
  it("serveur OK mais navigateur KO → réseau interne / certificat / extension", () => {
    const p = verdictNavigateur("erreur", { url, pageHttps: true, serveurJoint: true });
    expect(p.etat).toBe("echec");
    expect(p.detail).toMatch(/Notre serveur l'atteint, pas ce navigateur/);
  });
  it("http:// depuis une page https → contenu mixte", () => {
    expect(verdictNavigateur("erreur", { url: url.replace("https:", "http:"), pageHttps: true, serveurJoint: true }).detail).toMatch(/force en https/);
  });
  it("chargé et API présente → ok", () => {
    expect(verdictNavigateur("ok", { url, pageHttps: true, serveurJoint: true }).etat).toBe("ok");
  });
});

describe("rapportOk", () => {
  it("attention et info n'arrêtent rien ; un échec, si", () => {
    expect(rapportOk([{ cle: "a", libelle: "a", etat: "attention", detail: "" }, { cle: "b", libelle: "b", etat: "info", detail: "" }])).toBe(true);
    expect(rapportOk([{ cle: "a", libelle: "a", etat: "echec", detail: "" }])).toBe(false);
  });
});

describe("le Document Server n'a pas de session — ses deux routes sont hors connexion, et elles seules", () => {
  const lire = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
  it("l'exemption du middleware est EXACTE : /file et /callback, jamais /session", () => {
    const conf = lire("src/auth.config.ts");
    expect(conf).toContain(`nextUrl.pathname === "/api/onlyoffice/file"`);
    expect(conf).toContain(`nextUrl.pathname === "/api/onlyoffice/callback"`);
    expect(conf).not.toMatch(/startsWith\("\/api\/onlyoffice/);
    expect(conf).not.toContain("/api/onlyoffice/session");
  });
  it("chacune vérifie le jeton signé avant de toucher à la base", () => {
    for (const f of ["src/app/api/onlyoffice/file/route.ts", "src/app/api/onlyoffice/callback/route.ts"]) {
      const src = lire(f);
      const jeton = src.search(/read(Doc)?EditToken\(token\)/);
      expect(jeton, f).toBeGreaterThan(0);
      expect(src.indexOf("prisma."), f).toBeGreaterThan(jeton);
    }
  });
});
