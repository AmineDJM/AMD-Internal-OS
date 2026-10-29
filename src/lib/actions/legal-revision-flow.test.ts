import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Prisma } from "@prisma/client";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { canEditDrive, resolveDriveAccess } from "@/lib/drive";
import { legalWriteAllowed } from "@/lib/lecteurs/legal";
import { LIBELLE_CHAMP_DU_FICHIER, pieceEmise, refusChampsDuFichier, refusRevisionAval } from "@/lib/legal/piece-emise";
import { emettreDocumentDrive, reviserDocumentDrive, type DemandeDocument, type DocumentEmis } from "@/platform/in-process/artifact/factory";
import { legalFields } from "@/app/(app)/legal/legal-fields";
import { updateLegalDocument } from "./legal-actions";
import { reviserPieceCommerciale } from "./fabrique-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE PIÈCE ÉMISE SE RÉVISE DEPUIS SA FICHE, ET LE FORMULAIRE NE RÉÉCRIT PLUS SON FICHIER
 * (audit 360°, lot C4d2b1, R15 — §118.194).
 *
 * La fabrique émet devis, bons de commande et factures : un numéro, un Word, un PDF, et la pièce au
 * registre. Le formulaire générique de la fiche changeait pourtant le montant, la partie ou les
 * dates SANS toucher au fichier — la fiche disait un montant, la pièce envoyée au fournisseur en
 * disait un autre, et c'est la fiche qui part au règlement. Une vraie correction passe désormais par
 * « Réviser la pièce » : même numéro, nouvelle version du Word et du PDF, historique — les deux
 * ensemble.
 *
 * Par les VRAIS points d'entrée (l'action de la fiche, l'action de révision, la fabrique), avec un
 * acteur des Finances SANS vue globale (§118.104), qui révise une pièce émise par quelqu'un d'autre :
 * son fichier vit dans un Drive qui n'est pas le sien.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = `__legrev__${Date.now()}`;
const ANNEE = new Date().getUTCFullYear();
const T0 = new Date();
let sa: CurrentUser;
let fin: CurrentUser;
let companyId = "";

const LIGNES: DemandeDocument["lignes"] = [
  { designation: "Fiches posologiques — impression quadri", quantite: 100, prixUnitaire: 250 },
  { designation: "Kakémonos 80 × 200", quantite: 2, prixUnitaire: 9_000 },
];

function demande(type: DemandeDocument["type"], tiers: string, extra: Partial<DemandeDocument> = {}): DemandeDocument {
  return {
    type, societe: companyId, tiers: { nom: `${TAG} ${tiers}`, adresse: "Alger", nif: "000016098765432" },
    lignes: LIGNES, date: `${ANNEE}-09-05`, echeance: type === "FACTURE" ? `${ANNEE}-10-05` : null, modePaiement: "VIREMENT", ...extra,
  };
}

async function emettre(type: DemandeDocument["type"], tiers: string, extra: Partial<DemandeDocument> = {}): Promise<DocumentEmis> {
  const r = await emettreDocumentDrive(sa, demande(type, tiers, extra));
  if (!r.ok) throw new Error(`émission refusée : ${r.motif}`);
  return r;
}

const form = (champs: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(champs)) fd.set(k, v);
  return fd;
};

/** Le formulaire de « Réviser la pièce », tel que l'écran l'envoie. */
function revision(id: string, versionVue: number, opts: { quantite?: number; motif?: string } = {}): FormData {
  const fd = new FormData();
  fd.set("legalDocumentId", id);
  fd.set("versionVue", String(versionVue));
  LIGNES.forEach((l, i) => {
    fd.append("ligneDesignation", l.designation);
    fd.append("ligneDetails", "");
    fd.append("ligneQuantite", String(i === 0 && opts.quantite !== undefined ? opts.quantite : l.quantite));
    fd.append("lignePrix", String(l.prixUnitaire));
    fd.append("ligneRemise", "");
    fd.append("ligneTva", "");
    fd.append("ligneSection", "0");
  });
  if (opts.motif !== undefined) fd.set("motif", opts.motif);
  return fd;
}

