import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { apercuDeSuppression, restoreDeletedRecord, superAdminDelete } from "@/lib/actions/admin-delete-actions";
import { deleteEvent } from "@/lib/actions/event-actions";
import { deleteBdProject } from "@/lib/actions/bd-project-actions";
import { inventorier, supprimerLot } from "./lot";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE LOT DE SUPPRESSION, par les VRAIES portes (§118.162, §118.14).
 *
 * Décision de la Direction (30/09/2026) : « quand une demande Ad & Pro se retrouve dans
 * Information médicale et qu'ensuite cette demande est supprimée, celle d'Information médicale
 * doit être supprimée également ».
 *
 * On n'écrit aucun état intermédiaire à la main : on sème une demande et ses branches comme les
 * écrans les créent, puis on appelle `superAdminDelete`, `restoreDeletedRecord`, `deleteEvent`
 * et `apercuDeSuppression` — exactement ce que déclenchent le bouton rouge, la corbeille, la
 * fiche d'un événement et la fenêtre de confirmation.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = "__lot170__";
// Une valeur propre au run : un banc à étiquette FIXE ne survit pas à un run interrompu (§118.136).
const RUN = `${TAG}${Date.now().toString(36)}`;

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

/** Tout ce que ce banc a pu laisser — y compris un run précédent interrompu. */
async function nettoyer() {
  const ok = <T>(p: Promise<T>) => p.catch(() => null);
  await ok(prisma.deletedRecord.deleteMany({ where: { name: { contains: TAG } } }));
  await ok(prisma.auditLog.deleteMany({ where: { summary: { contains: TAG } } }));
  await ok(prisma.mailEntryPiece.deleteMany({ where: { label: { startsWith: TAG } } }));
  await ok(prisma.mailEntry.deleteMany({ where: { title: { startsWith: TAG } } }));
  await ok(prisma.document.deleteMany({ where: { name: { startsWith: TAG } } }));
  await ok(prisma.comment.deleteMany({ where: { body: { startsWith: TAG } } }));
  await ok(prisma.legalDocument.deleteMany({ where: { title: { startsWith: TAG } } }));
  await ok(prisma.medicalInfoDeclaration.deleteMany({ where: { reference: { startsWith: TAG } } }));
  await ok(prisma.expenseOrder.deleteMany({ where: { reference: { startsWith: TAG } } }));
  await ok(prisma.validationRequest.deleteMany({ where: { reference: { startsWith: TAG } } }));
  await ok(prisma.workflowInstance.deleteMany({ where: { category: { startsWith: TAG } } }));
  await ok(prisma.workflowDefinition.deleteMany({ where: { category: { startsWith: TAG } } }));
  await ok(prisma.adProGateVisa.deleteMany({ where: { note: { startsWith: TAG } } }));
  await ok(prisma.administrativeRequest.deleteMany({ where: { reference: { startsWith: TAG } } }));
  await ok(prisma.dossier.deleteMany({ where: { reference: { startsWith: TAG } } }));
  await ok(prisma.task.deleteMany({ where: { title: { startsWith: TAG } } }));
  await ok(prisma.entityLink.deleteMany({ where: { note: { startsWith: TAG } } }));
  await ok(prisma.sponsoringRequest.deleteMany({ where: { reference: { startsWith: TAG } } }));
  await ok(prisma.event.deleteMany({ where: { name: { startsWith: TAG } } }));
  await ok(prisma.congressInternational.deleteMany({ where: { name: { startsWith: TAG } } }));
  await ok(prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } }));
  await ok(prisma.bdProject.deleteMany({ where: { name: { startsWith: TAG } } }));
  await ok(prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }));
  await ok(prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }));
}

