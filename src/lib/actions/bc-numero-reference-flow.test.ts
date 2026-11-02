import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import PizZip from "pizzip";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { getBlob } from "@/lib/drive-storage";
import { pieceEmise, valeursComposables, type ValeursComposables } from "@/lib/legal/piece-emise";
import { deleteFileByKey } from "@/lib/storage";
import { etatCompletDuBC } from "@/lib/bons-de-commande/etat-bc-test-outils";
import { formulaireDuComposeur } from "@/lib/bons-de-commande/composeur-test-outils";
import { emettrePieceCommerciale, previsualiserPieceCommerciale, reviserPieceCommerciale, verifierNumeroPiece } from "./fabrique-actions";
import { updateLegalDocument } from "./legal-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE NUMÉRO DE RÉFÉRENCE D'UN BON DE COMMANDE, MODIFIABLE (Direction, 14/10/2026) — par les VRAIS points d'entrée.
 *
 * « Chaque bon de commande a un numéro de référence, modifiable quand on le compose ; il peut être soit écrit manuellement,
 * soit modifié quand on modifie ou qu'on révise n'importe quel bon de commande. »
 *
 *   • COMPOSITION (`emettrePieceCommerciale`) : le prochain numéro proposé ; un numéro écrit à la main, au registre commun
 *     NNN/DG/AAAA comme dans une série hors registre — unique, et le compteur ne recule jamais ;
 *   • RÉVISION (`reviserPieceCommerciale`, fiche Legal — et la délégation du secrétariat, même action) : le numéro change dans
 *     le même formulaire, l'aperçu et le Word l'impriment, le registre suit, le changement est tracé ;
 *   • BC DÉPOSÉ (`updateLegalDocument`, la fiche d'un BC venu de l'ordinateur) : unique, tracé, et au registre le compteur
 *     monte jusqu'à lui.
 * Le poste Ad & Pro (`modifierBcDuPoste`) et le dossier promotionnel (`modifierBonDeCommandePromo`) ont leur banc
 * (`ad-pro/bc-apercu-complet-flow.test.ts`, `promo-circuit-v2-flow.test.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = `__bcnum__${Date.now()}`;
const ANNEE = new Date().getUTCFullYear();
const DG = (n: number) => `${String(n).padStart(3, "0")}/DG/${ANNEE}`;
let sa: CurrentUser;
let societeReg = "";
let societeSerie = "";

function composeur(societe: string, tiers: string, extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ type: "BON_DE_COMMANDE", societe, tiersNom: `${TAG} ${tiers}`, tiersAdresse: "Zone industrielle, Blida", date: `${ANNEE}-03-10`, modePaiement: "VIREMENT", tvaDefaut: "19", objet: "Impression", ...extra })) fd.set(k, v);
  for (const [d, q, p] of [["Fiches posologiques", "100", "250"]] as const) {
    fd.append("ligneDesignation", d); fd.append("ligneDetails", ""); fd.append("ligneQuantite", q); fd.append("lignePrix", p);
    fd.append("ligneRemise", ""); fd.append("ligneTva", ""); fd.append("ligneSection", "0");
  }
  return fd;
}

async function emettre(societe: string, tiers: string, extra: Record<string, string> = {}) {
  ACTOR = sa;
  return emettrePieceCommerciale(undefined, composeur(societe, tiers, extra));
}

const compteur = async (companyId: string, kind: string) =>
  (await prisma.documentSequence.findUnique({ where: { companyId_kind_year: { companyId, kind, year: ANNEE } }, select: { last: true } }))?.last ?? 0;

async function texteDuWord(legalDocumentId: string): Promise<string> {
  const d = await prisma.legalDocument.findUniqueOrThrow({ where: { id: legalDocumentId }, select: { driveNodeId: true } });
  const v = await prisma.fileVersion.findFirstOrThrow({ where: { nodeId: d.driveNodeId! }, orderBy: { version: "desc" }, select: { blobId: true } });
  const zip = new PizZip((await getBlob(v.blobId))!);
  return Object.keys(zip.files).filter((n) => /^word\/.*\.xml$/.test(n)).map((n) => zip.file(n)!.asText().replace(/<[^>]+>/g, "")).join(" ");
}

/** La révision telle que le composeur l'envoie : la pièce courante, le numéro saisi et le numéro actuel. */
async function reviser(legalDocumentId: string, numeroRevise: string, motif = "Numéro corrigé", autre: (v: ValeursComposables) => void = () => {}) {
  const d = await prisma.legalDocument.findUniqueOrThrow({ where: { id: legalDocumentId }, select: { custom: true, reference: true } });
  const v = valeursComposables(d.custom)!;
  autre(v);
  const fd = formulaireDuComposeur(v, {
    legalDocumentId, revisionDe: legalDocumentId, versionVue: String(pieceEmise(d.custom)!.version), motif, numeroRevise, numeroActuel: d.reference ?? "",
  });
  ACTOR = sa;
  return reviserPieceCommerciale(undefined, fd);
}

suite("Le numéro de référence d'un BC — choisi à la composition, modifié à la révision, unique, compteur jamais en arrière", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG} achats`, email: `${TAG}achats@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" }, select: { id: true, name: true, email: true } });
    const identite = (n: string) => ({ legalName: `${TAG} ${n} SARL`, legalForm: "SARL", rcNumber: "16/00-1111111B21", nif: "001916011111111", nis: "001916011111190", taxArticle: "16011111111", headOffice: "1 rue de X, Alger", phone: "+213 21 11 11 11" });
    societeReg = (await prisma.company.create({ data: { name: `${TAG} Labo DG`, shortName: `${TAG.slice(-8)}D`, color: "#1B7F79", legalIdentity: { create: identite("DG") }, documentProfile: { create: { settings: { registreDG: true } } } } })).id;
    societeSerie = (await prisma.company.create({ data: { name: `${TAG} Labo Série`, shortName: `${TAG.slice(-8)}S`, color: "#1B7F79", legalIdentity: { create: identite("Série") } } })).id;
    sa = { id: u.id, name: u.name, email: u.email, role: "SUPER_ADMIN", secondaryRole: null, access: await getAccess(u.id, "SUPER_ADMIN"), mustChangePassword: false };
  }, 60_000);

  afterAll(async () => {
    const ids = (await prisma.legalDocument.findMany({ where: { companyId: { in: [societeReg, societeSerie] } }, select: { id: true } }).catch(() => [])).map((p) => p.id);
    const vIds = (await prisma.validationRequest.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: ids } }, select: { id: true } }).catch(() => [])).map((v) => v.id);
    await prisma.validationStep.deleteMany({ where: { requestId: { in: vIds } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: vIds } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.documentReference.deleteMany({ where: { companyId: { in: [societeReg, societeSerie] } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.documentSequence.deleteMany({ where: { companyId: { in: [societeReg, societeSerie] } } }).catch(() => {});
    if (sa) {
      await prisma.fileVersion.deleteMany({ where: { node: { ownerId: sa.id } } }).catch(() => {});
      await prisma.driveNode.deleteMany({ where: { ownerId: sa.id, type: "FILE" } }).catch(() => {});
      await prisma.driveNode.deleteMany({ where: { ownerId: sa.id } }).catch(() => {});
      await prisma.auditLog.deleteMany({ where: { actorId: sa.id } }).catch(() => {});
    }
    await prisma.companyDocumentProfile.deleteMany({ where: { companyId: { in: [societeReg, societeSerie] } } }).catch(() => {});
    await prisma.companyLegalIdentity.deleteMany({ where: { companyId: { in: [societeReg, societeSerie] } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: { in: [societeReg, societeSerie] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 90_000);

  describe("au registre commun NNN/DG/AAAA", () => {
    let bc1 = "", bc2 = "";

    it("COMPOSITION : le prochain numéro est proposé ; écrit à la main, il est pris s'il est libre, refusé s'il est porté — le compteur ne recule jamais", async () => {
      ACTOR = sa;
      const ap = await previsualiserPieceCommerciale(undefined, composeur(societeReg, "Proposé"));
      expect(ap.ok && ap.surRegistre).toBe(true);
      expect(ap.ok ? ap.numeroProchain : "").toBe(DG(1));
      const r1 = await emettre(societeReg, "Auto");
      expect(r1.ok, r1.error).toBe(true);
      expect(r1.reference).toBe(DG(1));
      bc1 = r1.legalDocumentId!;
      const r2 = await emettre(societeReg, "Manuel", { numeroChoisi: DG(50), numeroSuggere: DG(2) });
      expect(r2.ok, r2.error).toBe(true);
      expect(r2.reference).toBe(DG(50));
      bc2 = r2.legalDocumentId!;
      expect(await compteur(societeReg, "REGISTRE_DG")).toBe(50);
      // Déjà porté : refusé en le disant, rien n'est émis.
      const pris = await emettre(societeReg, "Doublon", { numeroChoisi: DG(50), numeroSuggere: DG(51) });
      expect(pris.ok).toBe(false);
      expect(pris.error).toMatch(/050\/DG\/\d{4} est déjà attribuée/);
      // Plus bas que le compteur, libre : accepté — et le compteur ne recule pas.
      const bas = await emettre(societeReg, "Bas", { numeroChoisi: DG(10), numeroSuggere: DG(51) });
      expect(bas.ok, bas.error).toBe(true);
      expect(await compteur(societeReg, "REGISTRE_DG")).toBe(50);
      const suivant = await emettre(societeReg, "Suivant");
      expect(suivant.reference).toBe(DG(51));
    }, 180_000);

    it("RÉVISION : le numéro se modifie dans le même formulaire — refusé s'il est porté, sinon écrit partout (fiche, registre, Word) et tracé", async () => {
      // La vérification en direct du champ : le sien n'est jamais « pris », celui d'un autre BC l'est.
      ACTOR = sa;
      const v = new FormData(); v.set("legalDocumentId", bc1); v.set("numero", DG(1));
      expect(await verifierNumeroPiece(v)).toMatchObject({ ok: true, change: false });
      v.set("numero", DG(50));
      expect((await verifierNumeroPiece(v)).ok).toBe(false);

      const refus = await reviser(bc1, DG(50));
      expect(refus.ok).toBe(false);
      expect(refus.error).toMatch(/050\/DG\/\d{4} est déjà porté/);
      expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: bc1 }, select: { reference: true } })).reference).toBe(DG(1));

      const ok = await reviser(bc1, DG(70).toLowerCase());
      expect(ok.ok, ok.error).toBe(true);
      expect(ok.reference).toBe(DG(70));
      const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: bc1 }, select: { reference: true, title: true, custom: true } });
      expect(doc.reference).toBe(DG(70));
      expect(doc.title).toContain(DG(70));
      expect(pieceEmise(doc.custom)!.numero).toBe(DG(70));
      expect(await texteDuWord(bc1)).toContain(DG(70));
      // Le registre suit la pièce ; l'ancien numéro n'est plus porté par elle ; le compteur monte, sans reculer.
      const entrees = await prisma.documentReference.findMany({ where: { companyId: societeReg, entityType: "LEGAL_DOCUMENT", entityId: bc1 }, select: { reference: true } });
      expect(entrees.map((e) => e.reference)).toEqual([DG(70)]);
      expect(await compteur(societeReg, "REGISTRE_DG")).toBe(70);
      expect((await emettre(societeReg, "Après révision")).reference).toBe(DG(71));
      // TRACÉ : ancien → nouveau, qui, quand.
      const trace = await prisma.auditLog.findFirst({ where: { entityId: bc1, field: "numero" }, orderBy: { createdAt: "desc" } });
      expect(trace).toMatchObject({ actorId: sa.id, oldValue: DG(1), newValue: DG(70) });
      expect(trace!.createdAt).toBeInstanceOf(Date);
      // Revenir plus bas ne fait pas reculer le compteur.
      const retour = await reviser(bc2, DG(5));
      expect(retour.ok, retour.error).toBe(true);
      expect(await compteur(societeReg, "REGISTRE_DG")).toBe(71);
    }, 180_000);

    it("BC DÉPOSÉ (fiche Legal) : un numéro porté est refusé ; libre, il entre au registre et le compteur monte jusqu'à lui", async () => {
      const depose = await prisma.legalDocument.create({
        data: { companyId: societeReg, kind: "PURCHASE_ORDER", title: `${TAG} BC déposé`, reference: "BC-PAPIER-1", counterparty: `${TAG} Fournisseur`, amount: 50_000, startDate: new Date(`${ANNEE}-02-01T00:00:00Z`), createdById: sa.id, updatedById: sa.id },
        select: { id: true },
      });
      const fiche = (reference: string) => {
        const fd = new FormData();
        for (const [k, v] of Object.entries({ id: depose.id, title: `${TAG} BC déposé`, reference, kind: "PURCHASE_ORDER", amount: "50000", startDate: `${ANNEE}-02-01` })) fd.set(k, v);
        return fd;
      };
      ACTOR = sa;
      const pris = await updateLegalDocument(fiche(DG(70)));
      expect(pris.ok).toBe(false);
      expect(pris.ok ? "" : pris.error).toMatch(/déjà porté/);
      const ok = await updateLegalDocument(fiche(DG(90)));
      expect(ok.ok, ok.ok ? "" : ok.error).toBe(true);
      expect(await compteur(societeReg, "REGISTRE_DG")).toBe(90);
      expect(await prisma.documentReference.count({ where: { companyId: societeReg, entityId: depose.id, reference: DG(90) } })).toBe(1);
      expect(await prisma.auditLog.findFirst({ where: { entityId: depose.id, field: "numero" } })).toMatchObject({ oldValue: "BC-PAPIER-1", newValue: DG(90) });
    }, 60_000);
  });

  describe("le NUMÉRO SEUL ne relance pas le circuit (Direction, 14/10/2026)", () => {
    const signer = (id: string) => prisma.legalDocument.update({ where: { id }, data: { signedAt: new Date("2026-04-01T10:00:00Z"), signedById: sa.id, signedByName: "Finances", bcCircuitAt: new Date("2026-03-20T10:00:00Z") } });

    it("BC NATIF (fiche Legal) : signé, son numéro seul change — état, étapes et signature intacts, version « numéro seul », audit ; numéro + autre champ → la règle d'avant", async () => {
      const r = await emettre(societeReg, "Numéro seul");
      expect(r.ok, r.error).toBe(true);
      const id = r.legalDocumentId!;
      await signer(id);
      const avant = await etatCompletDuBC(id);
      const seul = await reviser(id, DG(300));
      expect(seul.ok, seul.error).toBe(true);
      expect(seul.message).toMatch(/seul le numéro a changé/);
      expect(await etatCompletDuBC(id)).toEqual(avant);
      const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id }, select: { reference: true, custom: true } });
      expect(doc.reference).toBe(DG(300));
      const f = (doc.custom as { fabrique: { version: number; historique: { numeroSeul?: boolean; resume: string }[] } }).fabrique;
      expect(f.version).toBe(2);
      expect(f.historique.at(-1)).toMatchObject({ numeroSeul: true });
      expect(await texteDuWord(id)).toContain(DG(300));
      expect(await prisma.auditLog.findFirst({ where: { entityId: id, field: "numero" }, select: { oldValue: true, newValue: true, actorId: true } })).toEqual({ oldValue: r.reference, newValue: DG(300), actorId: sa.id });
      // Unicité et compteur tiennent toujours.
      expect(await compteur(societeReg, "REGISTRE_DG")).toBeGreaterThanOrEqual(300);
      expect((await reviser(id, DG(70))).ok).toBe(false);
      // NUMÉRO + NOTES : une révision ordinaire — la pièce n'est plus celle que les Finances ont signée.
      const avec = await reviser(id, DG(301), "Numéro et notes", (v) => { v.champs = { ...v.champs, notes: "Livrer le matin." }; });
      expect(avec.ok, avec.error).toBe(true);
      expect(avec.message).not.toMatch(/seul le numéro/);
      expect((await etatCompletDuBC(id)).doc.signedAt).toBeNull();
    }, 180_000);

    it("BC DÉPOSÉ (fiche Legal, ou « Demandes de validations » depuis l'ordinateur) : numéro seul → état gardé ; numéro + nouveau fichier → signature retirée", async () => {
      const depose = await prisma.legalDocument.create({
        data: { companyId: societeReg, kind: "PURCHASE_ORDER", title: `${TAG} BC déposé signé`, reference: "BC-PAPIER-9", counterparty: `${TAG} Fournisseur`, amount: 50_000, startDate: new Date(`${ANNEE}-02-01T00:00:00Z`), createdById: sa.id, updatedById: sa.id },
        select: { id: true },
      });
      await signer(depose.id);
      const fiche = (reference: string) => {
        const fd = new FormData();
        for (const [k, v] of Object.entries({ id: depose.id, title: `${TAG} BC déposé signé`, reference, kind: "PURCHASE_ORDER", amount: "50000", startDate: `${ANNEE}-02-01` })) fd.set(k, v);
        return fd;
      };
      ACTOR = sa;
      const avant = await etatCompletDuBC(depose.id);
      const seul = await updateLegalDocument(fiche("BC-PAPIER-10"));
      expect(seul.ok, seul.ok ? "" : seul.error).toBe(true);
      expect(seul.message).toMatch(/Seul le numéro a changé/);
      expect(await etatCompletDuBC(depose.id)).toEqual(avant);
      expect(await prisma.auditLog.findFirst({ where: { entityId: depose.id, field: "numero" }, select: { oldValue: true, newValue: true } })).toEqual({ oldValue: "BC-PAPIER-9", newValue: "BC-PAPIER-10" });
      const avecFichier = fiche("BC-PAPIER-11");
      avecFichier.append("attachment", new File([Buffer.from("%PDF-1.4 v2")], "bc-v2.pdf", { type: "application/pdf" }));
      const r = await updateLegalDocument(avecFichier);
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      expect((await etatCompletDuBC(depose.id)).doc.signedAt).toBeNull();
      const pj = await prisma.document.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: depose.id }, select: { id: true, fileKey: true } });
      for (const d of pj) { await prisma.document.delete({ where: { id: d.id } }).catch(() => {}); if (d.fileKey) await deleteFileByKey(d.fileKey).catch(() => {}); }
    }, 60_000);
  });

  describe("dans une série hors registre", () => {
    it("composition et révision : écrit à la main, unique parmi les BC de la société ; au motif de la série, le compteur monte sans reculer", async () => {
      const auto = await emettre(societeSerie, "Auto");
      expect(auto.ok, auto.error).toBe(true);
      const ref = auto.reference!;
      const avecSeq = (n: number) => ref.replace(/\d+$/, String(n).padStart(4, "0"));
      const manuel = await emettre(societeSerie, "Manuel", { numeroChoisi: avecSeq(40) });
      expect(manuel.ok, manuel.error).toBe(true);
      expect(manuel.reference).toBe(avecSeq(40));
      expect(await compteur(societeSerie, "PURCHASE_ORDER")).toBe(40);
      expect((await emettre(societeSerie, "Suivant")).reference).toBe(avecSeq(41));
      // Un numéro libre, hors motif : accepté, le compteur n'y touche pas.
      const libre = await emettre(societeSerie, "Libre", { numeroChoisi: "CMD SPÉCIALE 7" });
      expect(libre.reference).toBe("CMD SPÉCIALE 7");
      expect(await compteur(societeSerie, "PURCHASE_ORDER")).toBe(41);
      const doublon = await emettre(societeSerie, "Doublon", { numeroChoisi: avecSeq(40).toLowerCase() });
      expect(doublon.ok).toBe(false);
      expect(doublon.error).toMatch(/déjà porté/);
      // RÉVISION : vers un numéro pris → refusé ; vers un numéro plus haut → le compteur suit ; plus bas → il ne recule pas.
      expect((await reviser(auto.legalDocumentId!, "CMD SPÉCIALE 7")).ok).toBe(false);
      const haut = await reviser(auto.legalDocumentId!, avecSeq(100));
      expect(haut.ok, haut.error).toBe(true);
      expect(await compteur(societeSerie, "PURCHASE_ORDER")).toBe(100);
      const bas = await reviser(auto.legalDocumentId!, avecSeq(3));
      expect(bas.ok, bas.error).toBe(true);
      expect(await compteur(societeSerie, "PURCHASE_ORDER")).toBe(100);
      expect((await emettre(societeSerie, "Après")).reference).toBe(avecSeq(101));
      const traces = await prisma.auditLog.findMany({ where: { entityId: auto.legalDocumentId!, field: "numero" }, orderBy: { createdAt: "asc" }, select: { oldValue: true, newValue: true } });
      expect(traces).toEqual([{ oldValue: ref, newValue: avecSeq(100) }, { oldValue: avecSeq(100), newValue: avecSeq(3) }]);
    }, 240_000);
  });
});