const jour = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const lire = (id: string) => prisma.legalDocument.findUniqueOrThrow({
  where: { id },
  select: { kind: true, amount: true, reference: true, startDate: true, endDate: true, direction: true, counterparty: true, counterpartyIds: true, paidDate: true, title: true, notes: true, custom: true, updatedById: true },
});
const versionsDuFichier = (nodeId: string) => prisma.fileVersion.count({ where: { nodeId } });
const historique = (custom: unknown) =>
  ((custom as { fabrique?: { historique?: { version: number; resume: string }[] } }).fabrique?.historique ?? []);

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, secondaryRole: null, access: await getAccess(id, role), mustChangePassword: false };
}

/** La course FORCÉE (§118.164e) : la révision est bloquée à son écriture au registre, le détenteur écrit, puis relâche. */
async function pendantLEcriture<T>(id: string, lancer: () => Promise<T>, concurrent: (tx: Prisma.TransactionClient) => Promise<unknown>): Promise<T> {
  let geste!: Promise<T>;
  await prisma.$transaction(async (tx) => {
    // Un verrou de LIGNE : un verrou de table ferait attendre les autres fichiers de la suite, et la barrière
    // s'ouvrirait trop tôt (§118.65).
    await tx.$executeRawUnsafe(`SELECT 1 FROM "LegalDocument" WHERE id = $1 FOR UPDATE`, id);
    geste = lancer();
    geste.catch(() => undefined);
    await attendreBloques(tx, 1, 30_000, true);
    await concurrent(tx);
  }, { timeout: 60_000 });
  return geste;
}

/**
 * DEUX RÉVISIONS LANCÉES ENSEMBLE, la ligne verrouillée : sans file, les deux lisent la version 1, écrivent
 * chacune dans le Drive et attendent ensemble au registre. La barrière attend qu'elles soient DEUX à attendre —
 * ou, la file les faisant passer une par une, qu'il ne reste plus d'espoir d'en voir une seconde.
 */
