import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import PizZip from "pizzip";
import type { Prisma } from "@prisma/client";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { legalWriteAllowed } from "@/lib/lecteurs/legal";
import { refusPlafondAvoir } from "@/lib/lecteurs/avoir";
import { totauxAvoirsActifs } from "@/lib/lecteurs/avoirs-actifs";
import { refusChampsDuFichier } from "@/lib/legal/piece-emise";
import { portsArtefact } from "@/platform/in-process/artifact/ports";
import { emettreDocumentDrive, previsualiserDocument, reviserDocumentDrive, type DemandeDocument, type DocumentEmis } from "@/platform/in-process/artifact/factory";
import { cancelLegalDocument, createLegalDocument, updateLegalDocument } from "./legal-actions";
import { emettreAvoir, emettrePieceCommerciale } from "./fabrique-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'AVOIR — LA CORRECTION D'UNE FACTURE ÉMISE, QUI NE SE RÉÉCRIT PAS (audit 360°, lot C4d2b2, R15 — §118.195).
 *
 * La fabrique conseillait « Émettre un avoir » sur une facture, et les types ne l'offraient pas. L'avoir naît
 * désormais de SA facture : client, numéro et date d'origine, TVA, remise et taxes viennent du LIEN ; il ne
 * crédite jamais plus que ce qui reste (avoirs déjà émis compris, revérifié sous verrou) ; le règlement de la
 * facture encaisse son NET ; une facture ne s'annule pas sous ses avoirs.
 *
 * Par les VRAIS points d'entrée (l'action de la fiche, la fabrique, les actions Legal), avec un acteur des Finances
 * SANS vue globale (§118.104).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = `__avoir__${Date.now()}`;
const ANNEE = new Date().getUTCFullYear();
const T0 = new Date();
let sa: CurrentUser;
let fin: CurrentUser;
let companyId = "";
/** Ce que le formulaire générique crée hors de la société du banc, retiré à la fin. */
const docsHorsSociete: string[] = [];
const contacts: string[] = [];

// 100 × 250 + 2 × 9 000 = 43 000 HT, TVA 19 % → 51 170 TTC.
const LIGNES: DemandeDocument["lignes"] = [
  { designation: "Fiches posologiques — impression quadri", quantite: 100, prixUnitaire: 250 },
  { designation: "Kakémonos 80 × 200", quantite: 2, prixUnitaire: 9_000 },
];

async function facture(tiers: string, extra: Partial<DemandeDocument> = {}): Promise<DocumentEmis> {
  const r = await emettreDocumentDrive(sa, {
    type: "FACTURE", societe: companyId, tiers: { nom: `${TAG} ${tiers}`, adresse: "Alger", nif: "000016098765432" },
    lignes: LIGNES, date: `${ANNEE}-09-05`, echeance: `${ANNEE}-10-05`, modePaiement: "VIREMENT", ...extra,
  });
  if (!r.ok) throw new Error(`facture refusée : ${r.motif}`);
  return r;
}

/** Le formulaire de « Émettre un avoir », tel que l'écran l'envoie. */
function avoir(factureId: string, lignes: { designation: string; quantite: number; prix: number }[], motif?: string): FormData {
  const fd = new FormData();
  fd.set("factureId", factureId);
  for (const l of lignes) {
    fd.append("ligneDesignation", l.designation);
    fd.append("ligneDetails", "");
    fd.append("ligneQuantite", String(l.quantite));
    fd.append("lignePrix", String(l.prix));
    fd.append("ligneRemise", "");
    fd.append("ligneTva", "");
    fd.append("ligneSection", "0");
  }
  if (motif !== undefined) fd.set("motif", motif);
  return fd;
}

const avoirsDe = (factureId: string) => prisma.legalDocument.findMany({
  where: { chainFromId: factureId, kind: "CREDIT_NOTE" }, orderBy: { createdAt: "asc" },
  select: { id: true, reference: true, amount: true, status: true, direction: true, counterparty: true, custom: true, driveNodeId: true },
});

async function texteDuWord(userId: string, nodeId: string): Promise<string> {
  const octets = await portsArtefact.documents.lire(userId, nodeId, 1);
  if (!octets) throw new Error("Word illisible");
  const xml = new PizZip(octets).file("word/document.xml")!.asText();
  return xml.replace(/<[^>]+>/g, " ").replace(/&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, secondaryRole: null, access: await getAccess(id, role), mustChangePassword: false };
}

