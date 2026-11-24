import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTEUR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR, getCurrentUserPourEcrire: async () => ACTEUR }));
vi.mock("@/lib/drive/document-mirror", () => ({ mirrorDocumentsToDrive: async () => {} }));
vi.mock("@/lib/regulatory-drive-mirror", () => ({ mirrorRegulatoryUpload: async () => {} }));

// LA LECTURE EST SIMULÉE (jamais de vrai OCR ni de vrai modèle dans un banc) : le fichier « se lit » en un texte, et
// le modèle rend ce que chaque test a posé dans `REPONSE_IA`.
type Reponse = { ok: true; decision?: unknown; attestation?: unknown } | { ok: false; raison: string | null; cause: string | null; error: string };
let REPONSE_IA: Reponse = { ok: false, raison: "IA_COUPEE", cause: null, error: "coupée" };
vi.mock("@/lib/pieces-lues/lecture-fichier", () => ({
  lireFichierUneFois: async () => ({
    ok: true,
    lecture: {
      id: "lecture-banc", empreinte: "x", versionLecteur: 1, etat: "LUE", luParCetAppel: true, extension: "pdf", taille: 10,
      texte: "RÉPUBLIQUE ALGÉRIENNE — DÉCISION D'ENREGISTREMENT", methode: "texte", confiance: null, aRelire: false,
      ocrTente: false, ocrEchoue: false, raisonOcr: null, pagesLues: null, pagesTotal: null, caracteres: 48, tronque: false, moteur: null,
    },
  }),
}));
vi.mock("@/lib/lecture-pieces-ia", () => ({
  disponibiliteLecturePieces: async () => ({ disponible: false, raison: "DESACTIVEE", cause: null, phrase: "" }),
  lirePieceEnregistrementParModele: async () => (REPONSE_IA.ok
    ? { ok: true, decision: REPONSE_IA.decision ?? null, attestation: REPONSE_IA.attestation ?? null, modele: "banc" }
    : { ...REPONSE_IA, errorCode: null }),
}));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerDocumentsEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import {
  joindrePieceEnregistrement, relirePieceEnregistrement, confirmerValiditeEnregistrement, confirmerPrixAttestation,
} from "./regulatory-validite-actions";
import { lecturesDuDossier } from "@/lib/regulatory/decision-lue";
import { runRenouvellementSweep } from "@/lib/regulatory/renouvellement-sweep";
import { lignesRenouvellements } from "@/lib/queries/action-center-renouvellements";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__regenreg__";

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

const fichier = (nom: string) => new File([Buffer.from(`%PDF-1.4 ${nom} ${Math.random()}`)], nom, { type: "application/pdf" });

function fd(champs: Record<string, string | File>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  return f;
}

const decisionLue = (fin: string | null) => ({
  numero: { valeur: "245/DG/ANPP/2026", extrait: "Décision n° 245/DG/ANPP/2026", source: "LUE_IA" },
  dateDecision: { valeur: "2026-03-15", extrait: "Alger, le 15/03/2026", source: "LUE_IA" },
  debut: null,
  fin: fin ? { valeur: fin, extrait: `valable jusqu'au ${fin}`, source: "LUE_IA" } : null,
});

