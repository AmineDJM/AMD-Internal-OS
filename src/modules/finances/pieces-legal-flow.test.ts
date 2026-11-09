import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));
// Le stockage n'est pas testé ici : le faux écrit un `Document` réel SUR LA FICHE QU'ON LUI DONNE (demande, ou Legal).
vi.mock("@/lib/documents", () => ({
  persistUploadedDocument: async (_u: string, i: { entityType: string; entityId: string; file: File }) => {
    const doc = await (await import("@/lib/prisma")).prisma.document.create({
      data: { name: `__pjlegal__${i.file.name}`, entityType: i.entityType as never, entityId: i.entityId, fileKey: `__pjlegal__/${i.file.name}`, mimeType: "application/pdf", sizeBytes: 10, category: "OTHER", confidentiality: "INTERNAL" },
    });
    return { ok: true, documentId: doc.id };
  },
}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { peutOuvrirDocument } from "@/lib/entity-access/ouverture-pieces";
import { createPaymentRequest } from "./actions-demandes";
import { documentsLegalPourDemande, lirePieceDePaiement, mesDemandesDePaiementEnCours } from "./actions-pieces-paiement";

/**
 * LES PIÈCES D'UNE DEMANDE DE PAIEMENT, CHOISIES DANS LEGAL OU DÉPOSÉES (Direction, 04/11/2026) — par les vraies actions.
 *
 *   • la facture du registre se choisit, remplit le formulaire, et son fichier est RÉFÉRENCÉ ;
 *   • les Finances l'ouvrent par la demande, sans recevoir le registre Legal ;
 *   • une facture ne se demande qu'une fois ; le montant demandé est confronté à son TTC ;
 *   • un devis déposé entre au registre Legal ; un BC déposé reste joint à la demande seulement.
 */
// Une étiquette PAR PASSAGE : un passage interrompu ne bloque pas le suivant sur l'unicité de l'e-mail (cliquet comptes-empruntes).
const TAG = `__pjlegal_${Date.now().toString(36)}__`;
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access: await getAccess(id, role), mustChangePassword: false };
}
function form(champs: Record<string, string>, legaux: string[] = [], fichiers: { nom: string; kind: string }[] = []): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(champs)) fd.set(k, v);
  for (const id of legaux) fd.append("legalDocumentIds", id);
  fichiers.forEach((f, i) => { fd.append("files", new File(["x"], f.nom, { type: "application/pdf" })); fd.set(`kind_${i}`, f.kind); });
  return fd;
}

