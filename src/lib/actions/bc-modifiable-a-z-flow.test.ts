import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import PizZip from "pizzip";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { getBlob } from "@/lib/drive-storage";
import { deleteFileByKey } from "@/lib/storage";
import { pieceEmise, valeursComposables } from "@/lib/legal/piece-emise";
import { emettrePieceCommerciale, previsualiserPieceCommerciale, reviserPieceCommerciale } from "./fabrique-actions";
import { updateLegalDocument } from "./legal-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN BON DE COMMANDE SE MODIFIE DE A À Z, EN NATIF — ET CHAQUE SOCIÉTÉ IMPRIME SES PROPRES
 * COORDONNÉES (Direction, 10/2026).
 *
 * « Les bons de commande créés dans Legal doivent être modifiables totalement, de A à Z. Enlève le
 * mail info@… parce que ça dépend vraiment de la société ; l'adresse mail doit pouvoir être
 * modifiable. »
 *
 * Par les VRAIS points d'entrée de l'écran : le composeur (`emettrePieceCommerciale`), son aperçu
 * (`previsualiserPieceCommerciale`), la révision (`reviserPieceCommerciale`) et le formulaire de la
 * fiche (`updateLegalDocument`) — session simulée, base locale.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = `__bcaz__${Date.now()}`;
const ANNEE = new Date().getUTCFullYear();
let sa: CurrentUser;
let societeX = "";
let societeY = "";
const EMAIL_X = `contact@${TAG.replace(/_/g, "")}-x.dz`;
const TEL_X = "+213 21 11 11 11";
const documentsCrees: { id: string; fileKey: string | null }[] = [];

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, secondaryRole: null, access: await getAccess(id, role), mustChangePassword: false };
}

/** Le formulaire du composeur, tel que l'écran l'envoie (listes parallèles des lignes et des taxes). */
function composeur(champs: Record<string, string>, lignes: { d: string; q: string; p: string; r?: string; t?: string }[], taxes: { l: string; t: string }[] = []): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(champs)) fd.set(k, v);
  for (const l of lignes) {
    fd.append("ligneDesignation", l.d);
    fd.append("ligneDetails", "");
    fd.append("ligneQuantite", l.q);
    fd.append("lignePrix", l.p);
    fd.append("ligneRemise", l.r ?? "");
    fd.append("ligneTva", l.t ?? "");
    fd.append("ligneSection", "0");
  }
  for (const t of taxes) { fd.append("taxeLibelle", t.l); fd.append("taxeTaux", t.t); }
  return fd;
}

const BC_INITIAL = (societe: string, tiers: string) => composeur(
  { type: "BON_DE_COMMANDE", societe, tiersNom: `${TAG} ${tiers}`, tiersAdresse: "Zone industrielle, Blida", tiersEmail: "ventes@ancien-fournisseur.dz", tiersTelephone: "025 00 00 00", date: `${ANNEE}-03-10`, modePaiement: "VIREMENT", tvaDefaut: "19", objet: "Impression fiches" },
  [{ d: "Fiches posologiques", q: "100", p: "250" }, { d: "Kakémonos", q: "2", p: "9000" }],
);

async function emettreBC(societe: string, tiers: string) {
  ACTOR = sa;
  const r = await emettrePieceCommerciale(undefined, BC_INITIAL(societe, tiers));
  if (!r.ok || !r.legalDocumentId) throw new Error(`émission refusée : ${r.error}`);
  return { id: r.legalDocumentId, reference: r.reference!, docxNodeId: r.docxNodeId! };
}

/** Le TEXTE de la dernière version du Word d'une pièce (corps, en-têtes, pieds). */
async function texteDuWord(nodeId: string): Promise<string> {
  const v = await prisma.fileVersion.findFirstOrThrow({ where: { nodeId }, orderBy: { version: "desc" }, select: { blobId: true } });
  const octets = await getBlob(v.blobId);
  const zip = new PizZip(octets!);
  return Object.keys(zip.files).filter((n) => /^word\/.*\.xml$/.test(n)).map((n) => zip.file(n)!.asText().replace(/<[^>]+>/g, " ")).join(" ");
}

