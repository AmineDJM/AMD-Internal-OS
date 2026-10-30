import { describe, expect, it } from "vitest";
import { decisionMode, MODE_ADVENTUM_IA, pageApresConnexion } from "./app-mode";

/** Le mode d'application (décision 0027, point 10) : un dépôt, un build, deux sites. */
describe("mode d'application — Adventum IA", () => {
  const ERP = "https://amd-internal-os-k3uc.onrender.com";
  const d = (chemin: string, recherche = "", erp: string | null = ERP) => decisionMode(MODE_ADVENTUM_IA, chemin, recherche, erp);

  it("sans APP_MODE, l'ERP est inchangé : tout suit", () => {
    for (const c of ["/", "/finances", "/assistant", "/api/rh/salaires", "/ia"]) expect(decisionMode(undefined, c, "", ERP)).toEqual({ type: "suivre" });
    expect(decisionMode("erp", "/finances", "", ERP)).toEqual({ type: "suivre" });
  });

  it("la racine et les pages d'atterrissage ouvrent l'app", () => {
    for (const c of ["/", "/mon-espace", "/aujourdhui"]) expect(d(c)).toEqual({ type: "rediriger", vers: "/ia" });
  });

  it("un lien de l'Assistant de l'ERP (notification) ouvre la MÊME conversation dans l'app", () => {
    expect(d("/assistant", "?c=abc123")).toEqual({ type: "rediriger", vers: "/ia?c=abc123" });
  });

  it("l'app, la connexion et les API de ses écrans sont servies", () => {
    for (const c of ["/ia", "/login", "/change-password", "/api/assistant-ia/fil", "/api/assistant-ia/vocal", "/api/drive/upload", "/api/push/subscribe", "/api/health", "/adventum-ia/manifest.webmanifest", "/ia-sw.js", "/_next/static/x.js"]) {
      expect(d(c), c).toEqual({ type: "suivre" });
    }
  });

  it("toute autre page de l'ERP renvoie vers l'ERP ; sans adresse d'ERP, elle est refusée", () => {
    expect(d("/finances/demandes", "?x=1")).toEqual({ type: "rediriger", vers: `${ERP}/finances/demandes?x=1` });
    expect(d("/rh", "", null)).toEqual({ type: "refuser" });
    expect(d("/rh", "", "javascript:alert(1)")).toEqual({ type: "refuser" });
    // `/iax` n'est pas `/ia`
    expect(d("/iaxyz")).toEqual({ type: "rediriger", vers: `${ERP}/iaxyz` });
  });

  it("une API de l'ERP hors de l'app est refusée, jamais redirigée", () => {
    for (const c of ["/api/rh/salaires", "/api/finances/export", "/api/assistant/voice/session"]) expect(d(c)).toEqual({ type: "refuser" });
  });

  it("après connexion : l'app en mode Adventum IA, « Mon espace » sinon", () => {
    expect(pageApresConnexion(MODE_ADVENTUM_IA)).toBe("/ia");
    expect(pageApresConnexion(undefined)).toBe("/mon-espace");
  });
});