/**
 * DEUX AVOIRS LANCÉS ENSEMBLE, la facture verrouillée par le banc : avec la règle, tous deux attendent à leur verrou
 * de la facture ; sans elle, l'un attend à l'écriture de son avoir (la clé étrangère vers la facture), l'autre à son
 * numéro (la séquence que le premier tient) — mesuré : ne compter que le premier faisait expirer la barrière au lieu de
 * laisser passer les deux avoirs, et le sabotage tombait sur un délai, pas sur ce qu'il casse. La barrière attend
 * qu'ils soient DEUX à attendre, puis relâche.
 */
async function deuxEnsemble<T>(factureId: string, a: () => Promise<T>, b: () => Promise<T>): Promise<[T, T]> {
  let ga!: Promise<T>, gb!: Promise<T>;
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRawUnsafe(`SELECT 1 FROM "LegalDocument" WHERE id = $1 FOR UPDATE`, factureId);
    ga = a(); gb = b();
    ga.catch(() => undefined); gb.catch(() => undefined);
    const debut = Date.now();
    for (;;) {
      await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
      const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND (query ILIKE ${'%"LegalDocument"%'} OR query ILIKE ${'%"DocumentSequence"%'})`;
      if (n >= 2) break;
      if (Date.now() - debut > 30_000) throw new Error("les deux avoirs n'ont pas atteint la barrière");
      await new Promise((r) => setTimeout(r, 25));
    }
  }, { timeout: 60_000 });
  return Promise.all([ga, gb]);
}

suite("L'avoir — la correction d'une facture émise (§118.195)", () => {
  beforeAll(async () => {
    const mk = (s: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG} ${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" }, select: { id: true } });
    const [s1, f1] = await Promise.all([mk("pdg", "SUPER_ADMIN"), mk("fin", "FINANCE_BUDGET_MANAGER")]);
    companyId = (await prisma.company.create({ data: { name: `${TAG} Pharma`, shortName: TAG.slice(0, 12), color: "#1B7F79" } })).id;
    await Promise.all([
      prisma.companyLegalIdentity.create({
        data: {
          companyId, legalName: `${TAG} Pharma SARL`, legalForm: "SARL", shareCapital: "10 000 000 DZD", rcNumber: "16/00-1234567B21", nif: "001916012345678",
          nis: "001916012345690", taxArticle: "16012345678", headOffice: "12 rue des Frères Bouadou, Alger", phone: "+213 21 00 00 00", email: "contact@t.dz",
          bankName: "BNA", bankAgency: "Hydra", rib: "001 00123 0123456789 45", managerName: "Amine Djouamai", managerTitle: "Gérant",
        },
      }),
      prisma.userCompanyAccess.create({ data: { userId: f1.id, companyId, canEdit: true } }),
    ]);
    [sa, fin] = await Promise.all([acteur(s1.id, "SUPER_ADMIN"), acteur(f1.id, "FINANCE_BUDGET_MANAGER")]);
  }, 60_000);

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: docsHorsSociete } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: docsHorsSociete } } }).catch(() => {});
    await prisma.companyContact.deleteMany({ where: { id: { in: contacts } } }).catch(() => {});
    const pieces = await prisma.legalDocument.findMany({ where: { companyId }, select: { id: true, settlementTxId: true } }).catch(() => []);
    const ids = pieces.map((p) => p.id);
    const reglements = pieces.map((p) => p.settlementTxId).filter((x): x is string => Boolean(x));
    await prisma.legalDocument.updateMany({ where: { id: { in: ids } }, data: { settlementTxId: null } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { id: { in: reglements } } }).catch(() => {});
    for (const id of ids) await prisma.notification.deleteMany({ where: { createdAt: { gte: T0 }, link: { contains: id } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    const comptes = [sa?.id, fin?.id].filter(Boolean) as string[];
    await prisma.fileVersion.deleteMany({ where: { node: { ownerId: { in: comptes } } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: comptes }, type: "FILE" } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.userCompanyAccess.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.company.delete({ where: { id: companyId } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 90_000);

  it("les Finances émettent un avoir depuis la facture : client, numéro et date d'origine viennent du LIEN, la pièce le dit", async () => {
    // Prémisse : les Finances écrivent les avoirs (la chaîne de facturation), pas un compte qui ne voit que Legal.
    expect(legalWriteAllowed({ onLegal: userCan(fin, "LEGAL", "CREATE"), onFinances: userCan(fin, "FINANCES", "CREATE"), kind: "CREDIT_NOTE" })).toBe(true);
    const f = await facture("Pharmacie A1");
    ACTOR = fin;
    const r = await emettreAvoir(undefined, avoir(f.legalDocumentId, [{ designation: "Retour de 20 fiches posologiques", quantite: 20, prix: 250 }], "Retour de 20 fiches endommagées à la livraison."));
    expect(r.ok, r.error).toBe(true);
    // 20 × 250 = 5 000 HT → 5 950 TTC ; net de la facture : 51 170 − 5 950 = 45 220.
    expect(r.message).toMatch(new RegExp(`^Avoir ${r.reference} émis : 5\\s950,00 DZD TTC crédités sur la facture ${f.reference} — net de la facture : 45\\s220,00 DZD\\.$`));
    const [av] = await avoirsDe(f.legalDocumentId);
    expect(av.reference).toMatch(/^AV-/);
    expect({ amount: Number(av.amount), status: av.status, direction: av.direction, counterparty: av.counterparty })
      .toEqual({ amount: 5950, status: "ACTIVE", direction: null, counterparty: `${TAG} Pharmacie A1` });
    const spec = (av.custom as { fabrique: { type: string; spec: { referenceAmont: string; referenceAmontDate: string; objet: string; modePaiement: string | null } } }).fabrique;
    expect(spec.type).toBe("AVOIR");
    expect(spec.spec).toMatchObject({ referenceAmont: f.reference, referenceAmontDate: `${ANNEE}-09-05`, objet: "Retour de 20 fiches endommagées à la livraison.", modePaiement: null });
    const texte = await texteDuWord(fin.id, av.driveNodeId!);
    for (const attendu of ["Avoir", "Numéro d'avoir", "Facture d'origine", f.reference, "Motif", "Retour de 20 fiches endommagées", "MONTANT CRÉDITÉ", "Arrêté le présent avoir à la somme de"]) {
      expect(texte, attendu).toContain(attendu);
    }
    // Un avoir ne se paie pas : ni « somme à payer », ni mode de paiement imprimé.
    expect(texte).not.toContain("SOMME À PAYER");
    expect(texte).not.toContain("PAIEMENT PAR VIREMENT");
  }, 120_000);

  it("l'avoir reprend le CALCUL de sa facture — TVA réduite, remise globale et taxe additionnelle, jamais les défauts de la société", async () => {
    // 43 000 HT, remise globale de 10 % → 38 700 ; TVA 9 % → 3 483 ; taxe de 2 % hors base → 774 : 42 957 TTC.
    const f = await facture("Pharmacie A1b", { tvaDefaut: 0.09, remiseGlobale: 0.1, taxes: [{ libelle: "Taxe Pub", taux: 0.02 }] });
    ACTOR = fin;
    const r = await emettreAvoir(undefined, avoir(f.legalDocumentId, [{ designation: "Retour de 20 fiches posologiques", quantite: 20, prix: 250 }], "Retour de 20 fiches."));
    expect(r.ok, r.error).toBe(true);
    // 5 000 HT − 10 % → 4 500 ; taxe 90, TVA 405 → 4 995 TTC. Sans la remise, il dirait 5 550 ; avec les défauts de la
    // société (19 %, sans remise ni taxe), 5 950 — dans les deux cas un crédit que la facture n'a jamais porté.
    expect(r.message).toMatch(/4\s995,00 DZD TTC crédités .* net de la facture : 37\s962,00 DZD\.$/);
    const [av] = await avoirsDe(f.legalDocumentId);
    expect((av.custom as { fabrique: { spec: { remiseGlobale: number | null } } }).fabrique.spec.remiseGlobale).toBe(0.1);
  }, 120_000);

  it("PLAFOND : un avoir ne crédite pas plus que ce qui reste — avoirs déjà émis compris — et rien n'est émis", async () => {
    const f = await facture("Pharmacie A2");
    ACTOR = fin;
    const premier = await emettreAvoir(undefined, avoir(f.legalDocumentId, [{ designation: "Remise commerciale", quantite: 1, prix: 40_000 }], "Remise accordée."));
    expect(premier.ok, premier.error).toBe(true);
    // 40 000 HT → 47 600 TTC ; reste 51 170 − 47 600 = 3 570. Un second avoir de 5 000 HT (5 950 TTC) dépasse.
    const trop = await emettreAvoir(undefined, avoir(f.legalDocumentId, [{ designation: "Seconde remise", quantite: 1, prix: 5_000 }], "Encore."));
    expect(trop).toEqual({ ok: false, error: refusPlafondAvoir(f.reference, 5950, 3570) });
    expect(await avoirsDe(f.legalDocumentId)).toHaveLength(1);
    // Le reste EXACT passe, puis la facture est entièrement créditée.
    const exact = await emettreAvoir(undefined, avoir(f.legalDocumentId, [{ designation: "Solde", quantite: 1, prix: 3_000 }], "Solde."));
    expect(exact.ok, exact.error).toBe(true);
    expect(exact.message).toContain("net de la facture : 0,00 DZD");
    const plus = await emettreAvoir(undefined, avoir(f.legalDocumentId, [{ designation: "Rien", quantite: 1, prix: 1 }], "Rien."));
    expect(plus.error).toBe(`La facture ${f.reference} est déjà entièrement créditée par ses avoirs : il n'y reste rien à créditer.`);
  }, 120_000);

  it("un avoir ANNULÉ libère ce qu'il créditait", async () => {
    const f = await facture("Pharmacie A3");
    ACTOR = fin;
    const r = await emettreAvoir(undefined, avoir(f.legalDocumentId, [{ designation: "Remise", quantite: 1, prix: 40_000 }], "Remise."));
    expect(r.ok, r.error).toBe(true);
    await prisma.legalDocument.update({ where: { id: r.id! }, data: { status: "CANCELLED" } });
    // Le total que la LISTE lit (compte « à régler », filtre) ne compte que l'avoir actif : 40 000 HT, soit 47 600 TTC.
    expect((await totauxAvoirsActifs([f.legalDocumentId])).get(f.legalDocumentId) ?? 0).toBe(0);
    const encore = await emettreAvoir(undefined, avoir(f.legalDocumentId, [{ designation: "Remise refaite", quantite: 1, prix: 40_000 }], "Remise refaite."));
    expect(encore.ok, encore.error).toBe(true);
    expect((await totauxAvoirsActifs([f.legalDocumentId])).get(f.legalDocumentId)).toBe(47_600);
  }, 120_000);

  it("L'ÉTAT D'ABORD : facture annulée, pièce déposée, avoir sans facture — refusés sans demander de motif ; le motif ensuite", async () => {
    ACTOR = fin;
    const annulee = await facture("Pharmacie A4");
    await prisma.legalDocument.update({ where: { id: annulee.legalDocumentId }, data: { status: "CANCELLED" } });
    const r1 = await emettreAvoir(undefined, avoir(annulee.legalDocumentId, [{ designation: "x", quantite: 1, prix: 10 }]));
    expect(r1.error).toBe(`La facture ${annulee.reference} est annulée : il n'y a rien à créditer.`);
    const deposee = await prisma.legalDocument.create({
      data: { title: `${TAG} facture déposée`, kind: "INVOICE", status: "ACTIVE", companyId, counterparty: "Fournisseur", amount: 1000, startDate: new Date(`${ANNEE}-09-01`) },
      select: { id: true },
    });
    const r2 = await emettreAvoir(undefined, avoir(deposee.id, [{ designation: "x", quantite: 1, prix: 10 }]));
    expect(r2.error).toBe("Un avoir se rattache à une facture émise par la plateforme : cette pièce n'en est pas une — une facture déposée se corrige par la pièce que son émetteur envoie.");
    // Le compositeur général, nature AVOIR sans facture : la fabrique nomme le geste.
    const fd = new FormData();
    for (const [k, v] of Object.entries({ type: "AVOIR", societe: companyId, tiersNom: `${TAG} Client`, date: `${ANNEE}-09-10` })) fd.set(k, v);
    fd.append("ligneDesignation", "Ligne"); fd.append("ligneQuantite", "1"); fd.append("lignePrix", "100");
    const r3 = await emettrePieceCommerciale(undefined, fd);
    expect(r3.ok).toBe(false);
    expect(r3.error).toContain("Un avoir corrige UNE facture : émettez-le depuis la fiche de la facture (« Émettre un avoir »).");
    // Une facture d'une AUTRE société : un avoir se rattache à SA facture, émis au nom de la même société.
    const autre = await prisma.company.create({ data: { name: `${TAG} Autre`, shortName: `${TAG.slice(0, 8)}AU`, color: "#1B7F79" }, select: { id: true } });
    const pourAutre = await facture("Pharmacie A4 ter");
    const r5 = await emettreDocumentDrive(sa, { type: "AVOIR", societe: autre.id, chainFromId: pourAutre.legalDocumentId, tiers: { nom: "" }, lignes: [{ designation: "x", quantite: 1, prixUnitaire: 10 }], objet: "Retour." });
    expect(r5.ok).toBe(false);
    expect(r5.ok ? "" : r5.motif).toBe("La facture à créditer appartient à une autre société.");
    for (const r of [r1, r2, r3]) expect(r.error).not.toContain("Avoir sans motif");
    // L'état en règle, le motif est exigé.
    const ok = await facture("Pharmacie A4 bis");
    const r4 = await emettreAvoir(undefined, avoir(ok.legalDocumentId, [{ designation: "Retour", quantite: 1, prix: 100 }], "   "));
    expect(r4.error).toContain("Avoir sans motif : dites pourquoi la facture est créditée");
    expect(await avoirsDe(ok.legalDocumentId)).toHaveLength(0);
  }, 150_000);

  it("DEUX AVOIRS EN MÊME TEMPS sur la même facture ne lisent pas le même reste : un seul passe", async () => {
    const f = await facture("Pharmacie A5");
    ACTOR = fin;
    // Chacun crédite 30 000 HT (35 700 TTC) : ensemble, 71 400 > 51 170.
    const [r1, r2] = await deuxEnsemble(f.legalDocumentId,
      () => emettreAvoir(undefined, avoir(f.legalDocumentId, [{ designation: "Avoir A", quantite: 1, prix: 30_000 }], "A.")),
      () => emettreAvoir(undefined, avoir(f.legalDocumentId, [{ designation: "Avoir B", quantite: 1, prix: 30_000 }], "B.")));
    expect([r1, r2].filter((r) => r.ok)).toHaveLength(1);
    expect([r1, r2].find((r) => !r.ok)?.error).toBe(refusPlafondAvoir(f.reference, 35700, 51170 - 35700));
    expect((await avoirsDe(f.legalDocumentId)).filter((a) => a.status !== "CANCELLED")).toHaveLength(1);
  }, 120_000);

  it("LE RÈGLEMENT ENCAISSE LE NET, et un avoir sur une facture déjà réglée dit qu'il est dû au client", async () => {
    const f = await facture("Pharmacie A6");
    ACTOR = fin;
    const r = await emettreAvoir(undefined, avoir(f.legalDocumentId, [{ designation: "Retour", quantite: 1, prix: 10_000 }], "Retour."));
    expect(r.ok, r.error).toBe(true);
    // 10 000 HT → 11 900 TTC ; net 51 170 − 11 900 = 39 270 : c'est ce que le règlement encaisse.
    const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: f.legalDocumentId }, select: { title: true } });
    const reg = await updateLegalDocument((() => { const fd = new FormData(); fd.set("id", f.legalDocumentId); fd.set("title", doc.title); fd.set("paidDate", `${ANNEE}-10-02`); return fd; })());
    expect(reg.ok, reg.ok ? "" : reg.error).toBe(true);
    const lien = await prisma.legalDocument.findUniqueOrThrow({ where: { id: f.legalDocumentId }, select: { settlementTxId: true } });
    const tx = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: lien.settlementTxId! }, select: { amount: true, direction: true } });
    expect({ amount: Number(tx.amount), direction: tx.direction }).toEqual({ amount: 39270, direction: "IN" });
    const apres = await emettreAvoir(undefined, avoir(f.legalDocumentId, [{ designation: "Geste commercial", quantite: 1, prix: 1_000 }], "Geste."));
    expect(apres.ok, apres.error).toBe(true);
    expect(apres.message).toContain("La facture est déjà réglée : ce montant est dû au client — son remboursement se demande depuis « Demandes de validations » (« Demande de paiement »).");
    // L'écriture du règlement a eu lieu : elle ne bouge pas.
    expect(Number((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: lien.settlementTxId! }, select: { amount: true } })).amount)).toBe(39270);
  }, 150_000);

  it("une facture ne s'annule pas sous ses avoirs — l'état d'abord, le motif ensuite ; ses avoirs annulés, elle s'annule", async () => {
    const f = await facture("Pharmacie A7");
    ACTOR = fin;
    const r = await emettreAvoir(undefined, avoir(f.legalDocumentId, [{ designation: "Retour", quantite: 1, prix: 1_000 }], "Retour."));
    expect(r.ok, r.error).toBe(true);
    const sansMotif = await cancelLegalDocument((() => { const fd = new FormData(); fd.set("id", f.legalDocumentId); return fd; })());
    expect(sansMotif).toEqual({ ok: false, error: `Cette facture est créditée par un avoir (${r.reference}) : annulez-le d'abord — une facture ne s'annule pas sous ses avoirs.` });
    const annuleAvoir = await cancelLegalDocument((() => { const fd = new FormData(); fd.set("id", r.id!); fd.set("reason", "Avoir émis par erreur."); return fd; })());
    expect(annuleAvoir.ok, annuleAvoir.ok ? "" : annuleAvoir.error).toBe(true);
    const annuleFacture = await cancelLegalDocument((() => { const fd = new FormData(); fd.set("id", f.legalDocumentId); fd.set("reason", "Facture refaite."); return fd; })());
    expect(annuleFacture.ok, annuleFacture.ok ? "" : annuleFacture.error).toBe(true);
  }, 120_000);

  it("un avoir est une pièce DÉFINITIVE : il ne se révise pas, et son formulaire ne réécrit pas ce que son fichier porte", async () => {
    const f = await facture("Pharmacie A8");
    ACTOR = fin;
    const r = await emettreAvoir(undefined, avoir(f.legalDocumentId, [{ designation: "Retour", quantite: 1, prix: 1_000 }], "Retour."));
    expect(r.ok, r.error).toBe(true);
    const rev = await reviserDocumentDrive(fin, { legalDocumentId: r.id!, modifications: { notes: "x" }, motif: "x" });
    expect(rev).toMatchObject({ ok: false, motif: `L'avoir ${r.reference} est émis : un avoir ne se réécrit pas. Pour le corriger, annulez-le (motif à l'appui) et émettez-en un autre depuis la facture.` });
    const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: r.id! }, select: { title: true } });
    const modif = await updateLegalDocument((() => { const fd = new FormData(); fd.set("id", r.id!); fd.set("title", doc.title); fd.set("amount", "1"); return fd; })());
    expect(modif).toEqual({ ok: false, error: refusChampsDuFichier({ type: "AVOIR", numero: r.reference!, version: 1 }, ["amount"]) });
    expect(modif.ok ? "" : modif.error).toMatch(/^Cet avoir a été émis par la plateforme/);
  }, 120_000);

  it("UN AVOIR TOTAL RESOUMIS rend la pièce déjà émise, et une émission INTERROMPUE se reprend — l'avoir inscrit ne compte pas contre lui-même", async () => {
    const f = await facture("Pharmacie A11");
    ACTOR = fin;
    // L'avoir de TOUTE la facture : ce qu'il crédite est exactement ce qui reste.
    const total = () => avoir(f.legalDocumentId, LIGNES.map((l) => ({ designation: l.designation, quantite: l.quantite, prix: l.prixUnitaire })), "Facture émise par erreur.");
    const r1 = await emettreAvoir(undefined, total());
    expect(r1.ok, r1.error).toBe(true);
    expect(r1.message).toContain("net de la facture : 0,00 DZD");
    const sequence = async () => (await prisma.documentSequence.findMany({ where: { companyId, kind: "CREDIT_NOTE" }, select: { last: true } })).map((x) => x.last);
    const numeros = await sequence();
    // LE DOUBLE CLIC : la même demande rend la même pièce — jamais « déjà entièrement créditée » par son propre avoir.
    const r2 = await emettreAvoir(undefined, total());
    expect(r2, r2.error).toMatchObject({ ok: true, id: r1.id, reference: r1.reference });
    expect(r2.message).toBe(`Un avoir identique existait déjà (${r1.reference}) : aucun nouvel avoir n'a été émis.`);
    // L'ÉMISSION INTERROMPUE : la pièce inscrite, son fichier jamais écrit. La même demande la TERMINE, sous son numéro.
    const lu = await prisma.legalDocument.findUniqueOrThrow({ where: { id: r1.id! }, select: { custom: true } });
    const custom = lu.custom as { fabrique: Record<string, unknown> };
    await prisma.legalDocument.update({
      where: { id: r1.id! },
      data: { custom: { ...custom, fabrique: { ...custom.fabrique, etat: "EN_COURS", docx: null, pdf: null } } as unknown as Prisma.InputJsonValue },
    });
    const r3 = await emettreAvoir(undefined, total());
    expect(r3, r3.error).toMatchObject({ ok: true, id: r1.id, reference: r1.reference });
    const fab = ((await prisma.legalDocument.findUniqueOrThrow({ where: { id: r1.id! }, select: { custom: true } })).custom as { fabrique: { etat: string; docx: unknown } }).fabrique;
    expect(fab.etat).toBe("EMIS");
    expect(fab.docx).not.toBeNull();
    expect(await avoirsDe(f.legalDocumentId)).toHaveLength(1);
    // Ni le doublon ni la reprise n'ont consommé de numéro.
    expect(await sequence()).toEqual(numeros);
  }, 120_000);

  it("UN AVOIR NE SE PAIE PAS — ni mode ni conditions de paiement, même demandés ; l'aperçu dit le plafond ; le formulaire générique n'en crée pas", async () => {
    const f = await facture("Pharmacie A12");
    // Le compositeur général peut envoyer un mode et des conditions de paiement : un avoir crédite, il ne se paie pas.
    const r = await emettreDocumentDrive(sa, {
      type: "AVOIR", societe: companyId, chainFromId: f.legalDocumentId, tiers: { nom: "" },
      lignes: [{ designation: "Geste commercial", quantite: 1, prixUnitaire: 1_000 }], objet: "Geste commercial.",
      modePaiement: "CHEQUE", conditionsPaiement: "À 30 jours fin de mois",
    });
    if (!r.ok) throw new Error(r.motif);
    const spec = ((await prisma.legalDocument.findUniqueOrThrow({ where: { id: r.legalDocumentId }, select: { custom: true } })).custom as {
      fabrique: { spec: { modePaiement: string | null; conditionsPaiement: string | null } };
    }).fabrique.spec;
    expect(spec.modePaiement).toBeNull();
    expect(spec.conditionsPaiement).toBeNull();
    // L'APERÇU dit le plafond avant l'émission, par la même règle : 100 000 HT → 119 000 TTC, il reste 51 170 − 1 190.
    const apercu = await previsualiserDocument(sa, {
      type: "AVOIR", societe: companyId, chainFromId: f.legalDocumentId, tiers: { nom: "" },
      lignes: [{ designation: "Trop", quantite: 1, prixUnitaire: 100_000 }], objet: "Trop.",
    });
    if (!apercu.ok) throw new Error(apercu.motif);
    expect(apercu.peutEmettre).toBe(false);
    expect(apercu.bloquants).toContain(refusPlafondAvoir(f.reference, 119_000, 49_980));
    // LE FORMULAIRE GÉNÉRIQUE ne crée pas d'avoir : la nature n'y est pas créable — comme l'avenant, elle retombe sur
    // « Contrat ». Un avoir saisi à la main et chaîné à la facture serait retiré de son règlement hors du plafond.
    ACTOR = sa;
    const partie = await prisma.companyContact.create({ data: { name: `${TAG} Pharmacie A12`, kind: "Client", createdById: sa.id }, select: { id: true } });
    contacts.push(partie.id);
    const avant = (await totauxAvoirsActifs([f.legalDocumentId])).get(f.legalDocumentId) ?? 0;
    const cree = await createLegalDocument(undefined, (() => {
      const fd = new FormData();
      for (const [k, v] of Object.entries({ title: `${TAG} Avoir à la main`, kind: "CREDIT_NOTE", counterpartyIds: partie.id, amount: "5000", chainFromId: f.legalDocumentId })) fd.set(k, v);
      return fd;
    })());
    expect(cree.ok, cree.ok ? "" : cree.error).toBe(true);
    docsHorsSociete.push(cree.id!);
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: cree.id! }, select: { kind: true } })).kind).not.toBe("CREDIT_NOTE");
    expect((await totauxAvoirsActifs([f.legalDocumentId])).get(f.legalDocumentId) ?? 0).toBe(avant);
  }, 120_000);
});
