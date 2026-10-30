import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { demandeLongue, outilLancerUnTravail } from "@/platform/ia/travaux/outil";

describe("l'outil « lancer_un_travail » (socle IA, J2)", () => {
  it("ne propose qu'au nom de SA personne, rend les fautes au modèle, ne dit jamais que c'est fait", async () => {
    const plans: unknown[] = [];
    const o = outilLancerUnTravail("u1", async (p) => {
      plans.push(p);
      return (p as { titre?: string }).titre ? { ok: true, travailId: "t1", etapes: 3, gestes: ["Relance"], plafondUsd: 20 } : { ok: false, fautes: ["Titre manquant."] };
    });
    expect(o.allowed({ id: "u2" })).toBe(false);
    expect(JSON.parse(await o.run({ titre: "x" }, { id: "u2" })).statut).toBe("REFUS");
    expect(plans).toHaveLength(0);
    expect(JSON.parse(await o.run({}, { id: "u1" }))).toMatchObject({ statut: "PLAN_REFUSE", fautes: ["Titre manquant."] });
    const ok = JSON.parse(await o.run({ titre: "x" }, { id: "u1" }));
    expect(ok).toMatchObject({ statut: "EN_ATTENTE_D_APPROBATION", travailId: "t1" });
    expect(ok.consigne).toMatch(/Ne dis jamais que c'est fait/);
  });

  it("l'indice « travail long » : volume, période, relance conditionnelle — pas une question simple", () => {
    expect(demandeLongue("Analyse toutes les demandes Ad & Pro de l'année")).toBe(true);
    expect(demandeLongue("Relance l'agence si pas de réponse sous 48 h")).toBe(true);
    expect(demandeLongue("Préviens-moi quand le BC sera signé")).toBe(true);
    expect(demandeLongue("Demande à Karim le devis signé, attends sa réponse puis fais le BC")).toBe(true);
    expect(demandeLongue("Quel est le numéro de Karim ?")).toBe(false);
  });

  it("le socle n'importe RIEN — ni Adam, ni l'Assistant IA, ni l'ERP (le moteur est injecté)", () => {
    for (const f of fs.readdirSync("src/platform/ia/travaux").filter((x) => /\.ts$/.test(x) && !x.endsWith(".test.ts"))) {
      expect(fs.readFileSync(`src/platform/ia/travaux/${f}`, "utf8"), f).not.toMatch(/^\s*import\s/m);
    }
  });
});