async function deuxEnsemble<T>(id: string, a: () => Promise<T>, b: () => Promise<T>): Promise<[T, T]> {
  let ga!: Promise<T>, gb!: Promise<T>;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT 1 FROM "LegalDocument" WHERE id = $1 FOR UPDATE`, id);
    ga = a(); gb = b();
    ga.catch(() => undefined); gb.catch(() => undefined);
    await attendreBloques(tx, 1, 30_000, true);
    await attendreBloques(tx, 2, 4_000, false);
  }, { timeout: 60_000 });
  return Promise.all([ga, gb]);
}

async function attendreBloques(tx: Prisma.TransactionClient, n: number, delai: number, exiger: boolean): Promise<void> {
  const debut = Date.now();
  for (;;) {
    await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
    const [{ k }] = await tx.$queryRaw<{ k: number }[]>`
      SELECT count(*)::int AS k FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock' AND query ILIKE ${'%"LegalDocument"%'}`;
    if (k >= n) return;
    if (Date.now() - debut > delai) {
      if (exiger) throw new Error(`la révision n'a pas atteint l'écriture au registre (${n} attendue·s)`);
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

suite("Legal — une pièce émise se révise depuis sa fiche, et le formulaire ne réécrit pas son fichier (§118.194)", () => {
  beforeAll(async () => {
    const mk = (s: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG} ${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" }, select: { id: true } });
    const [s1, f1] = await Promise.all([mk("pdg", "SUPER_ADMIN"), mk("fin", "FINANCE_BUDGET_MANAGER")]);
    const c = await prisma.company.create({ data: { name: `${TAG} Pharma`, shortName: TAG.slice(0, 12), color: "#1B7F79" } });
    companyId = c.id;
    await Promise.all([
      prisma.companyLegalIdentity.create({
        data: {
          companyId, legalName: `${TAG} Pharma SARL`, legalForm: "SARL", shareCapital: "10 000 000 DZD", rcNumber: "16/00-1234567B21", nif: "001916012345678",
          nis: "001916012345690", taxArticle: "16012345678", headOffice: "12 rue des Frères Bouadou, Alger", phone: "+213 21 00 00 00", email: "contact@t.dz",
          bankName: "BNA", bankAgency: "Hydra", rib: "001 00123 0123456789 45", managerName: "Amine Djouamai", managerTitle: "Gérant",
        },
      }),
      // Les Finances ENGAGENT cette société (le droit d'écrire ses pièces) — sans aucun droit sur le Drive du PDG.
      prisma.userCompanyAccess.create({ data: { userId: f1.id, companyId, canEdit: true } }),
    ]);
    [sa, fin] = await Promise.all([acteur(s1.id, "SUPER_ADMIN"), acteur(f1.id, "FINANCE_BUDGET_MANAGER")]);
  }, 60_000);

  afterAll(async () => {
    const pieces = (await prisma.legalDocument.findMany({ where: { companyId }, select: { id: true, settlementTxId: true } }).catch(() => []));
    const ids = pieces.map((p) => p.id);
    const reglements = pieces.map((p) => p.settlementTxId).filter((x): x is string => Boolean(x));
    await prisma.legalDocument.updateMany({ where: { id: { in: ids } }, data: { settlementTxId: null } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { id: { in: reglements } } }).catch(() => {});
    const vIds = (await prisma.validationRequest.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: ids } }, select: { id: true } }).catch(() => [])).map((v) => v.id);
    await prisma.validationStep.deleteMany({ where: { requestId: { in: vIds } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: vIds } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: ids } } }).catch(() => {});
    // Bornées par la date : un filtre sur le seul lien parcourrait toute la table (§118.175).
    for (const id of ids) await prisma.notification.deleteMany({ where: { createdAt: { gte: T0 }, link: { contains: id } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.officeLetterhead.deleteMany({ where: { companyId } }).catch(() => {});
    const comptes = [sa?.id, fin?.id].filter(Boolean) as string[];
    await prisma.fileVersion.deleteMany({ where: { node: { ownerId: { in: comptes } } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: comptes }, type: "FILE" } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.userCompanyAccess.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.company.delete({ where: { id: companyId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 90_000);

  describe("le formulaire de la fiche ne réécrit pas le fichier", () => {
    it("REFUSE de changer le montant d'un BC émis, en nommant le geste qui corrige — et n'écrit rien", async () => {
      const bc = await emettre("BON_DE_COMMANDE", "Imprimerie A1");
      const avant = await lire(bc.legalDocumentId);
      ACTOR = fin;
      const r = await updateLegalDocument(form({ id: bc.legalDocumentId, title: avant.title, amount: "1000" }));
      expect(r).toEqual({ ok: false, error: refusChampsDuFichier({ type: "BON_DE_COMMANDE", numero: bc.reference, version: 1 }, ["amount"]) });
      expect(r.ok ? "" : r.error).toContain("« Réviser la pièce »");
      expect(Number((await lire(bc.legalDocumentId)).amount)).toBe(Number(avant.amount));
    }, 90_000);

    it("accepte le formulaire renvoyé à l'IDENTIQUE (montant, numéro, nature, dates) : le titre et les notes changent, le fichier non", async () => {
      const bc = await emettre("BON_DE_COMMANDE", "Imprimerie A2");
      const avant = await lire(bc.legalDocumentId);
      ACTOR = fin;
      const champs: Record<string, string> = {
        id: bc.legalDocumentId, title: `${TAG} BC relu`, notes: "Relu par les Finances.", kind: "PURCHASE_ORDER",
        amount: String(Number(avant.amount)), reference: avant.reference ?? "", startDate: jour(avant.startDate) ?? "",
      };
      if (avant.endDate) champs.endDate = jour(avant.endDate)!;
      const r = await updateLegalDocument(form(champs));
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      const apres = await lire(bc.legalDocumentId);
      expect(apres).toMatchObject({ title: `${TAG} BC relu`, notes: "Relu par les Finances.", kind: "PURCHASE_ORDER", reference: avant.reference });
      expect(Number(apres.amount)).toBe(Number(avant.amount));
    }, 90_000);

    it("une FACTURE émise : ce que le formulaire ne porte plus garde sa valeur — nature, montant, dates, sens « IN » — et sa date de règlement est LUE", async () => {
      const f = await emettre("FACTURE", "Client A3");
      const avant = await lire(f.legalDocumentId);
      expect(avant.direction).toBe("IN");
      ACTOR = fin;
      // Le formulaire filtré d'une pièce émise : ni nature, ni montant, ni dates, ni sens, ni partie.
      const r = await updateLegalDocument(form({ id: f.legalDocumentId, title: `${TAG} Facture pointée`, notes: "Pointée.", paidDate: `${ANNEE}-10-01` }));
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      const apres = await lire(f.legalDocumentId);
      expect({ kind: apres.kind, reference: apres.reference, direction: apres.direction, startDate: jour(apres.startDate), endDate: jour(apres.endDate), counterparty: apres.counterparty })
        .toEqual({ kind: "INVOICE", reference: avant.reference, direction: "IN", startDate: jour(avant.startDate), endDate: jour(avant.endDate), counterparty: avant.counterparty });
      expect(Number(apres.amount)).toBe(Number(avant.amount));
      // La nature d'une facture émise est celle de son FICHIER : lue d'un champ absent, elle valait « contrat », et
      // la date de règlement saisie était ignorée — puis effacée.
      expect(jour(apres.paidDate)).toBe(`${ANNEE}-10-01`);
    }, 90_000);

    it("une FACTURE émise : plusieurs champs du fichier changés → le refus les nomme TOUS, avec le remède d'une facture", async () => {
      const f = await emettre("FACTURE", "Client A4");
      const avant = await lire(f.legalDocumentId);
      ACTOR = fin;
      const r = await updateLegalDocument(form({ id: f.legalDocumentId, title: avant.title, kind: "INVOICE", amount: "5", endDate: `${ANNEE}-12-31` }));
      const phrase = refusChampsDuFichier({ type: "FACTURE", numero: f.reference, version: 1 }, ["amount", "endDate"]);
      expect(r).toEqual({ ok: false, error: phrase });
      expect(phrase).toContain("le montant et l'échéance viennent de son fichier");
      expect(phrase).toContain("« Émettre un avoir », sur sa fiche");
      expect(jour((await lire(f.legalDocumentId)).endDate)).toBe(jour(avant.endDate));
    }, 90_000);

    it("une NATURE demandée autre que celle du fichier est refusée — jamais ignorée en silence", async () => {
      const bc = await emettre("BON_DE_COMMANDE", "Imprimerie A5");
      const avant = await lire(bc.legalDocumentId);
      ACTOR = sa;
      const r = await updateLegalDocument(form({ id: bc.legalDocumentId, title: avant.title, kind: "CONTRACT" }));
      expect(r).toEqual({ ok: false, error: refusChampsDuFichier({ type: "BON_DE_COMMANDE", numero: bc.reference, version: 1 }, ["kind"]) });
      expect((await lire(bc.legalDocumentId)).kind).toBe("PURCHASE_ORDER");
    }, 90_000);

    it("une pièce DÉPOSÉE (non émise) se corrige librement : la garde ne refuse pas tout", async () => {
      const deposee = await prisma.legalDocument.create({
        data: { title: `${TAG} facture déposée`, kind: "INVOICE", status: "ACTIVE", companyId, counterparty: "Fournisseur hérité", amount: 1000, startDate: new Date(`${ANNEE}-09-01`) },
        select: { id: true },
      });
      expect(pieceEmise((await lire(deposee.id)).custom)).toBeNull();
      ACTOR = fin;
      const r = await updateLegalDocument(form({ id: deposee.id, title: `${TAG} facture déposée`, kind: "INVOICE", amount: "2500", startDate: `${ANNEE}-09-01` }));
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      expect(Number((await lire(deposee.id)).amount)).toBe(2500);
    }, 60_000);

    it("le formulaire d'une pièce émise ne PROPOSE pas les champs du fichier (et celui d'une pièce déposée, si)", () => {
      const noms = (fs: ReturnType<typeof legalFields>) => fs.flatMap((c) => ("name" in c && c.name ? [c.name] : []));
      const fichier = Object.keys(LIBELLE_CHAMP_DU_FICHIER);
      const parties = { options: [{ value: "x", label: "X" }], canCreate: false } as unknown as Parameters<typeof legalFields>[6];
      const deposee = noms(legalFields({}, "edit", [], [], [], false, parties, false));
      const emise = noms(legalFields({}, "edit", [], [], [], false, parties, true));
      // Prémisse : le formulaire d'une pièce déposée porte bien ces champs — sinon le filtre n'aurait rien à retirer.
      expect(deposee.filter((n) => fichier.includes(n)).length).toBeGreaterThanOrEqual(5);
      expect(emise.filter((n) => fichier.includes(n))).toEqual([]);
      expect(emise).toContain("title");
    });
  });

  describe("« Réviser la pièce »", () => {
    let bcB: DocumentEmis;

    it("les Finances révisent un BC émis par quelqu'un d'autre : même numéro, version 2, la fiche suit le fichier", async () => {
      bcB = await emettre("BON_DE_COMMANDE", "Imprimerie B1");
      // Prémisse : le Drive du PDG n'est pas ouvert aux Finances — c'est le droit sur la PIÈCE qui écrit son fichier.
      expect(canEditDrive(await resolveDriveAccess(fin as unknown as SessionUser, bcB.docx.nodeId))).toBe(false);
      ACTOR = fin;
      const r = await reviserPieceCommerciale(undefined, revision(bcB.legalDocumentId, 1, { quantite: 80, motif: "Quantité ramenée à 80 à la demande du fournisseur." }));
      expect(r.ok, r.error).toBe(true);
      expect(r).toMatchObject({ reference: bcB.reference, version: 2 });
      expect(r.message).toContain(`Bon de commande ${bcB.reference} révisé : version 2`);
      expect(r.message).toContain("le Word, le PDF et la fiche disent la même chose");
      const doc = await lire(bcB.legalDocumentId);
      expect(pieceEmise(doc.custom)).toEqual({ type: "BON_DE_COMMANDE", numero: bcB.reference, version: 2 });
      const totaux = (doc.custom as { fabrique: { totaux: { totalTtc: number } } }).fabrique.totaux;
      expect(Number(doc.amount)).toBe(totaux.totalTtc);
      expect(Number(doc.amount)).toBeLessThan(bcB.totaux.totalTtc);
      expect(doc.updatedById).toBe(fin.id);
      expect(historique(doc.custom).at(-1)).toMatchObject({ version: 2, resume: "v2 — Quantité ramenée à 80 à la demande du fournisseur." });
      expect(await versionsDuFichier(bcB.docx.nodeId)).toBe(2);
      if (bcB.pdf) expect(await versionsDuFichier(bcB.pdf.nodeId)).toBe(2);
      expect((await prisma.driveNode.findUniqueOrThrow({ where: { id: bcB.docx.nodeId }, select: { ownerId: true } })).ownerId).toBe(sa.id);
    }, 90_000);

    it("une version DÉPASSÉE est refusée — rien n'est écrit, ni au registre ni dans le Drive", async () => {
      ACTOR = fin;
      const r = await reviserPieceCommerciale(undefined, revision(bcB.legalDocumentId, 1, { quantite: 60, motif: "Encore moins." }));
      expect(r).toEqual({ ok: false, error: `La pièce ${bcB.reference} a été révisée entre-temps (version 2) : rouvrez-la pour partir de sa version actuelle.` });
      expect(pieceEmise((await lire(bcB.legalDocumentId)).custom)?.version).toBe(2);
      expect(await versionsDuFichier(bcB.docx.nodeId)).toBe(2);
    }, 60_000);

    it("sans motif : refusé — c'est ce que retiendra l'historique — et rien n'est écrit", async () => {
      ACTOR = fin;
      const r = await reviserPieceCommerciale(undefined, revision(bcB.legalDocumentId, 2, { quantite: 60, motif: "   " }));
      expect(r).toEqual({ ok: false, error: "Dites ce qui change dans cette pièce : c'est ce que retiendra son historique." });
      expect(await versionsDuFichier(bcB.docx.nodeId)).toBe(2);
    }, 60_000);

    it("L'ÉTAT D'ABORD (§118.18) : facture, pièce annulée, pièce figée par l'aval, nature hors des droits — refusées SANS demander de motif", async () => {
      const facture = await emettre("FACTURE", "Client B4");
      const annule = await emettre("BON_DE_COMMANDE", "Imprimerie B4 annulée");
      await prisma.legalDocument.update({ where: { id: annule.legalDocumentId }, data: { status: "CANCELLED" } });
      const fige = await emettre("BON_DE_COMMANDE", "Imprimerie B4 facturée");
      const aval = await emettre("FACTURE", "Imprimerie B4 facturée", { chainFromId: fige.legalDocumentId, lignes: [{ designation: "Facture du BC", quantite: 1, prixUnitaire: 100 }] });
      const devis = await emettre("DEVIS", "Agence B4");
      const motifDemande = "Dites ce qui change dans cette pièce";

      ACTOR = fin;
      const rf = await reviserPieceCommerciale(undefined, revision(facture.legalDocumentId, 1));
      expect(rf.error).toBe(`La facture ${facture.reference} est émise : une facture ne se réécrit pas. Pour la corriger, émettez un avoir depuis sa fiche — en totalité ou en partie.`);
      const ra = await reviserPieceCommerciale(undefined, revision(annule.legalDocumentId, 1));
      expect(ra.error).toBe(`La pièce ${annule.reference} est annulée : elle ne se révise plus.`);
      const rv = await reviserPieceCommerciale(undefined, revision(fige.legalDocumentId, 1));
      expect(rv.error).toBe(refusRevisionAval("BON_DE_COMMANDE", { kind: "INVOICE", reference: aval.reference }));
      // Prémisse : les Finances écrivent les bons de commande, pas les devis (§118.135).
      const surNature = (kind: string) => legalWriteAllowed({ onLegal: userCan(fin, "LEGAL", "UPDATE"), onFinances: userCan(fin, "FINANCES", "UPDATE"), kind });
      expect([surNature("PURCHASE_ORDER"), surNature("QUOTE")]).toEqual([true, false]);
      const rd = await reviserPieceCommerciale(undefined, revision(devis.legalDocumentId, 1));
      expect(rd.error).toBe("Réviser cette pièce exige le droit de modifier dans Legal.");
      for (const r of [rf, ra, rv, rd]) expect(r.error).not.toContain(motifDemande);
    }, 120_000);

    it("CE QUI DÉCOULE FIGE : la facture d'un BC, le BC d'un devis — et une pièce aval ANNULÉE libère l'amont", async () => {
      ACTOR = sa;
      const bc = await emettre("BON_DE_COMMANDE", "Imprimerie B5");
      const facture = await emettre("FACTURE", "Imprimerie B5", { chainFromId: bc.legalDocumentId, lignes: [{ designation: "Facture B5", quantite: 1, prixUnitaire: 100 }] });
      const refus = await reviserPieceCommerciale(undefined, revision(bc.legalDocumentId, 1, { quantite: 90, motif: "Quantité corrigée." }));
      expect(refus).toEqual({ ok: false, error: refusRevisionAval("BON_DE_COMMANDE", { kind: "INVOICE", reference: facture.reference }) });
      expect(refus.error).toContain(`Une facture découle déjà de ce bon de commande (${facture.reference})`);
      await prisma.legalDocument.update({ where: { id: facture.legalDocumentId }, data: { status: "CANCELLED" } });
      const ok = await reviserPieceCommerciale(undefined, revision(bc.legalDocumentId, 1, { quantite: 90, motif: "Quantité corrigée." }));
      expect(ok.ok, ok.error).toBe(true);
      expect(ok.version).toBe(2);

      const devis = await emettre("DEVIS", "Agence B5");
      const bcDuDevis = await emettre("BON_DE_COMMANDE", "Agence B5", { chainFromId: devis.legalDocumentId, lignes: [{ designation: "BC du devis", quantite: 1, prixUnitaire: 100 }] });
      const refusDevis = await reviserPieceCommerciale(undefined, revision(devis.legalDocumentId, 1, { quantite: 50, motif: "Révision du devis." }));
      expect(refusDevis).toEqual({ ok: false, error: refusRevisionAval("DEVIS", { kind: "PURCHASE_ORDER", reference: bcDuDevis.reference }) });
      expect(refusDevis.error).toContain(`Un bon de commande découle déjà de ce devis (${bcDuDevis.reference})`);
    }, 150_000);

    it("une pièce qui ne DÉCOULE pas commercialement (un courrier « faisant suite ») ne fige rien", async () => {
      ACTOR = sa;
      const bc = await emettre("BON_DE_COMMANDE", "Imprimerie B6");
      await prisma.legalDocument.create({
        data: { title: `${TAG} courrier sur le BC`, kind: "OTHER", status: "ACTIVE", companyId, chainFromId: bc.legalDocumentId, startDate: new Date(`${ANNEE}-09-06`) },
      });
      const r = await reviserPieceCommerciale(undefined, revision(bc.legalDocumentId, 1, { quantite: 95, motif: "Le courrier ne facture rien." }));
      expect(r.ok, r.error).toBe(true);
    }, 90_000);

    it("DEUX RÉVISIONS EN MÊME TEMPS sur la même version : une seule passe, et la perdante n'écrit rien — pas même dans le Drive", async () => {
      ACTOR = sa;
      const bc = await emettre("BON_DE_COMMANDE", "Imprimerie B7");
      const id = bc.legalDocumentId;
      const [r1, r2] = await deuxEnsemble(id,
        () => reviserPieceCommerciale(undefined, revision(id, 1, { quantite: 70, motif: "Révision A." })),
        () => reviserPieceCommerciale(undefined, revision(id, 1, { quantite: 60, motif: "Révision B." })));
      expect([r1, r2].filter((r) => r.ok)).toHaveLength(1);
      expect([r1, r2].find((r) => !r.ok)?.error).toMatch(/a été révisée entre-temps/);
      const doc = await lire(id);
      expect(pieceEmise(doc.custom)?.version).toBe(2);
      expect(historique(doc.custom).filter((h) => h.version === 2)).toHaveLength(1);
      // Le Drive aussi n'a reçu qu'UNE version : la perdante a été arrêtée avant d'écrire quoi que ce soit.
      expect(await versionsDuFichier(bc.docx.nodeId)).toBe(2);
    }, 120_000);

    it("DEUX PROCESSUS : une révision dont la version a bougé sous elle est refusée à l'écriture du registre — la version de l'autre tient", async () => {
      const bc = await emettre("BON_DE_COMMANDE", "Imprimerie B8");
      const id = bc.legalDocumentId;
      // Sans `versionVue` : seule l'écriture conditionnelle peut voir que la pièce a bougé.
      const r = await pendantLEcriture(id,
        () => reviserDocumentDrive(sa, { legalDocumentId: id, modifications: { notes: "Révision du processus A." }, motif: "A" }),
        (tx) => tx.$executeRawUnsafe(`UPDATE "LegalDocument" SET custom = jsonb_set(custom::jsonb, '{fabrique,version}', '7'::jsonb) WHERE id = $1`, id));
      expect(r).toMatchObject({ ok: false, motif: `La pièce ${bc.reference} a été révisée entre-temps : rouvrez-la pour partir de sa version actuelle.` });
      expect(pieceEmise((await lire(id)).custom)?.version).toBe(7);
    }, 120_000);
  });

  it("le dossier promotionnel n'a pas de seconde copie de la règle « une facture en découle » : il appelle la fabrique (§118.106)", () => {
    const src = readFileSync("src/lib/actions/promo-execution-actions.ts", "utf8");
    const debut = src.indexOf("export async function modifierBonDeCommandePromo");
    const corps = src.slice(debut, src.indexOf("\nexport ", debut + 10));
    expect(debut).toBeGreaterThan(-1);
    expect(corps).toContain("reviserDocumentDrive(");
    expect(corps).not.toMatch(/legalDocument\.count\(/);
    // Et la fabrique tient la règle AVANT la version et le motif : l'état d'abord.
    const fab = readFileSync("src/platform/in-process/artifact/factory/revision.ts", "utf8"); // la fabrique est découpée : la révision a son fichier
    const rev = fab.slice(fab.indexOf("export async function reviserDocumentDrive"));
    const iAval = rev.indexOf("avalActif(doc.id, f.type)");
    expect(iAval).toBeGreaterThan(-1);
    expect(iAval).toBeLessThan(rev.indexOf("opts.versionVue !== f.version"));
    expect(rev.indexOf("opts.versionVue !== f.version")).toBeLessThan(rev.indexOf("opts.exigerMotif"));
  });
});
