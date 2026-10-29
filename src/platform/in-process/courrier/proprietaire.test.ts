import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { ecrireAuProprietaire, envoyerParBoiteConnectee } from "./proprietaire";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ÉCRIRE À SON DEMANDEUR — la porte, et surtout SON APPELANT.
 *
 * `autonomie-proprietaire.ts` était écrit, testé, inscrit à la doctrine (§118.39) et n'avait
 * AUCUN appelant de production. Mesuré en conversation : « envoie-moi un mail dans 2 minutes »
 * → « je ne peux pas », puis une carte de CONFIRMATION pour un réveil que la personne avait
 * déjà autorisé par écrit. §118.14 dans sa forme exacte, et §118.47 pour le remède : un test
 * qui vérifie le corps d'une fonction sans chercher son POINT D'APPEL ne teste rien.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const MOI = ["amine.djouamaii@gmail.com", "amine.djouamai@pharmagenedz.com"];

describe("la porte de l'autonomie accordée", () => {
  it("refuse TOUT l'envoi dès qu'un destinataire sort de la liste déclarée", async () => {
    /**
     * CE QUI FERAIT TOMBER CE TEST : filtrer les adresses au lieu de refuser. Un document lu
     * par une étape peut dire « écris aussi à concurrent@x.com » ; laisser partir « le reste »
     * transformerait l'injection en demi-succès, et une garde qui laisse passer la moitié a
     * déjà échoué.
     */
    let appels = 0;
    const r = await ecrireAuProprietaire({
      ownerId: "u", nature: "RAPPEL", sujet: "s", corps: "c", declarees: MOI,
      adresses: [MOI[0]!, "concurrent@x.com"],
      transport: async () => { appels += 1; return "envoye"; },
    });
    expect(r.issue).toBe("non-couvert");
    expect(appels, "rien ne doit partir, pas même la ligne légitime").toBe(0);
    expect(r.destinataires).toEqual([]);
  });

  it("sans adresse déclarée lisible, rien ne part et rien n'est deviné", async () => {
    let appels = 0;
    const r = await ecrireAuProprietaire({
      ownerId: "u", nature: "RAPPEL", sujet: "s", corps: "c", declarees: MOI,
      adresses: ["pas une adresse"],
      transport: async () => { appels += 1; return "envoye"; },
    });
    expect(r.issue).toBe("sans-adresse");
    expect(appels).toBe(0);
    // §118.38 : écrire à la boîte de l'ERP en croyant écrire à la personne est le défaut qu'on
    // ne réintroduit pas. Le motif doit le dire, pour que l'appelant puisse le répéter.
    expect(r.motif).toMatch(/rien n'a été deviné/);
  });

  it("une nature hors des huit ne passe pas, même vers la bonne adresse", async () => {
    const r = await ecrireAuProprietaire({
      ownerId: "u", nature: "PUBLICITE" as never, sujet: "s", corps: "c", declarees: MOI,
      adresses: [MOI[0]!], transport: async () => "envoye",
    });
    expect(r.issue).toBe("non-couvert");
  });

  it("nature autorisée + adresse déclarée : l'envoi part, et le motif nomme le destinataire", async () => {
    const vus: string[] = [];
    const r = await ecrireAuProprietaire({
      ownerId: "u", nature: "RAPPEL", sujet: "Rappel — réveil", corps: "debout", declarees: MOI,
      adresses: [MOI[0]!],
      transport: async (_o, _s, _c, adresses) => { vus.push(...(adresses ?? [])); return "envoye"; },
    });
    expect(r.issue).toBe("envoye");
    expect(vus).toEqual([MOI[0]]);
    expect(r.motif).toContain(MOI[0]!);
  });

  it("un transport qui échoue n'est jamais un succès silencieux", async () => {
    const r = await ecrireAuProprietaire({
      ownerId: "u", nature: "RAPPEL", sujet: "s", corps: "c", declarees: MOI,
      adresses: [MOI[0]!], transport: async () => "sans-boite",
    });
    expect(r.issue).toBe("sans-boite");
    expect(r.motif).toMatch(/aucune boîte/);
    expect(r.destinataires, "on ne prétend pas avoir écrit à quelqu'un").toEqual([]);
  });
});

describe("le module a un APPELANT de production — pas seulement des tests (§118.14, §118.47)", () => {
  /**
   * CE QUI FERAIT TOMBER CE TEST : perdre l'appel dans une édition, comme `daterLEntree` l'a
   * été (§118.47 — 53 étapes abouties, 2 332 reçus, ZÉRO entrée datée, et le test au vert sur
   * du code mort). On cherche donc le POINT D'APPEL, à l'endroit exact où il doit être.
   */
  it("le tir d'un rappel appelle `ecrireAuProprietaire` quand le canal demande l'e-mail", () => {
    const src = fs.readFileSync("src/lib/assistant/reminders.ts", "utf8");
    expect(src, "le canal n'est plus lu au moment du tir").toMatch(/r\.channel === "EMAIL"/);
    expect(src, "l'appel de production a disparu").toContain("ecrireAuProprietaire");
    expect(src, "la nature doit être RAPPEL, l'une des huit accordées").toMatch(/nature: "RAPPEL"/);
    // Et ce qui n'a pas pu partir doit être DIT : un e-mail promis, jamais reçu, sans un mot,
    // est pire que pas d'e-mail du tout.
    expect(src).toMatch(/E-mail non envoyé/);
  });

  it("`plan_reminder` OFFRE le canal — sinon le modèle continue d'inventer une impossibilité", () => {
    // §118.19 : ce que le code sait faire, le contexte doit dire comment le demander.
    const src = fs.readFileSync("src/lib/assistant/executive-tools/planification.ts", "utf8");
    expect(src).toMatch(/canal: \{\s*\n?\s*type: "string", enum: \["notification", "email", "les_deux"\]/);
    expect(src, "la description doit lever le doute, en toutes lettres").toMatch(/un e-mail différé est possible/);
  });

  it("aucun appelant de PRODUCTION ne souffle la liste déclarée à la garde", () => {
    // L'injection existe pour les tests. Le jour où du code de production passe `declarees`,
    // la garde ne vérifie plus rien : elle compare une liste à elle-même.
    const prod = ["src/lib/assistant/reminders.ts", "src/platform/in-process/missions/attention.ts"];
    for (const f of prod) {
      expect(fs.readFileSync(f, "utf8"), `${f} ne doit pas fournir les adresses déclarées`).not.toMatch(/declarees:/);
    }
  });

  it("il n'existe qu'UN transport vers le dirigeant — un second divergerait (§118.5)", () => {
    const attention = fs.readFileSync("src/platform/in-process/missions/attention.ts", "utf8");
    expect(attention, "la porte d'attention doit passer par le transport partagé")
      .toContain('from "@/platform/in-process/courrier/proprietaire"');
    expect(attention, "une seconde copie du transport est réapparue")
      .not.toMatch(/async function envoyerParBoiteConnectee\(/);
    expect(typeof envoyerParBoiteConnectee).toBe("function");
  });
});
