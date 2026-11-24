import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ÉCRAN « COMPTABILITÉ » CONTRE LA BASE (maquette validée, 24/11/2026).
 *
 *   • une DÉPENSE sans justificatif est refusée par le serveur (et le remède est dit) ; avec sa pièce, la pièce est SUR
 *     l'écriture et la ligne l'affiche ;
 *   • la recherche ramène une facture du registre que rien ne paie (« Facture non payée », geste « Créer sa demande de
 *     paiement »), et plus rien à demander une fois qu'elle justifie un paiement ;
 *   • le cloisonnement : une société hors de ses droits retombe sur la sienne, ses écritures et ses factures n'existent
 *     pas, ni dans la liste, ni dans la recherche, ni par leur identifiant ;
 *   • contre-passer exige un motif et ne se fait qu'une fois ; demander la pièce se lit sur la ligne ;
 *   • Legal ne compose plus de facture : elle se compose ici.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerDocumentsEtContenu, retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { getAccess } from "@/lib/rbac";
import { createTransaction } from "./actions-tresorerie";
import { contrePasserEcriture, demanderPieceEcriture, joindreJustificatifEcriture } from "./actions-comptabilite";
import { chargerComptabilite } from "./infra/requetes/comptabilite";
import { REFUS_DEPENSE_SANS_JUSTIFICATIF } from "./domaine/comptabilite-vue";
import { compositionDesPieces, TYPES_COMPOSES_DANS_LEGAL, TYPES_COMPOSES_EN_COMPTABILITE } from "@/lib/queries/composition-pieces";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zcompta${Date.now().toString(36)}`;
const ids = { compte: "", A: "", B: "", fin: "", demandeur: "", factureA: "", factureB: "", txB: "", depense: "", sansPiece: "" };
const form = (o: Record<string, string | File>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const pdf = (nom: string) => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, Math.floor(Math.random() * 250)])], nom, { type: "application/pdf" });
const moisCourant = () => new Date(Date.now() + 3600_000).toISOString().slice(0, 7);

suite("Comptabilité — justificatif, recherche des factures, cloisonnement, gestes du panneau", () => {
  beforeAll(async () => {
    [ids.A, ids.B] = (await Promise.all(["Alpha", "Beta"].map((n) => prisma.company.create({ data: { name: `${TAG}${n}` } })))).map((c) => c.id);
    const fin = await prisma.user.create({ data: { name: `${TAG} Karim`, email: `${TAG}f@t.dz`, role: "COORDINATOR", passwordHash: "x" } });
    const dem = await prisma.user.create({ data: { name: `${TAG} Sara`, email: `${TAG}d@t.dz`, role: "COORDINATOR", passwordHash: "x" } });
    ids.fin = fin.id; ids.demandeur = dem.id;
    // Le comptable est rattaché à Alpha seulement : Beta n'est pas à lui.
    await prisma.employee.create({ data: { fullName: `${TAG} Karim`, companyId: ids.A, userId: fin.id, isActive: true } });
    for (const module of ["FINANCES", "FINANCES_COMPTABILITE"]) {
      await prisma.userAccess.create({ data: { userId: fin.id, module, canView: true, canCreate: true, canUpdate: true, canDelete: true, scope: "ALL" } });
    }
    // Le compte d'Alpha : les écritures du banc s'y figent, et aucun banc voisin ne les voit sur le sien.
    ids.compte = (await prisma.treasuryAccount.create({ data: { name: `${TAG} BNA courant`, openingBalance: 0, companyId: ids.A, principal: true } })).id;
    ACTOR = { id: fin.id, name: fin.name, email: fin.email, role: "COORDINATOR", secondaryRole: null, access: await getAccess(fin.id, "COORDINATOR") } as unknown as CurrentUser;

    // Une facture REÇUE d'Alpha, que rien ne paie ; une facture de Beta, invisible pour lui.
    ids.factureA = (await prisma.legalDocument.create({
      data: { title: `${TAG} Analyses qualité`, reference: `${TAG}-F2231`, kind: "INVOICE", counterparty: `${TAG} Labo Mitidja`, amount: 312400, companyId: ids.A, startDate: new Date() },
    })).id;
    ids.factureB = (await prisma.legalDocument.create({
      data: { title: `${TAG} Étuis carton`, reference: `${TAG}-F0381`, kind: "INVOICE", counterparty: `${TAG} Emballages`, amount: 418000, companyId: ids.B, startDate: new Date() },
    })).id;
    ids.txB = (await prisma.financeTransaction.create({
      data: { reference: `${TAG}-B1`, date: new Date(), direction: "OUT", category: "FOURNISSEUR", label: `${TAG} dépense Beta`, amount: 9000, counterparty: `${TAG} Emballages`, companyId: ids.B, createdById: fin.id },
    })).id;
    // Une dépense d'Alpha réglée par un ordre que Sara a demandé, sans pièce.
    ids.sansPiece = (await prisma.financeTransaction.create({
      data: { reference: `${TAG}-A1`, date: new Date(), direction: "OUT", category: "FOURNISSEUR", label: `${TAG} Analyses`, amount: 312400, counterparty: `${TAG} Labo Mitidja`, companyId: ids.A, treasuryAccountId: ids.compte, createdById: fin.id },
    })).id;
    await prisma.expenseOrder.create({
      data: { reference: `${TAG}-OD1`, label: `${TAG} analyses`, amount: 312400, status: "PAID", companyId: ids.A, requestedById: dem.id, transactionId: ids.sansPiece, paidDate: new Date(), sourceType: "AD_PRO_ITEM", sourceId: `${TAG}-poste` },
    });
  }, 60_000);

  afterAll(async () => {
    const txs = (await prisma.financeTransaction.findMany({ where: { OR: [{ companyId: { in: [ids.A, ids.B] } }, { label: { startsWith: TAG } }] }, select: { id: true } })).map((t) => t.id);
    await retirerDocumentsEtContenu({ where: { entityType: "FINANCE_TRANSACTION", entityId: { in: txs } } }).catch(() => undefined);
    // La copie de la pièce dans le Drive de qui l'a déposée (`attachFiles`, en arrière-plan).
    await retirerNoeudsDriveEtContenu({ where: { ownerId: { in: [ids.fin, ids.demandeur] } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [ids.fin, ids.demandeur] } } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { userId: { in: [ids.fin, ids.demandeur] } } }).catch(() => undefined);
    await prisma.expenseOrder.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.financeTransaction.updateMany({ where: { id: { in: txs } }, data: { compensationDeId: null, justificatifFactureId: null } }).catch(() => undefined);
    await prisma.financeTransaction.deleteMany({ where: { id: { in: txs } } }).catch(() => undefined);
    await prisma.legalDocument.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.employee.deleteMany({ where: { userId: { in: [ids.fin, ids.demandeur] } } }).catch(() => undefined);
    await prisma.userAccess.deleteMany({ where: { userId: { in: [ids.fin, ids.demandeur] } } }).catch(() => undefined);
    await retirerComptesEtSemis({ where: { id: { in: [ids.fin, ids.demandeur] } } }).catch(() => undefined);
    await prisma.treasuryAccount.deleteMany({ where: { id: ids.compte } }).catch(() => undefined);
    await prisma.company.deleteMany({ where: { id: { in: [ids.A, ids.B] } } }).catch(() => undefined);
  }, 60_000);

  it("une DÉPENSE sans justificatif est refusée par le serveur — rien n'est écrit, le remède est dit", async () => {
    const r = await createTransaction(undefined, form({ label: `${TAG} brochures`, amount: "96500", direction: "OUT", category: "FOURNISSEUR", counterparty: `${TAG} Imprimerie`, companyId: ids.A, treasuryAccountId: ids.compte }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe(REFUS_DEPENSE_SANS_JUSTIFICATIF);
    expect(await prisma.financeTransaction.count({ where: { label: `${TAG} brochures` } })).toBe(0);
    // Une RECETTE sans pièce passe : refuser un encaissement ferait disparaître de l'argent reçu.
    const rec = await createTransaction(undefined, form({ label: `${TAG} règlement client`, amount: "8450000", direction: "IN", category: "RECETTE", counterparty: `${TAG} Medi-Distrib`, companyId: ids.A, treasuryAccountId: ids.compte }));
    expect(rec.ok, rec.error).toBe(true);
  });

  it("avec sa pièce, la dépense s'enregistre, la pièce est SUR l'écriture, et la ligne l'affiche « ✓ »", async () => {
    const r = await createTransaction(undefined, form({
      label: `${TAG} brochures`, amount: "96500", direction: "OUT", category: "FOURNISSEUR", counterparty: `${TAG} Imprimerie`, companyId: ids.A, treasuryAccountId: ids.compte,
      justificatif: pdf("Facture_Imprimerie.pdf"), typePiece: "Facture",
    }));
    expect(r.ok, r.error).toBe(true);
    ids.depense = r.id!;
    const doc = await prisma.document.findFirstOrThrow({ where: { entityType: "FINANCE_TRANSACTION", entityId: r.id! } });
    expect([doc.name, doc.category]).toEqual(["Facture_Imprimerie.pdf", "INVOICE"]);

    const d = await chargerComptabilite(ACTOR!, { societe: ids.A, vue: "dep", periode: moisCourant() });
    const ligne = d.lignes.find((l) => l.id === r.id);
    expect(ligne?.justificatif).toEqual({ present: true, libelle: "✓ Facture_Imprimerie.pdf" });
    expect(ligne?.origine).toBe("Écriture manuelle");
    const sans = d.lignes.find((l) => l.id === ids.sansPiece);
    expect(sans?.justificatif.present).toBe(false);
    expect(sans?.origine).toBe(`Ad & Pro · ${TAG}-OD1`);
    expect(d.totaux.dep).toBeGreaterThanOrEqual(96500 + 312400);
    // Le filtre « Sans justificatif » ne garde que celles qui n'en ont pas.
    const filtre = await chargerComptabilite(ACTOR!, { societe: ids.A, vue: "dep", periode: moisCourant(), sans: "1" });
    expect(filtre.lignes.map((l) => l.id)).toContain(ids.sansPiece);
    expect(filtre.lignes.map((l) => l.id)).not.toContain(ids.depense);
  });

  it("la RECHERCHE ramène une facture du registre que rien ne paie : « Facture non payée », avec le geste de demande", async () => {
    const d = await chargerComptabilite(ACTOR!, { societe: ids.A, q: `${TAG}-F2231` });
    expect(d.recherche).not.toBeNull();
    const f = d.recherche!.factures.find((x) => x.id === ids.factureA);
    expect(f).toMatchObject({ etat: "NON_PAYEE", etatLibelle: "Facture non payée", peutDemander: true, peutRattacher: true, montant: 312400 });
    // Le montant aussi trouve : « 312 400 » ramène la facture ET la dépense du même montant.
    const parMontant = await chargerComptabilite(ACTOR!, { societe: ids.A, q: "312 400" });
    expect(parMontant.recherche!.factures.map((x) => x.id)).toContain(ids.factureA);
    expect(parMontant.recherche!.depenses.map((x) => x.id)).toContain(ids.sansPiece);
    // Le panneau de la facture propose le paiement déjà parti du même fournisseur, même montant, en tête.
    const panneau = await chargerComptabilite(ACTOR!, { societe: ids.A, facture: ids.factureA });
    expect(panneau.facture?.candidats[0]).toMatchObject({ id: ids.sansPiece, suggere: true });
  });

  it("CLOISONNEMENT : Beta demandée retombe sur Alpha ; ni ses écritures, ni ses factures — même par identifiant", async () => {
    const d = await chargerComptabilite(ACTOR!, { societe: ids.B, vue: "dep", periode: moisCourant(), q: TAG, ecriture: ids.txB, facture: ids.factureB });
    expect(d.societes.map((s) => s.id)).toEqual([ids.A]);
    expect(d.societeId).toBe(ids.A);
    expect(d.recherche!.factures.map((f) => f.id)).not.toContain(ids.factureB);
    expect(d.recherche!.depenses.map((l) => l.id)).not.toContain(ids.txB);
    expect(d.ecriture).toBeNull();
    expect(d.facture).toBeNull();
    // Les gestes non plus : l'écriture de Beta n'existe pas pour lui.
    expect((await contrePasserEcriture(form({ id: ids.txB, motif: "Saisie en double" }))).ok).toBe(false);
    expect((await joindreJustificatifEcriture(form({ id: ids.txB, factureId: ids.factureB }))).ok).toBe(false);
  });

  it("RATTACHER la facture au paiement déjà fait : l'écriture est justifiée, la facture n'est plus « à payer » — et une seule fois", async () => {
    const r = await joindreJustificatifEcriture(form({ id: ids.sansPiece, factureId: ids.factureA }));
    expect(r.ok, r.error).toBe(true);
    const d = await chargerComptabilite(ACTOR!, { societe: ids.A, q: `${TAG}-F2231`, ecriture: ids.sansPiece });
    expect(d.recherche!.factures.find((x) => x.id === ids.factureA)).toMatchObject({ etat: "PAYEE", peutDemander: false });
    expect(d.ecriture?.justificatif.present).toBe(false); // la facture n'a pas de fichier : elle justifie, sans pièce à montrer
    // La même facture ne justifie pas un second paiement.
    expect((await joindreJustificatifEcriture(form({ id: ids.depense, factureId: ids.factureA }))).ok).toBe(false);
  });

  it("DEMANDER LA PIÈCE : au demandeur de l'ordre, tracé — la ligne dit « ✕ manquant · demandé », le panneau dit à qui", async () => {
    const refus = await demanderPieceEcriture(form({ id: ids.sansPiece, destinataireId: ids.B }));
    expect(refus.ok).toBe(false);
    const r = await demanderPieceEcriture(form({ id: ids.sansPiece, destinataireId: ids.demandeur }));
    expect(r.ok, r.error).toBe(true);
    expect(await prisma.notification.count({ where: { userId: ids.demandeur, title: { contains: `${TAG}-A1` } } })).toBe(1);
    const d = await chargerComptabilite(ACTOR!, { societe: ids.A, vue: "dep", periode: moisCourant(), ecriture: ids.sansPiece });
    expect(d.lignes.find((l) => l.id === ids.sansPiece)?.justificatif.libelle).toBe("✕ manquant · demandé");
    expect(d.ecriture?.demandePiece).toMatchObject({ fois: 1 });
    expect(d.ecriture?.demandePiece?.a).toContain(`${TAG} Sara`);
    expect(d.ecriture?.chaine[0]).toMatchObject({ etape: "Demandé par" });
  });

  it("CONTRE-PASSER : motif obligatoire ; une écriture inverse liée ; l'originale reste, barrée ; une seule fois", async () => {
    expect((await contrePasserEcriture(form({ id: ids.depense }))).error).toMatch(/Choisissez un motif/);
    const r = await contrePasserEcriture(form({ id: ids.depense, motif: "Saisie en double", precision: "ressaisie le lendemain" }));
    expect(r.ok, r.error).toBe(true);
    const inverse = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: r.id! } });
    expect([Number(inverse.amount), inverse.direction, inverse.compensation, inverse.compensationDeId]).toEqual([-96500, "OUT", "CONTRE_PASSATION", ids.depense]);
    expect(inverse.notes).toContain("Saisie en double — ressaisie le lendemain");
    expect((await contrePasserEcriture(form({ id: ids.depense, motif: "Saisie en double" }))).error).toMatch(/déjà contre-passée/);
    expect((await contrePasserEcriture(form({ id: r.id!, motif: "Erreur de montant" }))).ok).toBe(false);

    const d = await chargerComptabilite(ACTOR!, { societe: ids.A, vue: "dep", periode: moisCourant(), ecriture: ids.depense });
    expect(d.lignes.find((l) => l.id === ids.depense)?.contrePassee).toBe(true);
    expect(d.lignes.find((l) => l.id === r.id)?.origine).toBe("Contre-passation");
    expect(d.ecriture?.compensationTexte).toContain(inverse.reference);
  });

  it("LE RÉSULTAT de l'année se lit en base, mois par mois, avec son détail par catégorie", async () => {
    const d = await chargerComptabilite(ACTOR!, { societe: ids.A, vue: "res" });
    const mois = d.resultat.donnees.lignes.find((l) => l.mois === moisCourant())!;
    expect(mois.recettes).toBe(8_450_000);
    // 312 400 (ordre) + 96 500 − 96 500 (contre-passée)
    expect(mois.depenses).toBe(312_400);
    expect(mois.parCategorie.depenses).toEqual([{ categorie: "FOURNISSEUR", montant: 312_400 }]);
  });

  it("COMPOSER UNE FACTURE vit en Comptabilité : Legal ne la propose plus, le droit d'émettre reste le même", async () => {
    const legal = await compositionDesPieces(ACTOR!, TYPES_COMPOSES_DANS_LEGAL);
    const compta = await compositionDesPieces(ACTOR!, TYPES_COMPOSES_EN_COMPTABILITE);
    const tout = await compositionDesPieces(ACTOR!);
    expect(tout?.types).toContain("FACTURE");
    expect(legal?.types ?? []).not.toContain("FACTURE");
    expect(compta?.types).toEqual(["FACTURE"]);
  });
});
