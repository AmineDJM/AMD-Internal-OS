import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  estDecisionDApprobation, exigeMotif, refusSansMotif, interditSurSaPropreDemande, LIBELLE_DECISION, libelleMotif, decideurAffiche,
  peutTrancherApprobation, refusValidateursPieceChiffree,
} from "./decision-approbation";

/**
 * TRANCHER UNE VALIDATION AU SECRÉTARIAT — la règle pure, et l'endroit exact où chaque écran la lit
 * (lot E5 — audit des managers, M14 et M15). Les points d'appel se lisent dans la source SANS ses
 * commentaires (§118.79d) : une règle juste que personne n'appelle ne protège rien (§118.49).
 */
const sans = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
/** Le corps d'une fonction exportée : de sa déclaration à la suivante. */
const corps = (src: string, debut: string) => {
  const i = src.indexOf(debut);
  expect(i, `introuvable : ${debut}`).toBeGreaterThanOrEqual(0);
  const j = src.indexOf("\nexport ", i + debut.length);
  return src.slice(i, j < 0 ? undefined : j);
};

describe("La règle d'une décision d'approbation", () => {
  it("trois décisions se lisent — et rien d'autre", () => {
    for (const d of ["APPROVED", "REJECTED", "CHANGES_REQUESTED"]) expect(estDecisionDApprobation(d), d).toBe(true);
    for (const d of ["PENDING", "", "approved", "FOO", null, undefined]) expect(estDecisionDApprobation(d as string | null), String(d)).toBe(false);
  });

  it("refuser et demander une modification exigent un motif ; valider, non", () => {
    expect(exigeMotif("APPROVED")).toBe(false);
    expect(exigeMotif("REJECTED")).toBe(true);
    expect(exigeMotif("CHANGES_REQUESTED")).toBe(true);
  });

  it("le refus sans motif dit ce qu'il faut écrire — et se tait quand le motif est là", () => {
    expect(refusSansMotif("REJECTED", null)).toBe("Dites pourquoi vous refusez : c'est ce que lira le demandeur.");
    expect(refusSansMotif("CHANGES_REQUESTED", null)).toBe("Dites ce qu'il faut modifier : c'est ce que lira le demandeur.");
    expect(refusSansMotif("APPROVED", null)).toBeNull();
    expect(refusSansMotif("REJECTED", "Hors budget.")).toBeNull();
    expect(refusSansMotif("CHANGES_REQUESTED", "Préciser la référence.")).toBeNull();
  });

  it("on ne tranche pas sa propre demande — sauf au sommet", () => {
    expect(interditSurSaPropreDemande({ estDemandeur: true, sommet: false })).toBe(true);
    expect(interditSurSaPropreDemande({ estDemandeur: true, sommet: true })).toBe(false);
    expect(interditSurSaPropreDemande({ estDemandeur: false, sommet: false })).toBe(false);
    expect(interditSurSaPropreDemande({ estDemandeur: false, sommet: true })).toBe(false);
  });

  it("les libellés que lit le demandeur ne sont ni abrégés ni bruts", () => {
    expect(LIBELLE_DECISION).toEqual({ APPROVED: "Validation accordée", REJECTED: "Validation refusée", CHANGES_REQUESTED: "Modification demandée" });
    expect(libelleMotif("REJECTED")).toBe("Motif du refus");
    expect(libelleMotif("CHANGES_REQUESTED")).toBe("À modifier");
    expect(libelleMotif("APPROVED")).toBe("Note");
  });

  it("qui a tranché : son nom, ou « auteur inconnu » — jamais le validateur nommé à sa place", () => {
    expect(decideurAffiche({ status: "PENDING", decidedAt: null, decidedByName: null })).toBeNull();
    expect(decideurAffiche({ status: "APPROVED", decidedAt: null, decidedByName: "X" })).toBeNull();
    expect(decideurAffiche({ status: "APPROVED", decidedAt: new Date(), decidedByName: "Nadia" })).toBe("Décision prise par Nadia");
    expect(decideurAffiche({ status: "REJECTED", decidedAt: "2026-10-01T10:00:00Z", decidedByName: null })).toBe("Décision prise — auteur inconnu");
  });
});