const lire = (id: string) => prisma.legalDocument.findUniqueOrThrow({
  where: { id }, select: { amount: true, reference: true, counterparty: true, startDate: true, signedAt: true, signedById: true, custom: true, driveNodeId: true },
});
type Spec = { emetteur: { email?: string | null; telephone?: string | null; adresse?: string | null }; tiers: { nom: string; email?: string | null; telephone?: string | null; adresse?: string | null }; piedDePage?: string[] | null; lignes: { designation: string; quantite: number; prixUnitaire: number }[]; tvaDefaut?: number | null; coordonneesEmetteur?: unknown; date: string };
const fabrique = (custom: unknown) => (custom as { fabrique: { version: number; spec: Spec; totaux: { totalTtc: number }; historique: { version: number; resume: string }[] } }).fabrique;

suite("Bons de commande — modifiables de A à Z, et les coordonnées de la société émettrice (Direction, 10/2026)", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG} pdg`, email: `${TAG}pdg@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" }, select: { id: true } });
    const [x, y] = await Promise.all([
      prisma.company.create({ data: { name: `${TAG} Labo X`, shortName: `${TAG.slice(0, 8)}X`, color: "#1B7F79" } }),
      prisma.company.create({ data: { name: `${TAG} Labo Y`, shortName: `${TAG.slice(0, 8)}Y`, color: "#7F1B1B" } }),
    ]);
    societeX = x.id; societeY = y.id;
    await Promise.all([
      prisma.companyLegalIdentity.create({
        data: {
          companyId: societeX, legalName: `${TAG} Labo X SARL`, legalForm: "SARL", rcNumber: "16/00-1111111B21", nif: "001916011111111", nis: "001916011111190",
          taxArticle: "16011111111", headOffice: "1 rue de X, Alger", phone: TEL_X, email: EMAIL_X,
        },
      }),
      // LA SOCIÉTÉ Y N'A PAS D'E-MAIL : ses pièces n'en impriment aucun — surtout pas celui d'une autre société.
      prisma.companyLegalIdentity.create({
        data: {
          companyId: societeY, legalName: `${TAG} Labo Y SPA`, legalForm: "SPA", rcNumber: "31/00-2222222B22", nif: "003116022222222", nis: "003116022222290",
          taxArticle: "31022222222", headOffice: "2 boulevard de Y, Oran", phone: "041 22 22 22", email: null,
        },
      }),
    ]);
    sa = await acteur(u.id, "SUPER_ADMIN");
  }, 60_000);

  afterAll(async () => {
    const pieces = (await prisma.legalDocument.findMany({ where: { companyId: { in: [societeX, societeY] } }, select: { id: true } }).catch(() => []));
    const ids = pieces.map((p) => p.id);
    for (const d of documentsCrees) {
      await prisma.document.delete({ where: { id: d.id } }).catch(() => {});
      if (d.fileKey) await deleteFileByKey(d.fileKey).catch(() => {});
    }
    const vIds = (await prisma.validationRequest.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: ids } }, select: { id: true } }).catch(() => [])).map((v) => v.id);
    await prisma.validationStep.deleteMany({ where: { requestId: { in: vIds } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: vIds } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.documentSequence.deleteMany({ where: { companyId: { in: [societeX, societeY] } } }).catch(() => {});
    if (sa) {
      await prisma.fileVersion.deleteMany({ where: { node: { ownerId: sa.id } } }).catch(() => {});
      await prisma.driveNode.deleteMany({ where: { ownerId: sa.id, type: "FILE" } }).catch(() => {});
      await prisma.driveNode.deleteMany({ where: { ownerId: sa.id } }).catch(() => {});
      await prisma.auditLog.deleteMany({ where: { actorId: sa.id } }).catch(() => {});
    }
    await prisma.companyLegalIdentity.deleteMany({ where: { companyId: { in: [societeX, societeY] } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: { in: [societeX, societeY] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 90_000);

  describe("chaque société imprime SES coordonnées — jamais celles d'une autre", () => {
    it("le BC de X porte l'e-mail de X ; celui de Y (sans e-mail) n'en porte AUCUN", async () => {
      const bx = await emettreBC(societeX, "Imprimerie X");
      const by = await emettreBC(societeY, "Imprimerie Y");
      const sx = fabrique((await lire(bx.id)).custom).spec;
      const sy = fabrique((await lire(by.id)).custom).spec;
      expect(sx.emetteur.email).toBe(EMAIL_X);
      expect(sy.emetteur.email ?? null).toBeNull();
      // Le pied de Y ne contient aucune adresse e-mail, et surtout pas celle de X.
      expect((sy.piedDePage ?? []).join(" ")).not.toMatch(/@/);
      const motsY = await texteDuWord(by.docxNodeId);
      expect(motsY).not.toContain(EMAIL_X);
      expect(motsY).not.toMatch(/adventumdz/i);
      expect(await texteDuWord(bx.docxNodeId)).toContain(EMAIL_X);
    }, 120_000);

    it("les coordonnées choisies dans le composeur gouvernent la pièce : e-mail changé, téléphone retiré", async () => {
      ACTOR = sa;
      const fd = BC_INITIAL(societeX, "Imprimerie choix");
      fd.set("emetteurPersonnalise", "1");
      fd.set("emetteurAdresse", "1 rue de X, Alger");
      fd.set("emetteurTelephone", "");
      fd.set("emetteurEmail", "achats@x-labo.dz");
      const r = await emettrePieceCommerciale(undefined, fd);
      expect(r.ok, r.error).toBe(true);
      const spec = fabrique((await lire(r.legalDocumentId!)).custom).spec;
      expect(spec.emetteur).toMatchObject({ email: "achats@x-labo.dz", telephone: null });
      expect(spec.coordonneesEmetteur).toEqual({ adresse: "1 rue de X, Alger", telephone: null, email: "achats@x-labo.dz" });
      const mots = await texteDuWord(r.docxNodeId!);
      expect(mots).toContain("achats@x-labo.dz");
      expect(mots).not.toContain(EMAIL_X);
      expect(mots).not.toContain(TEL_X);
    }, 120_000);

    it("aucune adresse « adventumdz » n'est écrite en dur dans le code des pièces (hors tests et site public)", () => {
      const fichiers: string[] = [];
      const parcourir = (d: string) => {
        for (const n of readdirSync(d)) {
          const p = join(d, n);
          if (statSync(p).isDirectory()) parcourir(p);
          else if (/\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n)) fichiers.push(p.replace(/\\/g, "/"));
        }
      };
      parcourir("src");
      // Une ADRESSE e-mail du domaine, nulle part dans le code ; et aucune adresse e-mail du tout dans ce qui compose les pièces.
      const emails = fichiers.filter((f) => /@adventumdz/i.test(readFileSync(f, "utf8")));
      expect(emails).toEqual([]);
      const pieces = fichiers.filter((f) => /src\/(lib\/artifact|platform\/in-process\/artifact|lib\/brand|components\/pieces)\//.test(f) || f.endsWith("fabrique-actions.ts"));
      expect(pieces.length).toBeGreaterThan(5);
      const enDur = pieces.filter((f) => /["'`][^"'`\s]*@[a-z0-9-]+\.(dz|com|fr)["'`]/i.test(readFileSync(f, "utf8")));
      expect(enDur).toEqual([]);
    });
  });

  describe("« Modifier le bon de commande » : le composeur rouvre la pièce, la révision écrit tout", () => {
    let bc: { id: string; reference: string; docxNodeId: string };
    let ttcAvant = 0;

    it("tout change — fournisseur et son e-mail, lignes, prix, TVA, taxe, livraison, date, coordonnées imprimées — même numéro, version 2, signature retirée", async () => {
      bc = await emettreBC(societeX, "Imprimerie A");
      const avant = await lire(bc.id);
      ttcAvant = Number(avant.amount);
      // Le BC a été SIGNÉ par les Finances : la révision doit faire tomber cette signature.
      await prisma.legalDocument.update({ where: { id: bc.id }, data: { signedAt: new Date(), signedById: sa.id, signedByName: sa.name } });

      // L'APERÇU d'abord (ce que l'écran montre) : le numéro de la pièce, rien d'écrit.
      ACTOR = sa;
      const champs = {
        revisionDe: bc.id, type: "BON_DE_COMMANDE", societe: societeX,
        tiersNom: `${TAG} Imprimerie Nouvelle`, tiersAdresse: "12 rue Didouche, Alger", tiersEmail: "commandes@nouvelle-imprimerie.dz", tiersTelephone: "021 99 99 99",
        tiersRc: "", tiersNif: "000016099999999", tiersAi: "", tiersNis: "",
        date: `${ANNEE}-03-20`, objet: "Impression fiches — réassort", referenceAmont: "DV-77", referenceAmontDate: `${ANNEE}-03-01`,
        modePaiement: "CHEQUE", conditionsPaiement: "30 jours fin de mois", tvaDefaut: "9", remiseGlobale: "5",
        contactNom: "Mme Benali", contactTelephone: "0550 00 00 00", livraisonAdresse: "Entrepôt de Rouiba", livraisonDelai: "10 jours",
        notes: "Livraison en deux fois.", letterheadId: "",
        emetteurPersonnalise: "1", emetteurAdresse: "1 rue de X, Alger", emetteurTelephone: TEL_X, emetteurEmail: "bc@x-labo.dz",
      };
      const lignes = [{ d: "Fiches posologiques", q: "300", p: "200" }, { d: "Kakémonos", q: "4", p: "8500", r: "10" }, { d: "Roll-up", q: "1", p: "15000", t: "19" }];
      const taxes = [{ l: "Taxe Pub", t: "2" }];
      const apercu = await previsualiserPieceCommerciale(undefined, composeur(champs, lignes, taxes));
      expect(apercu.ok, apercu.ok ? "" : apercu.error).toBe(true);
      if (!apercu.ok) return;
      expect(apercu).toMatchObject({ revision: true, numeroProchain: bc.reference, surRegistre: false, peutEmettre: true });
      expect(apercu.coordonneesSociete).toEqual({ adresse: "1 rue de X, Alger", telephone: TEL_X, email: EMAIL_X });
      expect(pieceEmise((await lire(bc.id)).custom)?.version).toBe(1);

      const fd = composeur({ ...champs, legalDocumentId: bc.id, versionVue: "1", motif: "Nouveau fournisseur, quantités et TVA revues." }, lignes, taxes);
      const r = await reviserPieceCommerciale(undefined, fd);
      expect(r.ok, r.error).toBe(true);
      expect(r).toMatchObject({ reference: bc.reference, version: 2 });

      const apres = await lire(bc.id);
      const f = fabrique(apres.custom);
      expect(apres.reference).toBe(bc.reference);
      expect(f.version).toBe(2);
      expect(f.historique.at(-1)).toMatchObject({ version: 2, resume: "v2 — Nouveau fournisseur, quantités et TVA revues." });
      // La fiche suit le fichier : montant, partie, date.
      expect(Number(apres.amount)).toBe(f.totaux.totalTtc);
      expect(Number(apres.amount)).not.toBe(ttcAvant);
      expect(apercu.totaux?.totalTtc).toBe(f.totaux.totalTtc);
      expect(apres.counterparty).toBe(`${TAG} Imprimerie Nouvelle`);
      expect(apres.startDate?.toISOString().slice(0, 10)).toBe(`${ANNEE}-03-20`);
      // La spécification : tout ce que l'écran a envoyé.
      expect(f.spec.tiers).toMatchObject({ nom: `${TAG} Imprimerie Nouvelle`, email: "commandes@nouvelle-imprimerie.dz", telephone: "021 99 99 99", adresse: "12 rue Didouche, Alger" });
      expect(f.spec.lignes.map((l) => [l.designation, l.quantite, l.prixUnitaire])).toEqual([["Fiches posologiques", 300, 200], ["Kakémonos", 4, 8500], ["Roll-up", 1, 15000]]);
      expect(f.spec.tvaDefaut).toBeCloseTo(0.09);
      expect(f.spec).toMatchObject({ modePaiement: "CHEQUE", conditionsPaiement: "30 jours fin de mois", referenceAmont: "DV-77", notes: "Livraison en deux fois.", date: `${ANNEE}-03-20` });
      expect(f.spec.emetteur.email).toBe("bc@x-labo.dz");
      // Le Word dit la même chose : nouvel e-mail du fournisseur et de l'émetteur, plus l'ancien.
      const mots = await texteDuWord(bc.docxNodeId);
      expect(mots).toContain("commandes@nouvelle-imprimerie.dz");
      expect(mots).toContain("bc@x-labo.dz");
      expect(mots).not.toContain("ventes@ancien-fournisseur.dz");
      expect(mots).not.toContain(EMAIL_X);
      expect(await prisma.fileVersion.count({ where: { nodeId: bc.docxNodeId } })).toBe(2);
      // LE CIRCUIT DU BC (§118.148-149) : la signature portait sur la version 1 — elle tombe, et c'est consigné.
      expect(apres.signedAt).toBeNull();
      expect(apres.signedById).toBeNull();
      const journal = await prisma.auditLog.findMany({ where: { entityId: bc.id }, select: { summary: true } });
      expect(journal.some((j) => /Signature des Finances retirée/.test(j.summary ?? ""))).toBe(true);
    }, 180_000);

    it("le composeur se pré-remplit de la version courante — tiers, lignes, pourcentages, taxes, coordonnées choisies", async () => {
      const v = valeursComposables((await lire(bc.id)).custom);
      expect(v).not.toBeNull();
      expect(v!.tiers).toMatchObject({ nom: `${TAG} Imprimerie Nouvelle`, email: "commandes@nouvelle-imprimerie.dz", nif: "000016099999999" });
      expect(v!.lignes.map((l) => [l.designation, l.quantite, l.prix, l.remise])).toEqual([["Fiches posologiques", "300", "200", ""], ["Kakémonos", "4", "8500", "10"], ["Roll-up", "1", "15000", ""]]);
      expect(v!.champs).toMatchObject({ tvaDefaut: "9", remiseGlobale: "5", modePaiement: "CHEQUE", livraisonAdresse: "Entrepôt de Rouiba", livraisonDelai: "10 jours", contactNom: "Mme Benali", date: `${ANNEE}-03-20` });
      expect(v!.taxes).toEqual([{ libelle: "Taxe Pub", taux: "2" }]);
      expect(v!.emetteur).toEqual({ adresse: "1 rue de X, Alger", telephone: TEL_X, email: "bc@x-labo.dz" });
    });

    it("« Reprendre celles de la société » : la version suivante revient à la carte de X ; une date d'une autre année est refusée sans rien écrire", async () => {
      ACTOR = sa;
      const refus = await reviserPieceCommerciale(undefined, composeur({ legalDocumentId: bc.id, versionVue: "2", motif: "Date.", date: `${ANNEE + 1}-01-05` }, []));
      expect(refus.ok).toBe(false);
      expect(refus.error).toContain(`numérotée en ${ANNEE}`);
      expect(pieceEmise((await lire(bc.id)).custom)?.version).toBe(2);

      const r = await reviserPieceCommerciale(undefined, composeur({ legalDocumentId: bc.id, versionVue: "2", motif: "Coordonnées de la société.", emetteurPersonnalise: "0" }, []));
      expect(r.ok, r.error).toBe(true);
      const f = fabrique((await lire(bc.id)).custom);
      expect(f.version).toBe(3);
      expect(f.spec.coordonneesEmetteur).toBeUndefined();
      expect(f.spec.emetteur.email).toBe(EMAIL_X);
      // Ce que le formulaire ne portait pas a gardé sa valeur (§118.152) : le fournisseur et les lignes de la version 2.
      expect(f.spec.tiers.email).toBe("commandes@nouvelle-imprimerie.dz");
      expect(f.spec.lignes).toHaveLength(3);
    }, 120_000);

    it("CHAQUE CATÉGORIE se révise, une par une — et chaque version du Word la porte (lignes ôtées/ajoutées, signataire, mentions, conditions, contact, livraison, références)", async () => {
      ACTOR = sa;
      let version = 3;
      const reviser = async (champs: Record<string, string>, lignes: { d: string; q: string; p: string; r?: string; t?: string }[] = [], taxes: { l: string; t: string }[] = []) => {
        const r = await reviserPieceCommerciale(undefined, composeur({ legalDocumentId: bc.id, versionVue: String(version), motif: `Étape ${version + 1}`, ...champs }, lignes, taxes));
        expect(r.ok, r.error).toBe(true);
        version += 1;
        expect(r.version).toBe(version);
        const doc = await lire(bc.id);
        return { f: fabrique(doc.custom) as ReturnType<typeof fabrique> & { spec: Spec & Record<string, unknown> }, doc, mots: await texteDuWord(bc.docxNodeId) };
      };
      // 1. LES LIGNES : une supprimée, une ajoutée, une désignation, une quantité, un prix, une remise et une TVA changés.
      const l = await reviser({}, [{ d: "Fiches posologiques A5", q: "250", p: "210", r: "5", t: "9" }, { d: "Stylos gravés", q: "500", p: "60" }]);
      expect(l.f.spec.lignes.map((x) => [x.designation, x.quantite, x.prixUnitaire])).toEqual([["Fiches posologiques A5", 250, 210], ["Stylos gravés", 500, 60]]);
      expect(l.mots).toContain("Stylos gravés");
      expect(l.mots).not.toContain("Roll-up");
      expect(Number(l.doc.amount)).toBe(l.f.totaux.totalTtc);
      // 2. LE FOURNISSEUR : adresse, téléphone, e-mail, identifiants fiscaux.
      const t = await reviser({ tiersNom: `${TAG} Imprimerie Nouvelle`, tiersAdresse: "5 rue Larbi Ben M'hidi, Oran", tiersTelephone: "041 11 22 33", tiersEmail: "oran@nouvelle-imprimerie.dz", tiersRc: "31/00-99", tiersNif: "000031099999999", tiersAi: "31099", tiersNis: "000031099" });
      expect(t.f.spec.tiers).toMatchObject({ adresse: "5 rue Larbi Ben M'hidi, Oran", telephone: "041 11 22 33", email: "oran@nouvelle-imprimerie.dz", rc: "31/00-99" });
      expect(t.mots).toContain("oran@nouvelle-imprimerie.dz");
      // 3. LES RÉFÉRENCES ET LES DATES : objet, devis amont et sa date, date du BC (même année).
      const r = await reviser({ objet: "Réassort T4", referenceAmont: "DV-88", referenceAmontDate: `${ANNEE}-03-02`, date: `${ANNEE}-03-25` });
      expect(r.f.spec).toMatchObject({ objet: "Réassort T4", referenceAmont: "DV-88", referenceAmontDate: `${ANNEE}-03-02`, date: `${ANNEE}-03-25` });
      expect(r.doc.startDate?.toISOString().slice(0, 10)).toBe(`${ANNEE}-03-25`);
      expect(r.mots).toContain("DV-88");
      // 4. LES CONDITIONS : mode et conditions de paiement, TVA par défaut, remise globale, taxes.
      const c = await reviser({ modePaiement: "VIREMENT", conditionsPaiement: "45 jours", tvaDefaut: "19", remiseGlobale: "" }, [], [{ l: "Taxe Pub", t: "2" }, { l: "Taxe locale", t: "1" }]);
      expect(c.f.spec).toMatchObject({ modePaiement: "VIREMENT", conditionsPaiement: "45 jours", remiseGlobale: null });
      expect((c.f.spec.taxes as { libelle: string }[]).map((x) => x.libelle)).toEqual(["Taxe Pub", "Taxe locale"]);
      expect(c.mots).toContain("45 jours");
      // 5. LA LIVRAISON, LE CONTACT, LES NOTES.
      const lv = await reviser({ livraisonAdresse: "Dépôt d'Oran", livraisonDelai: "3 semaines", contactNom: "M. Kaci", contactTelephone: "0661 00 00 00", notes: "Palettes filmées." });
      expect(lv.f.spec).toMatchObject({ livraison: { adresse: "Dépôt d'Oran", delai: "3 semaines" }, contact: { nom: "M. Kaci", telephone: "0661 00 00 00" }, notes: "Palettes filmées." });
      expect(lv.mots).toContain("Dépôt d'Oran");
      // 6. LA SOCIÉTÉ ÉMETTRICE IMPRIMÉE : siège, téléphone, e-mail.
      const e = await reviser({ emetteurPersonnalise: "1", emetteurAdresse: "Zone d'activités, Blida", emetteurTelephone: "025 00 11 22", emetteurEmail: "logistique@x-labo.dz" });
      expect(e.f.spec.emetteur).toMatchObject({ adresse: "Zone d'activités, Blida", telephone: "025 00 11 22", email: "logistique@x-labo.dz" });
      expect(e.mots).toContain("logistique@x-labo.dz");
      expect(e.mots).not.toContain(EMAIL_X);
      // 7. LE SIGNATAIRE ET LES MENTIONS.
      const s = await reviser({ signatairePersonnalise: "1", signataireNom: "Amel Haddad", signataireQualite: "Directrice des achats", mentions: "Livraison franco de port.\nToute réclamation sous 8 jours." });
      expect(s.f.spec.signataire).toEqual({ nom: "Amel Haddad", qualite: "Directrice des achats" });
      expect(s.f.spec.mentionsPiece).toEqual(["Livraison franco de port.", "Toute réclamation sous 8 jours."]);
      expect(s.mots).toContain("Amel Haddad");
      expect(s.mots).toContain("Livraison franco de port.");
      // Le composeur rouvre la pièce avec tout cela.
      const v = valeursComposables((await lire(bc.id)).custom)!;
      expect(v.signataire).toEqual({ nom: "Amel Haddad", qualite: "Directrice des achats" });
      expect(v.mentions).toBe("Livraison franco de port.\nToute réclamation sous 8 jours.");
      // Sans signataire, et sans mentions : retirés de la version suivante.
      const sans = await reviser({ signatairePersonnalise: "1", signataireNom: "", mentions: "" });
      expect(sans.f.spec.signataire ?? null).toBeNull();
      expect(sans.f.spec.mentionsPiece).toBeUndefined();
      expect(sans.mots).not.toContain("Livraison franco de port.");
      // L'historique garde chaque version.
      expect(sans.f.historique.map((h) => h.version)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      expect(await prisma.fileVersion.count({ where: { nodeId: bc.docxNodeId } })).toBe(11);
    }, 300_000);

    it("UN SEUL FORMULAIRE pour composer et réviser : « Réviser la pièce » (fiche Legal, poste Ad & Pro) EST le composeur", () => {
      const reviser = readFileSync("src/components/legal/reviser-piece.tsx", "utf8");
      expect(reviser).toContain("<ComposerPieceButton");
      expect(reviser).not.toMatch(/<Sheet\b/);
      const poste = readFileSync("src/components/ad-pro/devis-bc-poste.tsx", "utf8");
      expect(poste).toContain("valeurs={bc.revision.valeurs}");
      expect(poste).toContain("previsualiserBcDuPoste");
      const fiche = readFileSync("src/app/(app)/legal/[id]/page.tsx", "utf8");
      expect(fiche).toContain("revision={{ legalDocumentId: doc.id");
    });
  });

  describe("un BC DÉPOSÉ (sans fabrique) se corrige aussi de A à Z depuis sa fiche", () => {
    it("titre, référence, montant, dates, notes — et un nouveau fichier, qui fait tomber la signature", async () => {
      const deposee = await prisma.legalDocument.create({
        data: {
          companyId: societeX, kind: "PURCHASE_ORDER", title: `${TAG} BC déposé`, reference: "BC-PAPIER-1", counterparty: `${TAG} Fournisseur papier`,
          amount: 50_000, startDate: new Date(`${ANNEE}-02-01T00:00:00Z`), createdById: sa.id, updatedById: sa.id,
          signedAt: new Date(), signedById: sa.id, signedByName: sa.name, bcCircuitAt: new Date(),
        },
        select: { id: true },
      });
      ACTOR = sa;
      const fd = new FormData();
      fd.set("id", deposee.id);
      fd.set("title", `${TAG} BC déposé — corrigé`);
      fd.set("reference", "BC-PAPIER-1bis");
      fd.set("kind", "PURCHASE_ORDER");
      fd.set("amount", "50000");
      fd.set("startDate", `${ANNEE}-02-03`);
      fd.set("notes", "Fichier remplacé par la version signée du fournisseur.");
      fd.append("attachment", new File([Buffer.from("%PDF-1.4 nouvelle version")], "bc-v2.pdf", { type: "application/pdf" }));
      const r = await updateLegalDocument(fd);
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      expect(r.message).toContain("1 fichier(s) ajouté(s)");
      const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: deposee.id }, select: { title: true, reference: true, notes: true, startDate: true, signedAt: true } });
      expect(doc).toMatchObject({ title: `${TAG} BC déposé — corrigé`, reference: "BC-PAPIER-1bis", notes: "Fichier remplacé par la version signée du fournisseur." });
      expect(doc.startDate?.toISOString().slice(0, 10)).toBe(`${ANNEE}-02-03`);
      const pj = await prisma.document.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: deposee.id }, select: { id: true, fileKey: true, name: true } });
      documentsCrees.push(...pj.map((d) => ({ id: d.id, fileKey: d.fileKey })));
      expect(pj.map((d) => d.name)).toEqual(["bc-v2.pdf"]);
      // Un NOUVEAU FICHIER n'est plus la pièce signée : la signature tombe.
      expect(doc.signedAt).toBeNull();
    }, 120_000);
  });
});
