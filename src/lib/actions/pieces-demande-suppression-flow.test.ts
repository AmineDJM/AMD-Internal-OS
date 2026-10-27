import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { supprimerReversible } from "@/lib/suppression/coeur";
import { chargerPiecesLegalDeLaDemande } from "@/lib/queries/pieces-legal-demande";
import { chargerPiecesLiees } from "@/lib/queries/chaine-des-pieces";
import {
  apercuSuppressionPieceDeLaDemande, supprimerFichierDePieceDeLaDemande, supprimerPieceDeLaDemande,
} from "./ad-pro-pieces-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__pdsup__";

const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

// Le rôle et le rôle secondaire se lisent EN BASE (la matrice fait foi, aucun accès forgé) : le second
// argument n'est qu'un repère de lecture pour le test.
async function actorFor(id: string, _repere?: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role);
  return { id, name: u.name, email: u.email, role: u.role, secondaryRole: u.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * SUPPRIMER UNE PIÈCE LEGAL OU L'UN DE SES FICHIERS DEPUIS LA DEMANDE AD & PRO (§118.209).
 *
 * « On doit pouvoir supprimer les documents dans les demandes Ad & Pro » (Direction, 05/10). Quatre
 * propriétés, prouvées par les VRAIS points d'entrée — les actions, les chargeurs de l'écran, le cœur
 * de suppression — avec des acteurs SANS vue globale (§118.104) :
 *
 *   1. le bouton offert est un geste ACCEPTÉ (§118.83) : le chargeur et l'action lisent la même décision ;
 *   2. la personne doit pouvoir MODIFIER la demande ET gérer la pièce — la double garde de §118.109 ;
 *   3. JAMAIS ce qui engage : signée, validée par un centre, réglée, base d'une autre pièce, portée par un
 *      poste — et même le Super Admin n'y passe pas (le refus vit chez l'écrivain, §118.106) ;
 *   4. la pièce est RÉVERSIBLE (corbeille), ses fichiers se suppriment comme dans Legal.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("supprimer une pièce Legal d'une demande Ad & Pro (flux réel)", () => {
  let adminId = "", gestId = "", sansDemandeId = "", sansDeleteId = "", createurId = "";
  let spo = "", autreSpo = "", poste = "";
  let devisLibre = "", devisAvecBC = "", bcDuDevis = "", bcSigne = "", bcValide = "", bcEnAttente = "", factureReglee = "";
  let devisDuPoste = "", conventionDuCreateur = "", ailleurs = "", devisSansFichier = "";
  let fichierDevisLibre = "", fichierDevisAvecBC = "", fichierBcSigne = "", fichierFacture = "";

  const piece = (suffix: string, kind: string, extra: Record<string, unknown> = {}, source: { type: "SPONSORING"; id: string } = { type: "SPONSORING", id: spo }) =>
    prisma.legalDocument.create({
      data: {
        title: `${TAG}${suffix}`, reference: `${TAG}${suffix}`, kind: kind as never, status: "ACTIVE",
        sourceType: source.type, sourceId: source.id, createdById: gestId, amount: 100_000, ...extra,
      },
      select: { id: true },
    }).then((d) => d.id);
  const fichier = (nom: string, entityId: string) =>
    prisma.document.create({
      data: { name: `${TAG}${nom}`, category: "OTHER", entityType: "LEGAL_DOCUMENT", entityId, uploadedById: gestId },
      select: { id: true },
    }).then((d) => d.id);
  const existe = (id: string) => prisma.legalDocument.findUnique({ where: { id }, select: { id: true } }).then((d) => d !== null);
  const existeFichier = (id: string) => prisma.document.findUnique({ where: { id }, select: { id: true } }).then((d) => d !== null);

  const nettoyer = async () => {
    const ids = (await prisma.legalDocument.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } })).map((d) => d.id);
    await prisma.deletedRecord.deleteMany({ where: { kind: "LEGAL_DOCUMENT", name: { contains: TAG } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.adProItemPiece.deleteMany({ where: { legalDocumentId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    // Les pièces en aval pointent vers leur amont : les suites d'abord.
    await prisma.legalDocument.deleteMany({ where: { id: { in: ids }, chainFromId: { not: null } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { label: { startsWith: TAG } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((u) => u.id);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
  };

  beforeAll(async () => {
    await nettoyer();
    const mk = (s: string, role: SessionUser["role"], secondaryRole: SessionUser["role"] | null = null) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role, secondaryRole, passwordHash: "x" } });
    // Les droits viennent de la MATRICE des rôles (jamais d'un accès forgé), et aucun acteur n'a la vue globale :
    //  • la gestionnaire : l'assistante de direction (Legal : gérer) + Direction Marketing en secondaire (Sponsoring : gérer) ;
    //  • sans demande : l'assistante de direction seule — gère Legal, n'a aucun droit sur le Sponsoring ;
    //  • sans « supprimer » : le Directeur des Opérations (Legal : contribuer, jamais supprimer) + Direction Marketing ;
    //  • la créatrice : même profil, mais AUTEURE de sa convention (la règle de la fiche Legal).
    adminId = (await mk("admin", "SUPER_ADMIN")).id;
    gestId = (await mk("gest", "DIRECTION_ASSISTANT", "PRODUCT_MANAGER")).id;
    sansDemandeId = (await mk("sans-demande", "DIRECTION_ASSISTANT")).id;
    sansDeleteId = (await mk("sans-delete", "OPERATIONS_DIRECTOR", "PRODUCT_MANAGER")).id;
    createurId = (await mk("createur", "OPERATIONS_DIRECTOR", "PRODUCT_MANAGER")).id;

    spo = (await prisma.sponsoringRequest.create({ data: { reference: `${TAG}SPO-1`, institution: `${TAG}CHU`, type: "Congrès", createdById: adminId } })).id;
    autreSpo = (await prisma.sponsoringRequest.create({ data: { reference: `${TAG}SPO-2`, institution: `${TAG}EPH`, type: "Congrès", createdById: adminId } })).id;
    poste = (await prisma.adProItem.create({ data: { sponsoringId: spo, kind: "OTHER", label: `${TAG}Imprimerie` } })).id;

    devisLibre = await piece("Devis libre", "QUOTE");
    fichierDevisLibre = await fichier("devis-libre.pdf", devisLibre);
    await prisma.comment.create({ data: { entityType: "LEGAL_DOCUMENT", entityId: devisLibre, authorId: gestId, body: `${TAG}note` } }).catch(() => {});
    devisSansFichier = await piece("Devis sans fichier", "QUOTE");
    devisAvecBC = await piece("Devis avec BC", "QUOTE");
    fichierDevisAvecBC = await fichier("devis-avec-bc.pdf", devisAvecBC);
    bcDuDevis = await piece("BC du devis", "PURCHASE_ORDER", { chainFromId: devisAvecBC });
    bcSigne = await piece("BC signé", "PURCHASE_ORDER", { signedAt: new Date(), signedById: adminId });
    fichierBcSigne = await fichier("bc-signe.pdf", bcSigne);
    bcValide = await piece("BC validé", "PURCHASE_ORDER");
    await prisma.adProGateVisa.create({ data: { entityType: "LEGAL_DOCUMENT", entityId: bcValide, status: "APPROVED", amount: 100_000 } });
    bcEnAttente = await piece("BC en attente", "PURCHASE_ORDER");
    await prisma.adProGateVisa.create({ data: { entityType: "LEGAL_DOCUMENT", entityId: bcEnAttente, status: "PENDING", amount: 100_000 } });
    factureReglee = await piece("Facture réglée", "INVOICE", { paidDate: new Date(), direction: "OUT" });
    fichierFacture = await fichier("facture.pdf", factureReglee);
    devisDuPoste = await piece("Devis du poste", "QUOTE");
    await prisma.adProItemPiece.create({ data: { itemId: poste, legalDocumentId: devisDuPoste, nature: "DEVIS" } });
    conventionDuCreateur = await piece("Convention du créateur", "AGREEMENT", { createdById: createurId });
    ailleurs = await piece("Devis ailleurs", "QUOTE", {}, { type: "SPONSORING", id: autreSpo });
  });

  afterAll(nettoyer);

  // ─── PRÉMISSES — sans elles, les refus pourraient venir d'ailleurs (§118.104) ─────────────────
  it("PRÉMISSES : personne n'a la vue globale ; chaque acteur a exactement les droits que son cas suppose", async () => {
    const [gest, sansDemande, sansDelete, createur] = await Promise.all([
      actorFor(gestId, "VIEWER"), actorFor(sansDemandeId, "VIEWER"), actorFor(sansDeleteId, "VIEWER"), actorFor(createurId, "VIEWER"),
    ]);
    for (const a of [gest, sansDemande, sansDelete, createur]) expect(hasGlobalView(a.role)).toBe(false);
    expect([userCan(gest, "LEGAL", "DELETE"), await canAccessEntity(gest, "SPONSORING", spo, "UPDATE")], "la gestionnaire").toEqual([true, true]);
    expect([userCan(sansDemande, "LEGAL", "DELETE"), await canAccessEntity(sansDemande, "SPONSORING", spo, "UPDATE")], "sans la demande").toEqual([true, false]);
    expect([userCan(sansDelete, "LEGAL", "DELETE"), await canAccessEntity(sansDelete, "SPONSORING", spo, "UPDATE")], "sans le droit supprimer").toEqual([false, true]);
    expect([userCan(createur, "LEGAL", "DELETE"), await canAccessEntity(createur, "SPONSORING", spo, "UPDATE")], "l'auteure").toEqual([false, true]);
  });

  // ─── L'ÉCRAN : le bouton offert est un geste accepté ───────────────────────────────────────────
  it("L'ÉCRAN lit la décision : la pièce libre est offerte, ce qui engage est refusé AVEC sa raison et le geste qui reste", async () => {
    const gest = await actorFor(gestId, "VIEWER");
    const p = await chargerPiecesLegalDeLaDemande(gest, "SPONSORING", spo);
    const ligne = (id: string) => p.lignes.find((l) => l.id === id)!;
    expect(ligne(devisLibre).suppression).toEqual({ piece: { offert: true, raison: null }, fichiers: { offert: true, raison: null } });
    // La chaîne : le devis dont un BC découle ne se supprime pas (la chaîne ne se coupe pas), mais son PDF mal scanné se remplace.
    expect(ligne(devisAvecBC).suppression.piece.offert).toBe(false);
    expect(ligne(devisAvecBC).suppression.piece.raison).toMatch(/est la base d'une autre pièce .*BC du devis/);
    expect(ligne(devisAvecBC).suppression.fichiers.offert, "un fichier de devis se retire même quand un BC en découle").toBe(true);
    // L'engagement ferme la pièce ET ses fichiers.
    for (const id of [bcSigne, bcValide, factureReglee]) {
      expect(ligne(id).suppression.piece.offert, id).toBe(false);
      expect(ligne(id).suppression.fichiers.offert, id).toBe(false);
      expect(ligne(id).suppression.piece.raison, "la ligne DIT pourquoi").toMatch(/Annulez|avoir/);
    }
    expect(ligne(bcSigne).suppression.piece.raison).toContain("est signé");
    expect(ligne(bcValide).suppression.piece.raison).toContain("a été validé par le centre de validation Ad & Pro");
    expect(ligne(factureReglee).suppression.piece.raison).toContain("est réglée");
    // Une pièce de poste est déjà sur la carte de son poste : elle n'est pas de ce bloc.
    expect(p.lignes.map((l) => l.id)).not.toContain(devisDuPoste);
  });

  it("la pièce qu'un poste porte se lit dans « Pièces liées » : refusée, avec le POSTE nommé et le geste qui reste", async () => {
    const gest = await actorFor(gestId, "VIEWER");
    const l = await chargerPiecesLiees({ entityType: "SPONSORING", entityId: spo, canCreate: false, spectateur: gest, suppression: true });
    const devis = l.sections.QUOTE.find((x) => x.id === devisDuPoste)!;
    expect(devis.suppression?.piece.offert).toBe(false);
    expect(devis.suppression?.piece.raison).toMatch(/rattaché au poste « __pdsup__Imprimerie » : une pièce de poste se retire depuis la carte de son poste/);
    // Sans le drapeau, l'écran n'a rien demandé : aucune décision n'est calculée.
    const sans = await chargerPiecesLiees({ entityType: "SPONSORING", entityId: spo, canCreate: false, spectateur: gest });
    expect(sans.sections.QUOTE.every((x) => x.suppression === null)).toBe(true);
  });

  it("sans pouvoir MODIFIER la demande, rien n'est offert et rien n'est dit par ligne (« vous ne pouvez pas » n'est pas une information)", async () => {
    const sansDemande = await actorFor(sansDemandeId, "VIEWER");
    const p = await chargerPiecesLegalDeLaDemande(sansDemande, "SPONSORING", spo);
    expect(p.lignes.length, "elle lit Legal : les lignes sont là").toBeGreaterThan(3);
    for (const l of p.lignes) expect(l.suppression, l.titre).toEqual({ piece: { offert: false, raison: null }, fichiers: { offert: false, raison: null } });
  });

  it("sans le droit « supprimer » de Legal, la pièce n'est pas offerte — ses fichiers, si (modifier la pièce suffit, comme sur la fiche)", async () => {
    const sansDelete = await actorFor(sansDeleteId, "VIEWER");
    const p = await chargerPiecesLegalDeLaDemande(sansDelete, "SPONSORING", spo);
    const l = p.lignes.find((x) => x.id === devisLibre)!;
    expect(l.suppression).toEqual({ piece: { offert: false, raison: null }, fichiers: { offert: true, raison: null } });
  });

  it("l'AUTEURE de sa pièce la supprime sans le droit « supprimer » de Legal — la règle de la fiche Legal, pas plus large", async () => {
    const createur = await actorFor(createurId, "VIEWER");
    const p = await chargerPiecesLegalDeLaDemande(createur, "SPONSORING", spo);
    expect(p.lignes.find((x) => x.id === conventionDuCreateur)!.suppression.piece.offert).toBe(true);
    expect(p.lignes.find((x) => x.id === devisLibre)!.suppression.piece.offert, "la pièce d'une autre, non").toBe(false);
  });

  // ─── L'ACTION : même décision, refus nommés ────────────────────────────────────────────────────
  it("l'action refuse sans pouvoir modifier la demande — et rien n'est supprimé", async () => {
    ACTOR = await actorFor(sansDemandeId, "VIEWER");
    const r = await supprimerPieceDeLaDemande(form({ id: devisSansFichier }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Vous ne pouvez pas modifier cette demande : retirer une de ses pièces la modifie.");
    expect(await existe(devisSansFichier)).toBe(true);
  });

  it("l'action refuse à qui n'est ni l'auteur ni titulaire de « supprimer » dans Legal", async () => {
    ACTOR = await actorFor(sansDeleteId, "VIEWER");
    const r = await supprimerPieceDeLaDemande(form({ id: devisSansFichier }));
    expect(r.error).toBe("Seul le créateur de la pièce, ou qui a le droit de supprimer dans Legal, peut la supprimer.");
    expect(await existe(devisSansFichier)).toBe(true);
  });

  it("une pièce d'une AUTRE demande, ou sans demande du pôle, n'est pas supprimable d'ici", async () => {
    ACTOR = await actorFor(gestId, "VIEWER");
    // Une pièce rattachée à une autre demande reste supprimable DEPUIS cette demande-là — la porte juge la pièce
    // et SA demande, jamais celle que le formulaire prétend : le serveur lit la source de la pièce.
    const libre = await prisma.legalDocument.create({ data: { title: `${TAG}Sans demande`, kind: "QUOTE", status: "ACTIVE", createdById: gestId } });
    const r = await supprimerPieceDeLaDemande(form({ id: libre.id }));
    expect(r.error).toBe("Cette pièce n'est pas rattachée à une demande Ad & Pro : sa suppression se fait depuis sa fiche Legal.");
    expect(await existe(libre.id)).toBe(true);
    expect((await supprimerPieceDeLaDemande(form({ id: "inconnue" }))).error).toBe("Pièce introuvable.");
    expect(await existe(ailleurs), "ne bouge pas : un autre test la supprime par SA demande").toBe(true);
  });

  it("CE QUI ENGAGE ne part pas — même pour le Super Admin, et par TOUTES les portes (l'écran, la fiche, le cœur) — rien n'est écrit", async () => {
    for (const [id, motif] of [[bcSigne, /est signé/], [bcValide, /a été validé par le centre/], [factureReglee, /est réglée/]] as const) {
      ACTOR = await actorFor(gestId, "VIEWER");
      const r = await supprimerPieceDeLaDemande(form({ id }));
      expect(r.ok, id).toBe(false);
      expect(r.error, id).toMatch(motif);
      // Le Super Admin : global, il ne contourne pas ce qui a engagé la société.
      ACTOR = await actorFor(adminId, "SUPER_ADMIN");
      expect((await supprimerPieceDeLaDemande(form({ id }))).error, `SA ${id}`).toMatch(motif);
      // Le cœur — celui de la fiche Legal (deleteOwnRecord) et de la corbeille : le refus vit chez l'ÉCRIVAIN (§118.106).
      const direct = await supprimerReversible("LEGAL_DOCUMENT", id, adminId, "test");
      expect(direct.ok, `coeur ${id}`).toBe(false);
      expect(direct.error, `coeur ${id}`).toMatch(motif);
      expect(await existe(id), id).toBe(true);
    }
  });

  it("le devis dont un BC découle ne part pas : la chaîne ne se coupe pas par le milieu, et le refus dit par où commencer", async () => {
    ACTOR = await actorFor(gestId, "VIEWER");
    const r = await supprimerPieceDeLaDemande(form({ id: devisAvecBC }));
    expect(r.error).toMatch(/est la base d'une autre pièce \(bon de commande : __pdsup__BC du devis\)/);
    expect(r.error).toContain("en partant de la fin de la chaîne");
    expect(await existe(devisAvecBC)).toBe(true);
    expect((await prisma.legalDocument.findUnique({ where: { id: bcDuDevis }, select: { chainFromId: true } }))?.chainFromId, "le lien n'a pas bougé").toBe(devisAvecBC);
  });

  it("la pièce d'un poste est refusée avec le poste nommé", async () => {
    ACTOR = await actorFor(gestId, "VIEWER");
    const r = await supprimerPieceDeLaDemande(form({ id: devisDuPoste }));
    expect(r.error).toMatch(/rattaché au poste « __pdsup__Imprimerie »/);
    expect(await existe(devisDuPoste)).toBe(true);
  });

  it("L'APERÇU lit ce qui part — fichiers et commentaires — et refuse avec la MÊME phrase que l'action", async () => {
    ACTOR = await actorFor(gestId, "VIEWER");
    const ok = await apercuSuppressionPieceDeLaDemande(form({ id: devisLibre }));
    expect("erreur" in ok).toBe(false);
    if (!("erreur" in ok)) {
      expect(ok.nom).toContain("Devis libre");
      expect(ok.emporte).toContain("1 fichier joint à la pièce");
      expect(ok.refus).toBeNull();
    }
    const refus = await apercuSuppressionPieceDeLaDemande(form({ id: bcSigne }));
    const action = await supprimerPieceDeLaDemande(form({ id: bcSigne }));
    expect("erreur" in refus ? refus.erreur : null, "un aperçu qui dit autre chose que l'action fait chercher une panne").toBe(action.error);
    // Et sans pouvoir modifier la demande, l'aperçu ne dit rien de ce qui dépend d'une pièce qu'on ne touche pas.
    ACTOR = await actorFor(sansDemandeId, "VIEWER");
    const ferme = await apercuSuppressionPieceDeLaDemande(form({ id: devisLibre }));
    expect("erreur" in ferme).toBe(true);
  });

  it("LA GESTIONNAIRE supprime un devis libre : il part à la CORBEILLE avec ses fichiers et ses commentaires (réversible)", async () => {
    ACTOR = await actorFor(gestId, "VIEWER");
    const r = await supprimerPieceDeLaDemande(form({ id: devisLibre }));
    expect(r.ok, r.error).toBe(true);
    expect(await existe(devisLibre)).toBe(false);
    const trace = await prisma.deletedRecord.findFirst({ where: { kind: "LEGAL_DOCUMENT", sourceId: devisLibre } });
    expect(trace, "l'instantané est à la corbeille").not.toBeNull();
    expect(trace?.restoredAt ?? null).toBeNull();
    // Le fichier joint est dans l'instantané (la ligne `Document` revient à la restauration).
    expect(JSON.stringify(trace?.documents)).toContain("devis-libre.pdf");
    expect(await existeFichier(fichierDevisLibre), "la ligne du fichier part avec la pièce").toBe(false);
    const audit = await prisma.auditLog.findFirst({ where: { entityId: devisLibre, action: "DELETE" }, select: { summary: true } });
    expect(audit?.summary).toContain("supprimée depuis sa demande Ad & Pro");
  });

  it("L'AUTEURE supprime sa convention (la règle de la fiche Legal) ; une autre personne ne supprime pas la sienne", async () => {
    ACTOR = await actorFor(sansDeleteId, "VIEWER");
    expect((await supprimerPieceDeLaDemande(form({ id: conventionDuCreateur }))).ok, "ni auteure ni titulaire de « supprimer »").toBe(false);
    ACTOR = await actorFor(createurId, "VIEWER");
    const r = await supprimerPieceDeLaDemande(form({ id: conventionDuCreateur }));
    expect(r.ok, r.error).toBe(true);
    expect(await existe(conventionDuCreateur)).toBe(false);
  });

  it("un BC en ATTENTE de validation se supprime — et sa porte part avec lui, sinon le centre arbitrerait une pièce qui n'existe plus", async () => {
    expect(await prisma.adProGateVisa.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: bcEnAttente, status: "PENDING" } }), "prémisse : la porte attend").toBe(1);
    ACTOR = await actorFor(gestId, "VIEWER");
    const r = await supprimerPieceDeLaDemande(form({ id: bcEnAttente }));
    expect(r.ok, r.error).toBe(true);
    expect(await existe(bcEnAttente)).toBe(false);
    expect(await prisma.adProGateVisa.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: bcEnAttente } })).toBe(0);
  });

  // ─── LES FICHIERS ──────────────────────────────────────────────────────────────────────────────
  it("un FICHIER se supprime depuis la demande : modifier la demande ET gérer la pièce — et le fichier d'un devis dont un BC découle part", async () => {
    ACTOR = await actorFor(sansDeleteId, "VIEWER");
    const r = await supprimerFichierDePieceDeLaDemande(fichierDevisAvecBC, `/sponsoring/${spo}`);
    expect(r.ok, r.error).toBe(true);
    expect(await existeFichier(fichierDevisAvecBC)).toBe(false);
    expect(await existe(devisAvecBC), "la pièce, elle, reste").toBe(true);
    const audit = await prisma.auditLog.findFirst({ where: { entityId: devisAvecBC, action: "DELETE" }, select: { summary: true } });
    expect(audit?.summary).toContain("supprimé depuis sa demande Ad & Pro");
  });

  it("le fichier d'une pièce ENGAGÉE ne se supprime pas d'ici : son PDF est ce qui a été signé, validé ou payé", async () => {
    ACTOR = await actorFor(gestId, "VIEWER");
    for (const id of [fichierBcSigne, fichierFacture]) {
      const r = await supprimerFichierDePieceDeLaDemande(id);
      expect(r.ok, id).toBe(false);
      expect(r.error, id).toContain("ne se suppriment pas d'ici");
      expect(await existeFichier(id), id).toBe(true);
    }
  });

  it("sans pouvoir modifier la demande, le fichier ne part pas ; un fichier qui n'est pas celui d'une pièce Legal non plus", async () => {
    ACTOR = await actorFor(sansDemandeId, "VIEWER");
    const r = await supprimerFichierDePieceDeLaDemande(fichierBcSigne);
    expect(r.error).toBe("Vous ne pouvez pas modifier cette demande : retirer une de ses pièces la modifie.");
    ACTOR = await actorFor(gestId, "VIEWER");
    const autre = await prisma.document.create({ data: { name: `${TAG}ailleurs.pdf`, category: "OTHER", entityType: "SPONSORING", entityId: spo, uploadedById: gestId } });
    expect((await supprimerFichierDePieceDeLaDemande(autre.id)).error).toMatch(/n'est pas celui d'une pièce Legal/);
    expect(await existeFichier(autre.id)).toBe(true);
  });

  it("la pièce d'une autre demande se supprime depuis SA demande — la porte lit la source de la pièce, pas ce que le formulaire prétend", async () => {
    ACTOR = await actorFor(gestId, "VIEWER");
    const r = await supprimerPieceDeLaDemande(form({ id: ailleurs }));
    expect(r.ok, r.error).toBe(true);
    expect(await existe(ailleurs)).toBe(false);
  });
});

// ─── LES POINTS D'APPEL (§118.49) — une décision parfaite que rien n'affiche est du code mort (§118.50) ───
describe("le point d'appel — les écrans montent le geste, et l'action lit la décision", () => {
  const code = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("le bloc des pièces de la demande monte le bouton ET l'action de fichier (sinon « Lecture seule » reste vrai)", () => {
    const c = code("src/components/ad-pro/pieces-legal-demande.tsx");
    expect(c).toMatch(/<SupprimerPieceLegal[^>]*offert=\{l\.suppression\.piece\.offert\}/);
    expect(c).toMatch(/canDelete=\{l\.suppression\.fichiers\.offert\}/);
    expect(c).toMatch(/supprimer=\{supprimerFichierDePieceDeLaDemande\}/);
    expect(c, "plus de suppression désactivée en dur").not.toMatch(/canDelete=\{false\}/);
  });

  // La demande « autre » porte des postes depuis le 27/10/2026 (décision #17) : sa fiche a quitté le bloc « Pièces
  // liées », comme les quatre autres fiches à postes (`ad-pro/rattacher-legal.test.ts`).
  it("« Pièces liées » (consulting, matériel) demande le geste ; la fiche d'une demande au secrétariat, non", () => {
    for (const rel of ["src/app/(app)/consulting/[id]/page.tsx", "src/app/(app)/promo-material/[id]/page.tsx"]) {
      expect(code(rel), rel).toMatch(/<LinkedRecords[\s\S]*?candidatsLegal=\{ctxPieces\.candidatsLegal\} suppression/);
    }
    expect(code("src/app/(app)/demandes/[id]/page.tsx")).not.toMatch(/<LinkedRecords[^>]*suppression/);
    const lr = code("src/components/shared/linked-records.tsx");
    expect(lr).toMatch(/supprimer=\{s \? supprimerFichierDePieceDeLaDemande : undefined\}/);
    expect(lr).toMatch(/<SupprimerPieceLegal[^>]*offert=\{s\.piece\.offert\}/);
  });

  it("le chargeur des pièces liées et celui de la demande lisent LA décision partagée — jamais une recopie", () => {
    for (const rel of ["src/lib/queries/pieces-legal-demande.ts", "src/lib/queries/chaine-des-pieces.ts"]) {
      expect(code(rel), rel).toMatch(/droitsSuppressionDesPieces\(/);
    }
  });

  it("les actions lisent le MÊME verdict que l'écran, et le cœur du registre refuse chez l'écrivain", () => {
    const a = code("src/lib/actions/ad-pro-pieces-actions.ts");
    expect(a).toMatch(/verdictSuppressionPiece\(user, id\)/);
    expect(a).toMatch(/verdictSuppressionFichier\(user, id\)/);
    expect(a, "la pièce part par le cœur réversible").toMatch(/supprimerReversible\(\s*"LEGAL_DOCUMENT"/);
    const reg = code("src/lib/admin-delete-registry.ts");
    expect(reg).toMatch(/LEGAL_DOCUMENT: \{[\s\S]*?refuse: \(id\) => refusSuppressionDeLaPiece\(id\)/);
    expect(reg, "la porte du BC part avec la pièce").toMatch(/LEGAL_DOCUMENT: \{[\s\S]*?retirerEnAttente\(id\)/);
  });

  it("la confirmation lit l'aperçu de LA MÊME porte que l'action (sinon le bouton ne s'arme pas, ou en dit trop)", () => {
    const c = code("src/components/ad-pro/supprimer-piece-legal.tsx");
    expect(c).toMatch(/executer=\{supprimerPieceDeLaDemande\}/);
    expect(c).toMatch(/apercuer=\{apercuSuppressionPieceDeLaDemande\}/);
    expect(code("src/components/shared/super-admin-delete.tsx")).toMatch(/apercuer\(fd\)/);
  });
});