suite("Supprimer une demande emporte TOUTES ses branches — et la restauration les rend", () => {
  let saId = "", dirId = "", kamId = "";
  let defId = "";
  // Le sponsoring et ses branches.
  const S: Record<string, string> = {};
  // L'extérieur : ce qui RESTE et ne doit pas être emporté, mais dont un lien vers le lot se vide.
  let pieceCourrierId = "", factureDehorsId = "", auditId = "";

  async function semerSponsoring(suffixe: string) {
    const sp = await prisma.sponsoringRequest.create({ data: { reference: `${RUN}SP${suffixe}`, institution: "CHU Mustapha", type: "ASSOCIATION" } });
    const secretariat = await prisma.administrativeRequest.create({ data: { reference: `${RUN}SEC${suffixe}`, title: `${TAG}devis traiteur`, type: "QUOTE", linkedEntityType: "SPONSORING", linkedEntityId: sp.id } });
    // Le poste désigne SA demande de devis au secrétariat. L'inventaire trouve le poste (enfant en
    // cascade) AVANT la demande (branche emportée) : sans le tri parents d'abord, la restauration
    // recréerait le poste avant ce qu'il désigne, et Postgres refuserait.
    const poste = await prisma.adProItem.create({ data: { label: `${TAG}poste`, sponsoringId: sp.id, adminRequestId: secretariat.id } });
    const decisionPoste = await prisma.adProItemDecision.create({ data: { itemId: poste.id, decision: "APPROVED" } });
    // Le bon de versement de la déclaration — un lien DIRECT (champ texte), pas un couple.
    const bv = await prisma.validationRequest.create({ data: { reference: `${RUN}VR${suffixe}`, module: "Information médicale", title: `${TAG}bon`, requesterId: saId } });
    const decl = await prisma.medicalInfoDeclaration.create({
      data: { reference: `${RUN}DIM${suffixe}`, sourceType: "SPONSORING", sourceId: sp.id, label: `${TAG}déclaration`, bvValidationId: bv.id },
    });
    const bordereau = await prisma.medicalInfoSlip.create({ data: { declarationId: decl.id, label: `${TAG}bordereau` } });
    const piecePharma = await prisma.medicalInfoDocRequest.create({ data: { declarationId: decl.id, label: `${TAG}pièce` } });
    const comDecl = await prisma.comment.create({ data: { entityType: "MEDICAL_INFO_DECLARATION", entityId: decl.id, body: `${TAG}vu par le pharmacien`, authorId: saId } });
    const circuit = await prisma.workflowInstance.create({ data: { definitionId: defId, entityType: "SPONSORING", entityId: sp.id, category: `${RUN}WF` } });
    const etape = await prisma.workflowStepEvent.create({ data: { instanceId: circuit.id, stepSlug: "preliminary", stepTitle: "National Sales", action: "APPROVE", actorId: saId } });
    const visa = await prisma.adProGateVisa.create({ data: { entityType: "SPONSORING", entityId: sp.id, note: `${TAG}visa` } });
    const ordre = await prisma.expenseOrder.create({ data: { reference: `${RUN}OD${suffixe}`, label: `${TAG}ordre`, amount: 125000.5, sourceType: "SPONSORING", sourceId: sp.id } });
    const devis = await prisma.legalDocument.create({ data: { title: `${TAG}devis`, kind: "QUOTE", sourceType: "SPONSORING", sourceId: sp.id } });
    // Le BC DÉCOULE du devis : la recréation doit remettre le devis d'abord.
    const bc = await prisma.legalDocument.create({ data: { title: `${TAG}BC`, kind: "PURCHASE_ORDER", sourceType: "SPONSORING", sourceId: sp.id, chainFromId: devis.id } });
    const pdfDevis = await prisma.document.create({ data: { name: `${TAG}devis.pdf`, entityType: "LEGAL_DOCUMENT", entityId: devis.id, fileKey: `${RUN}/devis.pdf`, uploadedById: saId } });
    const pjDemande = await prisma.document.create({ data: { name: `${TAG}demande-medecin.pdf`, entityType: "SPONSORING", entityId: sp.id, uploadedById: saId } });
    const comDemande = await prisma.comment.create({ data: { entityType: "SPONSORING", entityId: sp.id, body: `${TAG}le devis est arrivé`, authorId: saId } });
    const rappel = await prisma.reminder.create({ data: { userId: saId, title: `${TAG}relancer`, remindAt: new Date(Date.now() + 86_400_000), entityType: "SPONSORING", entityId: sp.id } });
    const tache = await prisma.task.create({ data: { title: `${TAG}préparer la convention`, relatedEntityType: "SPONSORING", relatedEntityId: sp.id } });
    const dossier = await prisma.dossier.create({ data: { reference: `${RUN}DOS${suffixe}`, title: `${TAG}dossier`, sourceType: "SPONSORING", sourceId: sp.id } });
    const message = await prisma.dossierMessage.create({ data: { dossierId: dossier.id, body: `${TAG}message` } });
    const lien = await prisma.entityLink.create({ data: { fromType: "SPONSORING", fromId: sp.id, toType: "EVENT", toId: "evt-quelconque", note: `${TAG}lien` } });
    return {
      sp: sp.id, poste: poste.id, decisionPoste: decisionPoste.id, bv: bv.id, decl: decl.id, bordereau: bordereau.id,
      piecePharma: piecePharma.id, comDecl: comDecl.id, circuit: circuit.id, etape: etape.id, visa: visa.id, ordre: ordre.id,
      devis: devis.id, bc: bc.id, pdfDevis: pdfDevis.id, pjDemande: pjDemande.id, comDemande: comDemande.id,
      secretariat: secretariat.id, rappel: rappel.id, tache: tache.id, dossier: dossier.id, message: message.id, lien: lien.id,
    };
  }

  /** Ce que chaque identifiant désigne, pour relire la base après chaque geste. */
  const LECTEURS: Record<string, (id: string) => Promise<unknown>> = {
    sp: (id) => prisma.sponsoringRequest.findUnique({ where: { id } }),
    poste: (id) => prisma.adProItem.findUnique({ where: { id } }),
    decisionPoste: (id) => prisma.adProItemDecision.findUnique({ where: { id } }),
    bv: (id) => prisma.validationRequest.findUnique({ where: { id } }),
    decl: (id) => prisma.medicalInfoDeclaration.findUnique({ where: { id } }),
    bordereau: (id) => prisma.medicalInfoSlip.findUnique({ where: { id } }),
    piecePharma: (id) => prisma.medicalInfoDocRequest.findUnique({ where: { id } }),
    comDecl: (id) => prisma.comment.findUnique({ where: { id } }),
    circuit: (id) => prisma.workflowInstance.findUnique({ where: { id } }),
    etape: (id) => prisma.workflowStepEvent.findUnique({ where: { id } }),
    visa: (id) => prisma.adProGateVisa.findUnique({ where: { id } }),
    ordre: (id) => prisma.expenseOrder.findUnique({ where: { id } }),
    devis: (id) => prisma.legalDocument.findUnique({ where: { id } }),
    bc: (id) => prisma.legalDocument.findUnique({ where: { id } }),
    pdfDevis: (id) => prisma.document.findUnique({ where: { id } }),
    pjDemande: (id) => prisma.document.findUnique({ where: { id } }),
    comDemande: (id) => prisma.comment.findUnique({ where: { id } }),
    secretariat: (id) => prisma.administrativeRequest.findUnique({ where: { id } }),
    rappel: (id) => prisma.reminder.findUnique({ where: { id } }),
    tache: (id) => prisma.task.findUnique({ where: { id } }),
    dossier: (id) => prisma.dossier.findUnique({ where: { id } }),
    message: (id) => prisma.dossierMessage.findUnique({ where: { id } }),
    lien: (id) => prisma.entityLink.findUnique({ where: { id } }),
  };
  async function presents(ids: Record<string, string>): Promise<string[]> {
    const out: string[] = [];
    for (const [k, id] of Object.entries(ids)) if (await LECTEURS[k]!(id)) out.push(k);
    return out.sort();
  }

  beforeAll(async () => {
    await nettoyer();
    const sa = await prisma.user.create({ data: { name: `${TAG}admin`, email: `${RUN}sa@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } });
    const dir = await prisma.user.create({ data: { name: `${TAG}direction`, email: `${RUN}dir@t.dz`, role: "DIRECTION", passwordHash: "x" } });
    // UN KAM : il voit sa demande, il ne la supprime pas. Le directeur des opérations, lui, peut
    // désormais supprimer une demande Ad & Pro (§118.175) — il ne peut donc plus jouer « celui qui
    // ne peut pas », et ce banc mesurerait un refus qui n'existe plus.
    const kam = await prisma.user.create({ data: { name: `${TAG}kam`, email: `${RUN}kam@t.dz`, role: "MEDICAL_DELEGATE", passwordHash: "x" } });
    saId = sa.id; dirId = dir.id; kamId = kam.id;
    defId = (await prisma.workflowDefinition.create({ data: { category: `${RUN}WF`, name: `${TAG}circuit` } })).id;
    Object.assign(S, await semerSponsoring("A"));

    // DEHORS : un courrier qui n'a rien à voir avec la demande, mais dont une pièce CITE le PDF
    // du devis (clé étrangère `SetNull`), et une facture d'un autre dossier qui désigne l'ordre de
    // dépense de la demande (lien DIRECT, un champ texte). Ils restent ; leur lien se vide, puis
    // revient avec la restauration.
    const courrier = await prisma.mailEntry.create({ data: { title: `${TAG}courrier dehors`, direction: "INCOMING" } });
    pieceCourrierId = (await prisma.mailEntryPiece.create({ data: { entryId: courrier.id, label: `${TAG}pièce du courrier`, documentId: S.pdfDevis } })).id;
    factureDehorsId = (await prisma.legalDocument.create({ data: { title: `${TAG}facture d'ailleurs`, kind: "INVOICE", expenseOrderId: S.ordre } })).id;
    // L'HISTOIRE : le journal ne part jamais.
    auditId = (await prisma.auditLog.create({ data: { action: "CREATE", module: "Sponsoring", entityType: "SPONSORING", entityId: S.sp, summary: `${TAG}création` } })).id;
  }, 60_000);

  afterAll(async () => { await nettoyer(); }, 60_000);

  it("PRÉMISSE : tout est semé, et la déclaration désigne bien le sponsoring", async () => {
    expect(await presents(S)).toEqual(Object.keys(S).sort());
    const decl = await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id: S.decl } });
    expect(decl.sourceType).toBe("SPONSORING");
    expect(decl.sourceId).toBe(S.sp);
  });

  it("l'aperçu DIT ce qui part — sans rien écrire", async () => {
    ACTOR = await acteur(saId, "SUPER_ADMIN");
    const avant = await presents(S);
    const a = await apercuDeSuppression(fd({ kind: "SPONSORING", id: S.sp }));
    expect("erreur" in a).toBe(false);
    if ("erreur" in a) return;
    expect(a.lot).toBe(true);
    expect(a.refus).toBeNull();
    const texte = a.emporte.join(" | ");
    expect(texte, "LA décision de la Direction").toContain("1 déclaration d'information médicale");
    for (const attendu of [
      "1 poste", "2 pièces au registre Legal", "1 circuit de validation", "1 ordre de dépense", "1 visa",
      "1 demande au secrétariat", "1 demande de validation", "1 rappel", "1 tâche", "1 sujet", "1 bon de versement",
      "2 pièces jointes",
    ]) expect(texte, attendu).toContain(attendu);
    // Rien n'a bougé : un aperçu qui écrirait ne serait plus un aperçu (§118.53).
    expect(await presents(S)).toEqual(avant);
  });

  it("l'aperçu est fermé à qui ne peut pas supprimer — il dirait ce qui dépend d'une demande qu'on ne voit pas", async () => {
    ACTOR = await acteur(kamId, "MEDICAL_DELEGATE");
    const a = await apercuDeSuppression(fd({ kind: "SPONSORING", id: S.sp }));
    expect("erreur" in a ? a.erreur : "aperçu ouvert").toMatch(/Réservé/);
    // L'AUTRE MOITIÉ — le directeur des opérations peut supprimer une demande Ad & Pro (§118.175),
    // donc l'aperçu s'ouvre pour lui : un aperçu fermé devant une suppression que l'action
    // accepte ferait supprimer à l'aveugle. Sans ce cas, une porte d'aperçu trop étroite
    // passerait pour juste.
    ACTOR = await acteur(dirId, "DIRECTION");
    const b = await apercuDeSuppression(fd({ kind: "SPONSORING", id: S.sp }));
    expect("erreur" in b ? b.erreur : null).toBeNull();
  });

  it("un fait qui a QUITTÉ l'ERP refuse la suppression — avant le clic comme au clic — et rien ne part", async () => {
    ACTOR = await acteur(saId, "SUPER_ADMIN");
    const cas: { nom: string; poser: () => Promise<unknown>; lever: () => Promise<unknown>; motif: RegExp }[] = [
      {
        nom: "ordre de dépense réglé",
        poser: () => prisma.expenseOrder.update({ where: { id: S.ordre }, data: { status: "PAID" } }),
        lever: () => prisma.expenseOrder.update({ where: { id: S.ordre }, data: { status: "PENDING" } }),
        motif: /ordre de dépense .*a été réglé/,
      },
      {
        nom: "BC signé par les Finances",
        poser: () => prisma.legalDocument.update({ where: { id: S.bc }, data: { signedById: saId } }),
        lever: () => prisma.legalDocument.update({ where: { id: S.bc }, data: { signedById: null } }),
        motif: /signée par les Finances/,
      },
      {
        nom: "déclaration déposée aux autorités",
        poser: () => prisma.medicalInfoDeclaration.update({ where: { id: S.decl }, data: { authorityRef: "REC-2026-7" } }),
        lever: () => prisma.medicalInfoDeclaration.update({ where: { id: S.decl }, data: { authorityRef: null } }),
        motif: /déposée auprès des autorités \(récépissé REC-2026-7\)/,
      },
      {
        nom: "courrier inscrit au registre",
        poser: () => prisma.mailEntry.create({ data: { title: `${TAG}courrier de la demande`, direction: "OUTGOING", sourceType: "SPONSORING", sourceId: S.sp } }),
        lever: () => prisma.mailEntry.deleteMany({ where: { title: `${TAG}courrier de la demande` } }),
        motif: /inscrit au registre des courriers/,
      },
    ];
    for (const c of cas) {
      await c.poser();
      // Le fait est LEVÉ quoi qu'il arrive : sinon un cas qui tombe laisserait la demande bloquée,
      // et tous les cas suivants tomberaient pour lui — un échec doit désigner sa propre cause.
      try {
        const a = await apercuDeSuppression(fd({ kind: "SPONSORING", id: S.sp }));
        expect("erreur" in a ? a.erreur : a.refus, `${c.nom} — aperçu`).toMatch(c.motif);
        const r = await superAdminDelete(fd({ kind: "SPONSORING", id: S.sp }));
        expect(r.ok, `${c.nom} — la suppression doit être refusée`).toBe(false);
        expect(r.error, c.nom).toMatch(c.motif);
        expect(await presents(S), `${c.nom} — RIEN ne doit être parti`).toEqual(Object.keys(S).sort());
      } finally {
        await c.lever();
      }
    }
  }, 60_000);

  it("TOUT OU RIEN : une panne au dépôt dans la corbeille annule la suppression entière", async () => {
    const inv = await inventorier("SponsoringRequest", S.sp);
    expect(inv?.bloquants).toEqual([]);
    await expect(supprimerLot(inv!, async () => { throw new Error("panne simulée au dépôt"); })).rejects.toThrow(/panne simulée/);
    expect(await presents(S), "une suppression interrompue ne laisse rien derrière elle").toEqual(Object.keys(S).sort());
    const piece = await prisma.mailEntryPiece.findUniqueOrThrow({ where: { id: pieceCourrierId } });
    expect(piece.documentId, "le lien du dehors n'a pas été vidé non plus").toBe(S.pdfDevis);
  }, 60_000);

  let recId = "";
  it("la suppression EMPORTE la déclaration d'information médicale — et toutes les autres branches", async () => {
    ACTOR = await acteur(saId, "SUPER_ADMIN");
    const t0 = Date.now();
    const r = await superAdminDelete(fd({ kind: "SPONSORING", id: S.sp }));
    const duree = Date.now() - t0;
    expect(r.ok, r.error).toBe(true);
    expect(await presents(S), "aucune branche ne doit survivre à sa demande").toEqual([]);
    expect(await prisma.medicalInfoDeclaration.findUnique({ where: { id: S.decl } }), "LA règle de la Direction").toBeNull();
    // Mesuré : moins d'une seconde en local pour ce lot (vingt-trois lignes, deux pièces). Une
    // borne de BLOCAGE, pas de lenteur (§118.124b).
    expect(duree).toBeLessThan(30_000);

    // L'HISTOIRE reste.
    expect(await prisma.auditLog.findUnique({ where: { id: auditId } })).not.toBeNull();
    // Le dehors reste — et ses liens vers le lot se sont vidés, sans rien emporter.
    const piece = await prisma.mailEntryPiece.findUniqueOrThrow({ where: { id: pieceCourrierId } });
    expect(piece.documentId).toBeNull();
    const facture = await prisma.legalDocument.findUniqueOrThrow({ where: { id: factureDehorsId } });
    expect(facture.expenseOrderId, "un lien DIRECT vers une ligne disparue se vide — il ne désigne pas le vide").toBeNull();

    const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { kind: "SPONSORING", sourceId: S.sp, restoredAt: null } });
    recId = rec.id;
    const lot = rec.lot as { version: number; lignes: { modele: string }[]; resume: string[] } | null;
    expect(lot?.version).toBe(1);
    // Vingt-trois identifiants semés : la tête vit dans `payload`, ses deux pièces jointes et ses
    // deux commentaires dans `documents` / `comments` ; les dix-huit autres dans le lot.
    expect(lot?.lignes.length).toBe(18);
    expect(lot?.resume.join(" | ")).toContain("1 déclaration d'information médicale");
    expect((rec.documents as unknown[]).length).toBe(2);
    expect((rec.comments as unknown[]).length).toBe(2);
  }, 60_000);

  it("la corbeille dit ce qui est parti avec lui (entrée unique, pas vingt)", async () => {
    const entrees = await prisma.deletedRecord.count({ where: { sourceId: S.sp } });
    expect(entrees).toBe(1);
  });

  it("une restauration qui écraserait refuse — et ne recrée RIEN", async () => {
    // Quelqu'un a recréé entre-temps une ligne portant l'identifiant d'une branche.
    await prisma.task.create({ data: { id: S.tache, title: `${TAG}tâche qui squatte` } });
    const r = await restoreDeletedRecord(fd({ id: recId }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/existent déjà/);
    expect(await prisma.sponsoringRequest.findUnique({ where: { id: S.sp } }), "la tête n'est pas recréée seule").toBeNull();
    await prisma.task.delete({ where: { id: S.tache } });
  }, 60_000);

  it("la restauration REND tout, à l'identique : mêmes identifiants, mêmes valeurs, liens du dehors rétablis", async () => {
    ACTOR = await acteur(saId, "SUPER_ADMIN");
    const r = await restoreDeletedRecord(fd({ id: recId }));
    expect(r.ok, r.error).toBe(true);
    expect(await presents(S), "tout ce qui est parti avec la demande revient avec elle").toEqual(Object.keys(S).sort());

    const decl = await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id: S.decl } });
    expect(decl.sourceId).toBe(S.sp);
    expect(decl.bvValidationId).toBe(S.bv);
    const ordre = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: S.ordre } });
    expect(Number(ordre.amount), "un montant décimal traverse le JSON sans perte").toBe(125000.5);
    const bc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: S.bc } });
    expect(bc.chainFromId, "le BC découle toujours de son devis").toBe(S.devis);
    const poste = await prisma.adProItem.findUniqueOrThrow({ where: { id: S.poste } });
    expect(poste.adminRequestId, "le poste désigne toujours sa demande au secrétariat").toBe(S.secretariat);
    const etape = await prisma.workflowStepEvent.findUniqueOrThrow({ where: { id: S.etape } });
    expect(etape.instanceId).toBe(S.circuit);

    const piece = await prisma.mailEntryPiece.findUniqueOrThrow({ where: { id: pieceCourrierId } });
    expect(piece.documentId, "la pièce du courrier cite à nouveau le PDF du devis").toBe(S.pdfDevis);
    const facture = await prisma.legalDocument.findUniqueOrThrow({ where: { id: factureDehorsId } });
    expect(facture.expenseOrderId, "la facture d'ailleurs retrouve son ordre").toBe(S.ordre);

    const rec = await prisma.deletedRecord.findUniqueOrThrow({ where: { id: recId } });
    expect(rec.restoredAt).not.toBeNull();
  }, 60_000);

  it("on ne restaure pas deux fois", async () => {
    const r = await restoreDeletedRecord(fd({ id: recId }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/déjà traitée/);
  });

  it("supprimer la déclaration SEULE emporte ses branches à elle — pas sa demande", async () => {
    ACTOR = await acteur(saId, "SUPER_ADMIN");
    const r = await superAdminDelete(fd({ kind: "MEDICAL_INFO_DECLARATION", id: S.decl }));
    expect(r.ok, r.error).toBe(true);
    expect(await prisma.medicalInfoDeclaration.findUnique({ where: { id: S.decl } })).toBeNull();
    expect(await prisma.medicalInfoSlip.findUnique({ where: { id: S.bordereau } })).toBeNull();
    expect(await prisma.validationRequest.findUnique({ where: { id: S.bv } }), "son bon de versement part avec elle").toBeNull();
    expect(await prisma.sponsoringRequest.findUnique({ where: { id: S.sp } }), "la demande, elle, reste").not.toBeNull();
    expect(await prisma.expenseOrder.findUnique({ where: { id: S.ordre } }), "l'ordre de la DEMANDE n'était pas celui de la déclaration").not.toBeNull();
    const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { kind: "MEDICAL_INFO_DECLARATION", sourceId: S.decl, restoredAt: null } });
    const back = await restoreDeletedRecord(fd({ id: rec.id }));
    expect(back.ok, back.error).toBe(true);
    expect(await presents(S)).toEqual(Object.keys(S).sort());
  }, 60_000);

  it("un ÉVÉNEMENT supprimé depuis sa fiche (droit du module, pas Super Admin) passe par le même lot", async () => {
    const dir = await acteur(dirId, "DIRECTION");
    // Prémisse : la Direction a le droit du module — sinon ce cas mesurerait un refus.
    expect(userCan(dir, "EVENTS", "DELETE")).toBe(true);
    const ev = await prisma.event.create({ data: { name: `${TAG}Soirée scientifique` } });
    const inscription = await prisma.eventRegistration.create({ data: { eventId: ev.id, firstName: "Amel", lastName: "Haddad" } });
    const poste = await prisma.adProItem.create({ data: { label: `${TAG}traiteur`, eventId: ev.id } });
    const decl = await prisma.medicalInfoDeclaration.create({ data: { reference: `${RUN}DIM-EV`, sourceType: "EVENT", sourceId: ev.id, label: `${TAG}déclaration événement` } });

    ACTOR = dir;
    const a = await apercuDeSuppression(fd({ kind: "EVENT", id: ev.id }));
    expect("erreur" in a).toBe(false);
    const emporte = "erreur" in a ? "" : a.emporte.join(" | ");
    for (const attendu of ["1 inscription", "1 poste", "1 déclaration d'information médicale"]) expect(emporte, attendu).toContain(attendu);

    const r = await deleteEvent(fd({ id: ev.id }));
    expect(r.ok, r.error).toBe(true);
    expect(await prisma.event.findUnique({ where: { id: ev.id } })).toBeNull();
    expect(await prisma.medicalInfoDeclaration.findUnique({ where: { id: decl.id } }), "la déclaration part avec l'événement").toBeNull();
    expect(await prisma.eventRegistration.findUnique({ where: { id: inscription.id } })).toBeNull();

    // Réversible — ce qu'était `prisma.event.delete` ne l'était pas.
    const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { kind: "EVENT", sourceId: ev.id } });
    expect(rec.deletedById).toBe(dirId);
    ACTOR = await acteur(saId, "SUPER_ADMIN");
    const back = await restoreDeletedRecord(fd({ id: rec.id }));
    expect(back.ok, back.error).toBe(true);
    expect(await prisma.eventRegistration.findUnique({ where: { id: inscription.id } })).not.toBeNull();
    expect(await prisma.adProItem.findUnique({ where: { id: poste.id } })).not.toBeNull();
    expect(await prisma.medicalInfoDeclaration.findUnique({ where: { id: decl.id } })).not.toBeNull();
  }, 60_000);

  it("un congrès : les lignes de devis à clé COMPOSÉE partent et reviennent — et celles d'un AUTRE congrès ne bougent pas", async () => {
    ACTOR = await acteur(saId, "SUPER_ADMIN");
    async function congres(nom: string) {
      const c = await prisma.congressInternational.create({ data: { name: `${TAG}${nom}` } });
      const benef = await prisma.careBeneficiary.create({ data: { congressInternationalId: c.id } });
      const cellule = await prisma.careCell.create({ data: { beneficiaryId: benef.id, kind: "SERVICE", serviceKind: "HOTEL", label: "Hôtel" } });
      const devis = await prisma.careQuote.create({ data: { supplier: `${TAG}Hôtel`, amountDzd: 42000, congressInternationalId: c.id } });
      await prisma.careQuoteCell.create({ data: { quoteId: devis.id, cellId: cellule.id } });
      return { c: c.id, devis: devis.id, cellule: cellule.id };
    }
    const vise = await congres("ESMO");
    const autre = await congres("ASCO");
    const r = await superAdminDelete(fd({ kind: "CONGRESS_INTERNATIONAL", id: vise.c }));
    expect(r.ok, r.error).toBe(true);
    expect(await prisma.careQuoteCell.count({ where: { quoteId: vise.devis } })).toBe(0);
    // LA garde de la clé composée : une condition sans `id` ne doit jamais devenir « toute la table ».
    expect(await prisma.careQuoteCell.count({ where: { quoteId: autre.devis } }), "la ligne de devis d'un autre congrès").toBe(1);

    const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { kind: "CONGRESS_INTERNATIONAL", sourceId: vise.c } });
    const back = await restoreDeletedRecord(fd({ id: rec.id }));
    expect(back.ok, back.error).toBe(true);
    expect(await prisma.careQuoteCell.findUnique({ where: { quoteId_cellId: { quoteId: vise.devis, cellId: vise.cellule } } })).not.toBeNull();
    await prisma.congressInternational.deleteMany({ where: { id: { in: [vise.c, autre.c] } } });
  }, 60_000);
  it("un PROJET part avec ses gammes et produits, DÉCLASSE ses dossiers — et tout revient ensemble (§118.163)", async () => {
    // Avant : `prisma.bdProject.delete` — gammes et produits perdus, chaque dossier classé perdait
    // son projet, sans instantané ni retour, et sans que personne le lise avant le clic.
    const co = await prisma.company.create({ data: { name: `${TAG}société du projet` } });
    const projet = await prisma.bdProject.create({ data: { name: `${TAG}Oncologie 2027`, companyId: co.id } });
    const gamme = await prisma.bdRange.create({ data: { name: `${TAG}Oncologie`, projectId: projet.id } });
    const produit = await prisma.bdProduct.create({ data: { dci: `${TAG}Nivolex`, rangeId: gamme.id } });
    const dossier = await prisma.regulatoryProduct.create({ data: { reference: `${RUN}REG-P`, dci: "Nivolex", bdProjectId: projet.id } });

    ACTOR = await acteur(saId, "SUPER_ADMIN");
    const a = await apercuDeSuppression(fd({ kind: "BD_PROJECT", id: projet.id }));
    expect("erreur" in a).toBe(false);
    if ("erreur" in a) return;
    expect(a.lot).toBe(true);
    const emporte = a.emporte.join(" | ");
    for (const attendu of ["1 gamme", "1 produit à l'étude"]) expect(emporte, attendu).toContain(attendu);
    // Le dossier RESTE : il n'est pas « emporté », il perd son classement — et la fenêtre le dit.
    expect(emporte).not.toContain("dossier réglementaire");
    expect(a.detache, "trois dossiers déclassés au même clic ne se taisent pas").toEqual(["1 dossier réglementaire"]);

    const r = await deleteBdProject(fd({ id: projet.id }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await prisma.bdProject.findUnique({ where: { id: projet.id } })).toBeNull();
    expect(await prisma.bdRange.findUnique({ where: { id: gamme.id } })).toBeNull();
    expect(await prisma.bdProduct.findUnique({ where: { id: produit.id } })).toBeNull();
    const declasse = await prisma.regulatoryProduct.findUnique({ where: { id: dossier.id }, select: { bdProjectId: true } });
    expect(declasse, "le dossier ne part JAMAIS avec le projet").not.toBeNull();
    expect(declasse!.bdProjectId).toBeNull();

    const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { kind: "BD_PROJECT", sourceId: projet.id } });
    expect(rec.lot, "un lot, pas l'instantané de la ligne seule").not.toBeNull();
    const back = await restoreDeletedRecord(fd({ id: rec.id }));
    expect(back.ok, back.error).toBe(true);
    const revenu = await prisma.bdProject.findUniqueOrThrow({ where: { id: projet.id } });
    expect(revenu.companyId, "le projet revient dans SON entité").toBe(co.id);
    expect(await prisma.bdRange.findUnique({ where: { id: gamme.id } })).not.toBeNull();
    expect(await prisma.bdProduct.findUnique({ where: { id: produit.id } })).not.toBeNull();
    expect((await prisma.regulatoryProduct.findUniqueOrThrow({ where: { id: dossier.id } })).bdProjectId,
      "le classement du dossier revient avec le projet").toBe(projet.id);
  }, 60_000);
});