suite("Regulatory — décision d'enregistrement : pièces, lecture IA, validité, renouvellement", () => {
  let chefId = "", assistanteId = "", lecteurId = "", dossierId = "", produitId = "";

  beforeAll(async () => {
    const [chef, assistante, lecteur] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}chef`, email: `${TAG}chef@t.dz`, role: "HEAD_OF_REGULATORY", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}assistante`, email: `${TAG}assistante@t.dz`, role: "REGULATORY_ASSISTANT", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}lecteur`, email: `${TAG}lecteur@t.dz`, role: "VIEWER", passwordHash: "x" } }),
    ]);
    chefId = chef.id; assistanteId = assistante.id; lecteurId = lecteur.id;
    const produit = await prisma.product.create({
      data: { code: `${TAG}PRD-1`, canonicalName: `${TAG} Bictegravir 50 mg`, dci: `${TAG} Bictegravir`, identityKey: `${TAG}cle-1` },
    });
    produitId = produit.id;
    const d = await prisma.regulatoryProduct.create({
      data: { reference: `${TAG}-REG-001`, dci: `${TAG} Bictegravir`, status: "AWAITING_ANPP", responsibleId: assistanteId, productId: produitId },
    });
    dossierId = d.id;
  });

  beforeEach(() => { REPONSE_IA = { ok: false, raison: "IA_COUPEE", cause: null, error: "coupée" }; });

  afterAll(async () => {
    await retirerDocumentsEtContenu({ where: { entityType: "REGULATORY_PRODUCT", entityId: dossierId } }).catch(() => {});
    await prisma.productPrice.deleteMany({ where: { productId: produitId } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { link: { contains: dossierId } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [dossierId, produitId] } } }).catch(() => {});
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.product.deleteMany({ where: { code: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("droits : sans « Déposer » ni « Modifier » sur Regulatory, rien ne se joint ni ne se confirme", async () => {
    ACTEUR = await acteur(lecteurId, "VIEWER");
    const j = await joindrePieceEnregistrement(fd({ productId: dossierId, nature: "DECISION", file: fichier("de.pdf") }));
    expect(j.ok).toBe(false);
    const c = await confirmerValiditeEnregistrement(fd({ productId: dossierId, dateDecision: "2026-03-15" }));
    expect(c.ok).toBe(false);
    expect(await prisma.document.count({ where: { entityType: "REGULATORY_PRODUCT", entityId: dossierId } })).toBe(0);
  });

  it("IA coupée : la décision est jointe quand même, la proposition le dit, la saisie reste ouverte", async () => {
    ACTEUR = await acteur(chefId, "HEAD_OF_REGULATORY");
    const r = await joindrePieceEnregistrement(fd({ productId: dossierId, nature: "DECISION", file: fichier("decision-coupee.pdf") }));
    expect(r.ok).toBe(true);
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: r.id! } });
    expect(doc.category).toBe("REGISTRATION_DECISION");
    expect(doc.stepKey).toBe("decision");
    expect(doc.confidentiality).toBe("INTERNAL");
    const p = await prisma.regulatoryProduct.findUniqueOrThrow({ where: { id: dossierId } });
    const l = lecturesDuDossier(p.registrationReading);
    expect(l.decision?.erreur).toMatch(/IA est coupée.*saisissez/);
    expect(l.decision?.fin).toBeNull();
    expect(p.registrationValidUntil).toBeNull();
  });

  it("upload de la décision → dates PROPOSÉES (fin manquante déduite +5 ans) → confirmées d'un clic", async () => {
    ACTEUR = await acteur(chefId, "HEAD_OF_REGULATORY");
    REPONSE_IA = { ok: true, decision: decisionLue(null) };
    const r = await joindrePieceEnregistrement(fd({ productId: dossierId, nature: "DECISION", file: fichier("decision.pdf") }));
    expect(r.ok).toBe(true);

    // Proposé, PAS écrit : la validité du dossier reste vide tant qu'une personne n'a pas confirmé.
    let p = await prisma.regulatoryProduct.findUniqueOrThrow({ where: { id: dossierId } });
    expect(p.registrationValidUntil).toBeNull();
    const prop = lecturesDuDossier(p.registrationReading).decision!;
    expect(prop.erreur).toBeNull();
    expect(prop.dateDecision?.valeur).toBe("2026-03-15");
    expect(prop.debut?.valeur).toBe("2026-03-15");
    expect(prop.fin).toEqual({ valeur: "2031-03-15", extrait: null, source: "DEDUITE" });

    // Le clic : l'écran renvoie les valeurs proposées telles quelles.
    const c = await confirmerValiditeEnregistrement(fd({
      productId: dossierId, numero: prop.numero!.valeur, dateDecision: prop.dateDecision!.valeur, debut: prop.debut!.valeur, fin: prop.fin!.valeur,
    }));
    expect(c.ok).toBe(true);
    p = await prisma.regulatoryProduct.findUniqueOrThrow({ where: { id: dossierId } });
    expect(p.registrationDecisionNumber).toBe("245/DG/ANPP/2026");
    expect(p.registrationDecisionSource).toBe("LUE_IA");
    expect(p.registrationValidFrom?.toISOString().slice(0, 10)).toBe("2026-03-15");
    expect(p.registrationValidUntil?.toISOString().slice(0, 10)).toBe("2031-03-15");
    expect(p.registrationValidUntilSource).toBe("DEDUITE");
    expect(p.registrationConfirmedById).toBe(chefId);
    expect(lecturesDuDossier(p.registrationReading).decision).toBeUndefined();
    // L'étape 19 est cochée, datée de la décision — et le niveau de process la suit.
    expect((p.workflow as Record<string, { status: string; date?: string }>).decision).toMatchObject({ status: "DONE", date: "2026-03-15" });
  });

  it("toujours modifiable : une fin corrigée à la main devient « saisie »", async () => {
    ACTEUR = await acteur(chefId, "HEAD_OF_REGULATORY");
    const c = await confirmerValiditeEnregistrement(fd({ productId: dossierId, numero: "245/DG/ANPP/2026", dateDecision: "2026-03-15", debut: "2026-03-15", fin: "2031-01-31" }));
    expect(c.ok).toBe(true);
    const p = await prisma.regulatoryProduct.findUniqueOrThrow({ where: { id: dossierId } });
    expect(p.registrationValidUntil?.toISOString().slice(0, 10)).toBe("2031-01-31");
    expect(p.registrationValidUntilSource).toBe("SAISIE");
    expect(p.registrationDecisionSource).toBe("SAISIE");
  });

  it("une décision dont la fin est imprimée : la fin est LUE, pas déduite ; la relecture d'une pièce jointe propose à nouveau", async () => {
    ACTEUR = await acteur(chefId, "HEAD_OF_REGULATORY");
    REPONSE_IA = { ok: true, decision: decisionLue("2031-03-14") };
    const doc = await prisma.document.findFirstOrThrow({ where: { entityId: dossierId, category: "REGISTRATION_DECISION", name: "decision.pdf" } });
    const r = await relirePieceEnregistrement(fd({ productId: dossierId, documentId: doc.id, nature: "DECISION" }));
    expect(r.ok).toBe(true);
    const p = await prisma.regulatoryProduct.findUniqueOrThrow({ where: { id: dossierId } });
    expect(lecturesDuDossier(p.registrationReading).decision?.fin).toMatchObject({ valeur: "2031-03-14", source: "LUE_IA" });
  });

  it("attestation de prix → prix PROPOSÉ → confirmé : une ligne de prix datée sur le produit du dossier", async () => {
    ACTEUR = await acteur(chefId, "HEAD_OF_REGULATORY");
    REPONSE_IA = { ok: true, attestation: { date: { valeur: "2026-04-02", extrait: "Alger le 02/04/2026", source: "LUE_IA" }, prix: [{ type: "PPA", valeur: 1234.5, extrait: "PPA : 1 234,50 DA", source: "LUE_IA" }] } };
    const r = await joindrePieceEnregistrement(fd({ productId: dossierId, nature: "PRIX", file: fichier("attestation.pdf") }));
    expect(r.ok).toBe(true);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: r.id! } })).category).toBe("PRICE_ATTESTATION");
    expect(await prisma.productPrice.count({ where: { productId: produitId } })).toBe(0);

    const c = await confirmerPrixAttestation(fd({ productId: dossierId, kind: "PPA", amountDzd: "1234,50", validFrom: "2026-04-02" }));
    expect(c.ok).toBe(true);
    const prix = await prisma.productPrice.findMany({ where: { productId: produitId } });
    expect(prix).toHaveLength(1);
    expect(Number(prix[0].amountDzd)).toBe(1234.5);
    expect(prix[0].kind).toBe("PPA");
    expect(prix[0].validFrom.toISOString().slice(0, 10)).toBe("2026-04-02");
    const p = await prisma.regulatoryProduct.findUniqueOrThrow({ where: { id: dossierId } });
    expect(lecturesDuDossier(p.registrationReading).prix).toBeUndefined();
  });

  it("alerte de renouvellement : à 12 mois, UNE fois par palier, au chef et au responsable ; puis 6 mois ; « Aujourd'hui » au rouge si expirée", async () => {
    await prisma.regulatoryProduct.update({ where: { id: dossierId }, data: { registrationValidUntil: new Date("2031-03-15T00:00:00Z"), renewalAlertTier: null, renewalAlertUntil: null } });
    const compte = () => prisma.notification.count({ where: { link: `/regulatory/${dossierId}#enregistrement`, userId: { in: [chefId, assistanteId] } } });

    await runRenouvellementSweep(new Date("2030-02-01T10:00:00Z")); // avant le premier palier
    expect(await compte()).toBe(0);

    await runRenouvellementSweep(new Date("2030-03-20T10:00:00Z"));
    expect(await compte()).toBe(2);
    await runRenouvellementSweep(new Date("2030-04-20T10:00:00Z")); // même palier : rien de plus
    expect(await compte()).toBe(2);
    let p = await prisma.regulatoryProduct.findUniqueOrThrow({ where: { id: dossierId } });
    expect(p.renewalAlertTier).toBe(12);

    await runRenouvellementSweep(new Date("2030-09-20T10:00:00Z"));
    expect(await compte()).toBe(4);
    p = await prisma.regulatoryProduct.findUniqueOrThrow({ where: { id: dossierId } });
    expect(p.renewalAlertTier).toBe(6);

    // Le lecteur, qui ne voit pas le dossier, n'est jamais prévenu.
    expect(await prisma.notification.count({ where: { userId: lecteurId } })).toBe(0);

    const chef = await acteur(chefId, "HEAD_OF_REGULATORY");
    const avant = await lignesRenouvellements(chef, new Date("2030-09-20T10:00:00Z"));
    expect(avant.find((l) => l.href.includes(dossierId))?.statusLabel).toBe("À renouveler");
    const apres = await lignesRenouvellements(chef, new Date("2031-04-01T10:00:00Z"));
    const ligne = apres.find((l) => l.href.includes(dossierId))!;
    expect(ligne.statusLabel).toBe("Expirée");
    expect(ligne.statusTone).toBe("danger");
    // Le responsable du dossier l'a aussi dans son « Aujourd'hui ».
    const sienne = await lignesRenouvellements(await acteur(assistanteId, "REGULATORY_ASSISTANT"), new Date("2030-09-20T10:00:00Z"));
    expect(sienne.some((l) => l.href.includes(dossierId))).toBe(true);
  });
});