describe("Points d'appel — l'action, les écrans, la liste, la fin d'un achat", () => {
  const action = sans("src/lib/actions/admin-request-actions.ts");
  const decide = corps(action, "export async function decideApproval");

  it("L'ÉTAT D'ABORD, LE MOTIF ENSUITE : le motif s'exige APRÈS la garde « déjà tranchée »", () => {
    const garde = decide.indexOf(`approval.status !== "PENDING"`);
    const motif = decide.indexOf("refusSansMotif(decision, note)");
    expect(garde).toBeGreaterThan(0);
    expect(motif).toBeGreaterThan(garde);
    expect(decide).toMatch(/interditSurSaPropreDemande\(\{ estDemandeur: approval\.request\.requesterId === user\.id, sommet: isTopManagement\(user\) \}\)/);
    expect(decide).toMatch(/!estDecisionDApprobation\(decision\)/);
  });

  it("LA PRISE porte son auteur et sa parole, sous condition de l'approbation ET de sa demande — et n'écrit plus `comment`", () => {
    const prise = decide.slice(decide.indexOf("prisma.adminApproval.updateMany("), decide.indexOf("if (pris.count === 0)"));
    expect(prise).toMatch(/status: "PENDING", request: \{ deletedAt: null, status: \{ not: "CANCELLED" \} \}/);
    expect(prise).toMatch(/decidedById: user\.id/);
    expect(prise).toMatch(/decisionNote: note/);
    expect(prise).not.toMatch(/comment:/);
  });

  it("UNE ANNULATION PENDANT LA DÉCISION fait annuler l'ordre émis (R2)", () => {
    expect(decide).toMatch(/if \(suivie\.count === 0 && ordre\)/);
    expect(decide).toMatch(/annulerOrdreNonRegle\(ordre\.id,/);
  });

  it("LA FIN D'UN ACHAT lit la facture là où l'écran la range — par la règle des ordres", () => {
    const fin = corps(action, "export async function finishRequest");
    expect(fin).toMatch(/await ficheAFacture\(\{ entityType: "ADMIN_REQUEST", entityId: id \}\)/);
    expect(fin).not.toMatch(/category: "INVOICE"/);
    expect(sans("src/modules/finances/infra/facture-ordre.ts")).toMatch(/fichesAvecFacture\(sources\)/);
  });

  it("LA FICHE dit qui a tranché, et n'offre pas les boutons sur sa propre demande", () => {
    const fiche = sans("src/app/(app)/demandes/[id]/page.tsx");
    expect(fiche).toMatch(/decidedBy: \{ select: \{ name: true \} \}/);
    expect(fiche).toMatch(/decideurAffiche\(\{ status: a\.status, decidedAt: a\.decidedAt, decidedByName: a\.decidedBy\?\.name \?\? null \}\)/);
    expect(fiche).toMatch(/!interditSurSaPropreDemande\(\{ estDemandeur: req\.requesterId === user\.id, sommet: isTopManagement\(user\) \}\)/);
  });

  it("LA LISTE « à valider » ne propose plus sa propre demande — même règle", () => {
    const liste = corps(sans("src/lib/queries/admin-requests.ts"), "export async function getApprovals");
    expect(liste).toMatch(/interditSurSaPropreDemande\(\{ estDemandeur: true, sommet: isTopManagement\(user\) \}\)/);
    expect(liste).toMatch(/AND: \[\{ status: "PENDING" \}, pasLaSienne\]/);
  });

  it("LE JOURNAL ne retombe plus sur `comment` quand le geste n'a pas de note", () => {
    const journal = sans("src/lib/general-means/purchase-journal.ts");
    expect(journal).toMatch(/note: input\.note \?\? null,/);
    expect(journal).not.toMatch(/decision\?\.comment/);
  });

  it("LES BOUTONS exigent le motif, lisent le refus de l'action, et suivent leur rafraîchissement", () => {
    const boutons = sans("src/app/(app)/demandes/approval-buttons.tsx");
    expect(boutons).toMatch(/if \(exigeMotif\(decision\)\) fd\.set\("comment", motif\.trim\(\)\)/);
    expect(boutons).toMatch(/disabled=\{ferme \|\| motif\.trim\(\) === ""\}/);
    expect(boutons).toMatch(/setErreur\(r\.error/);
    expect(boutons).toMatch(/useRafraichir\(\)/);
    expect(boutons).not.toMatch(/router\.refresh\(\)/);
  });

  it("LE RÈGLEMENT ne ressuscite pas une demande terminée ou annulée (E5-4)", () => {
    const reglement = sans("src/modules/finances/actions-depenses.ts");
    const branche = reglement.slice(reglement.indexOf(`order.sourceType === "ADMIN_REQUEST"`), reglement.indexOf(`order.sourceType === "PAYROLL"`));
    expect(branche).toMatch(/administrativeRequest\.updateMany\(\{\s*where: \{ id: order\.sourceId, deletedAt: null, status: \{ notIn: \["DONE", "CANCELLED"\] \} \}/);
  });
});

describe("La migration — deux colonnes, une clé étrangère, aucun rattrapage", () => {
  const sql = readFileSync("prisma/migrations/20270103090500_approbation_decideur_motif/migration.sql", "utf8");
  const code = sql.replace(/--.*$/gm, "");

  it("ajoute les deux colonnes, idempotente", () => {
    expect(code).toMatch(/ALTER TABLE "AdminApproval" ADD COLUMN IF NOT EXISTS "decidedById" TEXT;/);
    expect(code).toMatch(/ALTER TABLE "AdminApproval" ADD COLUMN IF NOT EXISTS "decisionNote" TEXT;/);
  });

  it("la clé étrangère met l'auteur à vide si son compte disparaît — la décision reste", () => {
    expect(code).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'AdminApproval_decidedById_fkey'\)/);
    expect(code).toMatch(/FOREIGN KEY \("decidedById"\) REFERENCES "User"\("id"\) ON DELETE SET NULL/);
  });

  it("n'attribue aucune décision passée par ressemblance (§118.36)", () => {
    // Une instruction UPDATE — pas la clause `ON UPDATE CASCADE` de la clé étrangère.
    expect(code).not.toMatch(/^\s*UPDATE\s/m);
  });
});

describe("audit du 14/10/2026 — qui tranche, qui valide une pièce chiffrée", () => {
  it("seuls le validateur, son intérimaire ou le sommet tranchent", () => {
    expect(peutTrancherApprobation({ estValidateur: true, parInterim: false, sommet: false })).toBe(true);
    expect(peutTrancherApprobation({ estValidateur: false, parInterim: true, sommet: false })).toBe(true);
    expect(peutTrancherApprobation({ estValidateur: false, parInterim: false, sommet: true })).toBe(true);
    expect(peutTrancherApprobation({ estValidateur: false, parInterim: false, sommet: false }), "le droit « Valider » ne suffit plus").toBe(false);
  });
  it("une pièce chiffrée écarte le soumetteur, le demandeur et la traitante ; sans montant, rien n'est écarté", () => {
    const base = { soumetteurId: "s", demandeurId: "d", traitanteId: "t" };
    for (const v of ["s", "d", "t"]) expect(refusValidateursPieceChiffree({ ...base, montant: 1000, validateurs: [v, "x"] })).not.toBeNull();
    expect(refusValidateursPieceChiffree({ ...base, montant: 1000, validateurs: ["x"] })).toBeNull();
    expect(refusValidateursPieceChiffree({ ...base, montant: null, validateurs: ["s"] })).toBeNull();
    expect(refusValidateursPieceChiffree({ ...base, montant: 0, validateurs: ["d"] })).toBeNull();
  });
});
