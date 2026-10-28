import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PRÉ-VALIDATION ET LA CLÔTURE D'UN SPONSORING — les POINTS D'APPEL (§118.151, §118.49).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `sponsoring-cloture-flow.test.ts` éprouve le parcours par les vrais points d'entrée. Une branche
 * lui échappe par construction : la déclaration d'information médicale n'est émise par le moteur
 * que lorsqu'un pharmacien ACTIF existe, et créer ce compte dans une suite parallèle ferait
 * tomber les bancs voisins qui cherchent LE pharmacien de la base. `montantADeclarer` y est donc
 * éprouvé seul — et ce banc-ci exige qu'il soit APPELÉ, à l'endroit exact où il doit l'être.
 * `daterLEntree` était écrite, commentée et testée par son corps, et son appel avait été perdu
 * dans une édition (§118.49) : vérifier une fonction sans son appelant ne prouve rien.
 *
 * Les commentaires sont retirés avant de juger : un cliquet qui cherche une forme trouve la
 * prose qui la décrit (§118.79d, §118.88, §118.112b).
 */
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const code = (rel: string) => sansCommentaires(fs.readFileSync(path.join(process.cwd(), rel), "utf8"));

/** Le corps d'une fonction de premier rang, jusqu'à la suivante. */
function corps(src: string, nom: string): string {
  const debut = src.search(new RegExp(`(?:export\\s+)?async\\s+function\\s+${nom}\\s*\\(`));
  expect(debut, `la fonction « ${nom} » doit exister`).toBeGreaterThanOrEqual(0);
  const reste = src.slice(debut + 1);
  const fin = reste.search(/\n(?:export\s+)?(?:async\s+)?function\s+\w+\s*[(<]/);
  return fin < 0 ? src.slice(debut) : src.slice(debut, debut + 1 + fin);
}

describe("le MOTEUR — ce qu'une étape qui conclut décide, et ce qu'elle déclare", () => {
  const moteur = code("src/lib/workflow/engine.ts");

  it("l'issue se lit sur la configuration de l'étape — dans la décision ET dans la projection", () => {
    // Deux lectures, une seule règle : la décision (émettre ou non) et la projection (le statut
    // écrit) doivent lire la même fonction, sinon une étape pourrait projeter PRE_VALIDATED tout
    // en émettant l'ordre global d'un accord à montant.
    // §118.197g : la décision juge l'étape EFFECTIVE (`lectureDeLApprobation` — celle qui conclut une route
    // coupée hérite des pouvoirs d'argent des étapes non atteintes), et la projection reçoit LA MÊME : lire
    // l'issue sur l'étape brute ici et sur l'étape effective là ferait diverger la décision et ce qu'elle projette.
    expect(moteur).toMatch(/etape\s*\}\s*=\s*lectureDeLApprobation\(/);
    // 27/10/2026 : la prévalidation vaut pour TOUTES les natures (sponsoring, PEC, événement) — l'issue se lit sur
    // l'étape seule, plus sur la nature de la demande.
    expect(moteur).toMatch(/argentDecideApres\s*=\s*conclut\s*&&\s*issueTerminaleSponsoring\(\s*etape\s*\)\s*===\s*"PRE_VALIDATED"/);
    expect(moteur).not.toMatch(/argentDecideApres\s*=\s*entityType\s*===\s*"SPONSORING"/);
    expect(moteur).toMatch(/await\s+projectApprove\(\s*entityType\s*,\s*entityId\s*,\s*etape\s*,/);
    expect(corps(moteur, "projectApprove")).toMatch(/issueTerminaleSponsoring\(\s*step\s*\)/);
  });

  it("emitFinancials DÉCLARE l'estimation des postes — l'appel est là, et sa valeur part dans la déclaration", () => {
    const f = corps(moteur, "emitFinancials");
    const appel = f.match(/const\s+(\w+)\s*=\s*await\s+montantADeclarer\(\s*entityType\s*,\s*entityId\s*,\s*amount\s*\)/);
    expect(appel, "emitFinancials doit appeler montantADeclarer(entityType, entityId, amount)").not.toBeNull();
    // La valeur calculée doit être CELLE qui part : un appel dont le résultat serait ignoré
    // (`amount` passé à la place) redéclarerait 0 DZD sur une tenue pré-validée.
    expect(f).toMatch(new RegExp(`createMedicalInfoDeclaration\\(\\{[\\s\\S]*?amount:\\s*${appel?.[1] ?? "__absent__"}\\b`));
  });

  it("la PREMIÈRE garde de montant laisse passer la déclaration d'une tenue pré-validée — et elle seule", () => {
    // Sans l'exception, une tenue pré-validée ne serait JAMAIS déclarée : son montant se fixe à la
    // clôture, APRÈS l'événement — qui aurait donc eu lieu sans déclaration.
    const f = corps(moteur, "emitFinancials");
    const iPremiere = f.search(/if\s*\(\s*!\(\s*amount\s*>\s*0\s*\)\s*&&\s*!step\.argentDecideApres\s*\)\s*return\s+null/);
    expect(iPremiere, "la première garde doit excepter la tenue pré-validée").toBeGreaterThanOrEqual(0);
    expect(iPremiere).toBeLessThan(f.indexOf("createMedicalInfoDeclaration("));
  });

  it("aucun ORDRE n'est émis sans montant fixé — la porte de la tenue ne laisse passer que la déclaration", () => {
    const f = corps(moteur, "emitFinancials");
    const iDecl = f.indexOf("createMedicalInfoDeclaration(");
    const iGarde = f.search(/if\s*\(\s*!\(\s*amount\s*>\s*0\s*\)\s*\)\s*return\s+null/);
    const iOrdre = f.indexOf("createExpenseOrder(");
    expect(iGarde, "la seconde garde de montant doit exister").toBeGreaterThan(iDecl);
    expect(iOrdre, "…et précéder l'émission d'un ordre").toBeGreaterThan(iGarde);
  });
});

describe("la VALIDATION d'une déclaration n'ajoute pas d'ordre global là où les postes paient", () => {
  it("validateDeclarationByDirection consulte les postes AVANT d'émettre, et l'émission en dépend", () => {
    const f = corps(code("src/lib/actions/medical-info-actions.ts"), "validateDeclarationByDirection");
    expect(f).toMatch(/const\s+parLesPostes\s*=\s*amount\s*>\s*0\s*&&\s*\(\s*await\s+laDepenseEstPorteeParLesPostes\(\s*decl\.sourceType\s*,\s*decl\.sourceId\s*\)\s*\)/);
    expect(f).toMatch(/amount\s*>\s*0\s*&&\s*!parLesPostes\s*\?\s*await\s+createExpenseOrder\(/);
  });
});

describe("le RÈGLEMENT d'un ordre ne solde qu'un accord GLOBAL", () => {
  it("la projection « payée » d'un sponsoring est CONDITIONNELLE à son statut, lu dans la même instruction", () => {
    const src = code("src/modules/finances/actions-depenses.ts");
    expect(src).toMatch(/sponsoringRequest\.updateMany\(\{\s*where:\s*\{\s*id:\s*order\.sourceId\s*,\s*status:\s*\{\s*in:\s*\[\.\.\.STATUTS_SOLDES_PAR_UN_REGLEMENT\]/);
    // Aucune autre écriture du statut « payé » d'un sponsoring ne contourne la garde.
    const inconditionnelles = [...src.matchAll(/sponsoringRequest\.update\(\s*\{[\s\S]{0,200}?status:\s*"PAID"/g)];
    expect(inconditionnelles, "une mise à jour sans condition repasserait une demande clôturée à « payée »").toHaveLength(0);
  });
});

describe("les SIX gestes de poste lisent la clôture — une porte gardée à côté d'une porte ouverte laisse passer la même chose (§118.71)", () => {
  const actions = code("src/lib/actions/ad-pro-item-actions.ts");
  const gestes: Array<[string, RegExp]> = [
    ["addAdProItem", /refusPostesClos\(\s*info\s*\)/],
    ["updateAdProItem", /refusSiClos\(\s*owner\.parent\s*,\s*owner\.id\s*\)/],
    ["deleteAdProItem", /refusSiClos\(\s*owner\.parent\s*,\s*owner\.id\s*\)/],
    // §118.187 : ces deux gestes FONT PARTIR un poste — la garde reçoit `{ partir }`, qui ajoute le refus
    // d'une demande refusée ou annulée. C'est la même garde, avec une option : la forme l'admet.
    ["submitAdProItem", /refusSiClos\(\s*owner\.parent\s*,\s*owner\.id\s*,\s*\{\s*partir:\s*true\s*\}\s*\)/],
    ["decideAdProItem", /refusSiClos\(\s*owner\.parent\s*,\s*owner\.id\s*,\s*\{\s*partir:\s*decision\s*===\s*"APPROVED"\s*\}\s*\)/],
    ["setAdProItemBudget", /refusSiClos\(\s*owner\.parent\s*,\s*owner\.id\s*\)/],
  ];
  for (const [nom, garde] of gestes) {
    it(`${nom} refuse sur une demande clôturée — et son refus est RENDU`, () => {
      const f = corps(actions, nom);
      const m = f.match(new RegExp(`const\\s+(\\w+)\\s*=\\s*(?:await\\s+)?${garde.source}`));
      expect(m, `${nom} doit appeler la garde de clôture`).not.toBeNull();
      // Un appel dont le refus n'est jamais rendu est une garde décorative (§118.17).
      expect(f).toMatch(new RegExp(`if\\s*\\(\\s*${m?.[1] ?? "__absent__"}\\s*\\)\\s*return\\s*\\{\\s*ok:\\s*false\\s*,\\s*error:\\s*${m?.[1] ?? "__absent__"}\\s*\\}`));
    });
  }

  it("La DEMANDE DE PAIEMENT d'un poste n'est PAS gardée par la clôture — l'exécution continue après la validation finale", () => {
    // L'autre moitié : arrêter les MONTANTS n'est pas arrêter les PAIEMENTS. Un poste accordé
    // dont l'ordre n'était pas parti doit pouvoir partir ; le garder ici laisserait le
    // fournisseur impayé derrière une demande « clôturée ».
    expect(corps(actions, "demanderPaiementPoste")).not.toMatch(/refusSiClos|refusPostesClos/);
  });
});

describe("la carte de RISQUE d'un sponsoring bloqué nomme celui qu'on attend VRAIMENT", async () => {
  /*
   * `AWAITING_FINAL` n'est plus la décision définitive de la Direction : c'est la pré-validation de la
   * TENUE par la Direction Marketing. Et `PRELIMINARY_APPROVED` couvre deux étapes. Une carte qui lit
   * le statut seul relance la mauvaise personne — et la bonne n'est jamais prévenue.
   */
  const { attenteSponsoring } = await import("@/lib/adventum/risks");

  it("l'étape courante du circuit décide — le DG et la Direction des opérations partagent le même statut projeté", () => {
    expect(attenteSponsoring("PRELIMINARY_APPROVED", "dg")).toMatchObject({ owner: "Directeur Général", role: "GENERAL_MANAGER" });
    expect(attenteSponsoring("PRELIMINARY_APPROVED", "final")).toMatchObject({ owner: "Direction des opérations", role: "DIRECTION" });
  });

  it("la pré-validation de la tenue attend la Direction Marketing — plus jamais « la décision définitive de la Direction »", () => {
    const a = attenteSponsoring("AWAITING_FINAL", "marketing");
    expect(a).toMatchObject({ owner: "Direction Marketing", role: "PRODUCT_MANAGER" });
    expect(a.cause).toMatch(/tenue/);
    // Sans instance lisible, le statut suffit ici : il ne désigne qu'une étape.
    expect(attenteSponsoring("AWAITING_FINAL", null)).toMatchObject({ owner: "Direction Marketing" });
  });

  it("sans étape lisible, un statut ambigu ne nomme PERSONNE au hasard", () => {
    const a = attenteSponsoring("PRELIMINARY_APPROVED", null);
    expect(a.owner).toBe("Circuit de validation");
    expect(a.cause).toMatch(/Directeur Général ou Direction des opérations/);
  });

  it("et le DÉTECTEUR lui passe l'étape du CIRCUIT — une fonction juste qu'on appellerait sans elle ne protège rien (§118.49)", () => {
    const f = corps(code("src/lib/adventum/risks.ts"), "sponsoringRisks");
    expect(f).toMatch(/workflowInstance\.findMany\(/);
    expect(f).toMatch(/attenteSponsoring\(\s*s\.status\s*,\s*etape\.get\(\s*s\.id\s*\)\s*\)/);
  });

  it("l'appel attend la Direction", () => {
    expect(attenteSponsoring("AWAITING_FINAL_APPEAL", "marketing")).toMatchObject({ owner: "Direction", role: "DIRECTION" });
  });
});