suite("demande de paiement — les pièces choisies dans Legal ou déposées", () => {
  let demandeurId = "", financesId = "", factureId = "", fichierId = "";
  const demandes: string[] = [];

  beforeAll(async () => {
    const mk = (s: string, role: SessionUser["role"]) => prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" } });
    const [d, f] = await Promise.all([mk("demandeur", "DIRECTION"), mk("finances", "FINANCE_BUDGET_MANAGER")]);
    demandeurId = d.id; financesId = f.id;
    // Une facture du registre RÉSERVÉE à son lecteur (le demandeur) : les Finances ne la voient pas dans Legal.
    const facture = await prisma.legalDocument.create({
      data: { title: `${TAG} Facture FA-2026-77 — Atlas`, kind: "INVOICE", direction: "OUT", amount: 142800, counterparty: "Atlas Événementiel", reference: "FA-2026-77", endDate: new Date("2026-12-15T00:00:00Z") },
    });
    factureId = facture.id;
    await prisma.legalDocumentReader.create({ data: { documentId: facture.id, userId: demandeurId } });
    fichierId = (await prisma.document.create({
      data: { name: `${TAG}facture.pdf`, entityType: "LEGAL_DOCUMENT", entityId: facture.id, fileKey: `${TAG}/facture.pdf`, mimeType: "application/pdf", sizeBytes: 10, category: "OTHER", confidentiality: "INTERNAL" },
    })).id;
  });

  afterAll(async () => {
    await prisma.expenseOrder.deleteMany({ where: { sourceType: "PAYMENT_REQUEST", sourceId: { in: demandes } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { id: { in: demandes } } }).catch(() => {});
    const legaux = await prisma.legalDocument.findMany({ where: { OR: [{ id: factureId }, { sourceType: "PAYMENT_REQUEST", sourceId: { in: demandes } }] }, select: { id: true } });
    await prisma.document.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: legaux.map((l) => l.id) } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("la facture du registre se propose et remplit le formulaire depuis ce que Legal sait", async () => {
    ACTOR = await acteur(demandeurId, "DIRECTION");
    const fd = new FormData();
    fd.set("recherche", "FA-2026-77");
    const liste = await documentsLegalPourDemande(fd);
    expect(liste.map((d) => d.id)).toEqual([factureId]);
    expect(liste[0]).toMatchObject({ nature: "INVOICE", partie: "Atlas Événementiel", montant: 142800, avertissement: null, refus: null });

    const lu = new FormData();
    lu.set("legalDocumentId", factureId);
    const r = await lirePieceDePaiement(lu);
    expect(r).toMatchObject({
      ok: true, nature: "INVOICE",
      proposition: { title: `${TAG} Facture FA-2026-77 — Atlas`, payee: "Atlas Événementiel", amount: "142800", dueDate: "2026-12-15" },
    });
  });

  // LE BÉNÉFICIAIRE DANS L'ANNUAIRE (Direction, 08/11/2026) : certain, la pièce le choisit ; pas certain, rien n'est choisi.
  it("le bénéficiaire est retenu dans l'annuaire quand c'est certain : la fiche liée au document, sinon une seule fiche au nom exact", async () => {
    ACTOR = await acteur(demandeurId, "DIRECTION");
    const lu = new FormData();
    lu.set("legalDocumentId", factureId);
    const fiche = await prisma.companyContact.create({ data: { name: "Atlas Événementiel", kind: `${TAG}agence`, phone: "0550 11 22 33", email: "contact@atlas.test" } });
    try {
      // Une seule fiche porte exactement le nom lu : retenue, et la preuve le dit.
      const parNom = await lirePieceDePaiement(lu);
      expect(parNom.ok && parNom.annuaire.retenu).toMatchObject({ id: fiche.id, name: "Atlas Événementiel", phone: "0550 11 22 33", email: "contact@atlas.test" });
      expect(parNom.ok && parNom.annuaire.preuve).toMatch(/^Même nom que la fiche/);

      // Deux fiches au même nom : plus rien de certain par le nom — mais la fiche LIÉE au document du registre l'est.
      const homonyme = await prisma.companyContact.create({ data: { name: "ATLAS ÉVÉNEMENTIEL", kind: `${TAG}agence` } });
      try {
        const ambigu = await lirePieceDePaiement(lu);
        expect(ambigu.ok && ambigu.annuaire.retenu).toBeNull();
        await prisma.legalDocument.update({ where: { id: factureId }, data: { counterpartyIds: [fiche.id] } });
        const lie = await lirePieceDePaiement(lu);
        expect(lie.ok && lie.annuaire.retenu?.id).toBe(fiche.id);
        expect(lie.ok && lie.annuaire.preuve).toBe("La fiche liée à ce document du registre Legal.");
      } finally {
        await prisma.legalDocument.update({ where: { id: factureId }, data: { counterpartyIds: [] } });
        await prisma.companyContact.delete({ where: { id: homonyme.id } });
      }
      // (Les fiches que la personne ne voit pas sont écartées par `listPartyOptions` — la règle de l'annuaire, testée chez lui.)
    } finally {
      await prisma.companyContact.deleteMany({ where: { kind: `${TAG}agence` } });
    }
  });

  it("le montant demandé est confronté au TTC de la facture choisie", async () => {
    ACTOR = await acteur(demandeurId, "DIRECTION");
    const r = await createPaymentRequest(undefined, form({ title: `${TAG} écart`, payee: "Atlas", amount: "100000", paymentMethodStated: "1" }, [factureId]));
    expect(r.ok).toBe(false);
    expect(r.ecartMontant).toMatchObject({ total: 142800 });
  });

  it("la facture choisie est RÉFÉRENCÉE, et les Finances l'ouvrent par la demande — pas par Legal", async () => {
    const finances = await acteur(financesId, "FINANCE_BUDGET_MANAGER");
    const doc = { id: fichierId, entityType: "LEGAL_DOCUMENT" as const, entityId: factureId, stepKey: null };
    expect(await peutOuvrirDocument(finances, doc)).toBe(false);

    ACTOR = await acteur(demandeurId, "DIRECTION");
    const r = await createPaymentRequest(undefined, form({ title: `${TAG} Atlas`, payee: "Atlas Événementiel", amount: "142800", paymentMethodStated: "1" }, [factureId]));
    expect(r.ok, r.error).toBe(true);
    demandes.push(r.id!);
    const pieces = await prisma.paymentPiece.findMany({ where: { requestId: r.id! } });
    expect(pieces.map((p) => ({ documentId: p.documentId, kind: p.kind }))).toEqual([{ documentId: fichierId, kind: "INVOICE" }]);
    expect(await prisma.document.count({ where: { entityType: "PAYMENT_REQUEST", entityId: r.id! } })).toBe(0);

    expect(await peutOuvrirDocument(finances, doc)).toBe(true);
  });

  it("une facture ne se demande qu'une fois : montrée avec sa raison, refusée à l'envoi", async () => {
    ACTOR = await acteur(demandeurId, "DIRECTION");
    const fd = new FormData();
    fd.set("recherche", "FA-2026-77");
    const [ligne] = await documentsLegalPourDemande(fd);
    expect(ligne.avertissement).toMatch(/^Déjà dans la demande PAY-/);
    expect(ligne.refus).toMatch(/ne peut pas être demandée une seconde fois/);
    const r = await createPaymentRequest(undefined, form({ title: `${TAG} bis`, payee: "Atlas", amount: "142800", paymentMethodStated: "1" }, [factureId]));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ne peut pas être demandée une seconde fois : déjà dans la demande PAY-/);
  });

  it("un devis déposé entre au registre Legal ; un BC déposé reste joint à la demande seulement", async () => {
    ACTOR = await acteur(demandeurId, "DIRECTION");
    const r = await createPaymentRequest(undefined, form(
      { title: `${TAG} acompte`, payee: "Print Plus", amount: "50000", paymentMethodStated: "1" }, [],
      [{ nom: "devis-print.pdf", kind: "QUOTE" }, { nom: "bc-print.pdf", kind: "PURCHASE_ORDER" }],
    ));
    expect(r.ok, r.error).toBe(true);
    demandes.push(r.id!);
    const inscrits = await prisma.legalDocument.findMany({ where: { sourceType: "PAYMENT_REQUEST", sourceId: r.id! } });
    expect(inscrits.map((l) => ({ kind: l.kind, counterparty: l.counterparty, createdById: l.createdById }))).toEqual([{ kind: "QUOTE", counterparty: "Print Plus", createdById: demandeurId }]);
    expect(inscrits[0].title).toBe("Devis — devis-print — Print Plus");

    const pieces = await prisma.paymentPiece.findMany({ where: { requestId: r.id! }, orderBy: { position: "asc" } });
    const docs = await prisma.document.findMany({ where: { id: { in: pieces.map((p) => p.documentId) } }, select: { id: true, entityType: true, entityId: true } });
    const ou = (id: string) => docs.find((d) => d.id === id);
    expect(pieces.map((p) => [p.kind, ou(p.documentId)?.entityType])).toEqual([["QUOTE", "LEGAL_DOCUMENT"], ["PURCHASE_ORDER", "PAYMENT_REQUEST"]]);
    expect(ou(pieces[0].documentId)?.entityId).toBe(inscrits[0].id);
    const fil = await prisma.paymentRequestEvent.findMany({ where: { requestId: r.id! }, select: { message: true } });
    expect(fil.some((e) => e.message === "1 pièce inscrite au registre Legal depuis cette demande.")).toBe(true);
  });

  // « VOS DEMANDES EN COURS » (Direction, 09/11/2026) : ses demandes non terminées, les siennes seulement.
  it("la personne retrouve ses demandes en cours — pas celles d'un autre, ni les annulées", async () => {
    ACTOR = await acteur(demandeurId, "DIRECTION");
    const ouvertes = demandes.filter(Boolean);
    expect(ouvertes.length).toBeGreaterThan(0);
    await prisma.paymentRequest.update({ where: { id: ouvertes[0] }, data: { status: "CANCELLED" } });
    const miennes = await mesDemandesDePaiementEnCours();
    const ids = miennes.map((d) => d.id);
    for (const id of ouvertes.slice(1)) expect(ids).toContain(id);
    expect(ids).not.toContain(ouvertes[0]);
    expect(miennes.every((d) => d.reference.startsWith("PAY-") && d.pieces >= 0)).toBe(true);

    // SES FICHIERS, avec « Remplacer » là où l'action l'accepterait (Direction, 09/11/2026 : « changer le fichier »).
    const restante = miennes.find((d) => d.id === ouvertes[1])!;
    expect(restante.fichiers.length).toBe(restante.pieces);
    expect(restante.fichiers.length).toBeGreaterThan(0);
    expect(restante.fichiers.every((f) => f.nom.length > 0 && f.documentId)).toBe(true);
    expect(restante.fichiers.every((f) => f.remplacable && f.refus === null)).toBe(true);
    // Les Finances ouvrent l'examen : un fichier qu'elles n'ont pas signalé ne se remplace plus d'ici.
    await prisma.paymentRequest.update({ where: { id: ouvertes[1] }, data: { status: "UNDER_REVIEW" } });
    const enExamen = (await mesDemandesDePaiementEnCours()).find((d) => d.id === ouvertes[1])!;
    expect(enExamen.fichiers.every((f) => !f.remplacable && /quand elles la signalent/.test(f.refus ?? ""))).toBe(true);

    ACTOR = await acteur(financesId, "FINANCE_BUDGET_MANAGER");
    const autres = (await mesDemandesDePaiementEnCours()).map((d) => d.id);
    for (const id of ouvertes) expect(autres).not.toContain(id);
  });
});
