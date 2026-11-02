import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import type { CurrentUser } from "@/lib/session";

/**
 * LA CTD INITIALE D'UN DOSSIER REGULATORY (§118.213) — par les VRAIS points d'entrée : la route de
 * téléversement (`POST /api/documents/upload`, celle que le bloc de la fiche et la création de dossier
 * appellent), la route qui liste un .zip, les actions serveur (supprimer, remplacer, renommer un
 * dossier) et la restauration de la corbeille. Base réelle, stockage réel (en base) ; seul le miroir
 * Drive, le monde extérieur, est simulé.
 *
 * Les acteurs sont des assistantes réglementaires SANS vue globale : une qui voit le dossier (elle en est
 * l'assistante), une qui ne le voit pas, une qui peut seulement DÉPOSER (accès personnalisé : téléverser
 * sans modifier), et un Super Admin pour la corbeille. Les prémisses sont vérifiées — sans elles, un
 * refus pourrait venir d'ailleurs et le cas passerait sans plus rien garder.
 */

let ACTEUR: CurrentUser | null = null;
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR, getCurrentUserPourEcrire: async () => ACTEUR, getCurrentUser: async () => ACTEUR }));
vi.mock("@/lib/drive/document-mirror", () => ({ mirrorDocumentsToDrive: async () => {} }));
vi.mock("@/lib/regulatory-drive-mirror", () => ({ mirrorRegulatoryUpload: async () => {} }));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { canAccessEntity } from "@/lib/entity-access";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { POST } from "@/app/api/documents/upload/route";
import { GET as zipGET } from "@/app/api/documents/[id]/zip/route";
import { supprimerCtdInitiale, remplacerCtdInitiale, renommerDossierCtd } from "@/lib/actions/regulatory-ctd-actions";
import { restoreDeletedRecord } from "@/lib/actions/admin-delete-actions";
import { droitsSurLaCtd, documentsDeLaCtd } from "./ctd-initiale-corbeille";
import { CTD_INITIALE_ETAPE, KIND_CORBEILLE_CTD, arborescenceCtd } from "./ctd-initiale";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__ctdinit__${Date.now()}`;
const ids: string[] = [];
let moi: CurrentUser;
let deposant: CurrentUser; // peut téléverser, pas modifier
let modifieur: CurrentUser; // peut modifier le dossier, PAS téléverser (la porte du dépôt le ferme)
let etrangere: CurrentUser; // ne voit pas le dossier
let admin: CurrentUser;
let produit = "";
let produitVerrouille = "";
let produitAutre = ""; // le dossier d'un autre : « la CTD dans le mauvais dossier »

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access: await getAccess(id, role), mustChangePassword: false } as CurrentUser;
}

const req = (url: string) => new NextRequest(`http://localhost${url}`);

interface Piece { nom: string; contenu?: string | Buffer; dossier?: string }

/** Un dépôt par la VRAIE route : un fichier par requête, comme le gestionnaire d'envois. */
async function deposer(entityId: string, pieces: Piece[], opts: { ctd?: boolean; category?: string; stepKey?: string | null } = {}) {
  const sorties: { status: number; body: { ok: boolean; created?: number; ids?: string[]; error?: string; errors?: { name: string; error: string }[] } }[] = [];
  for (const p of pieces) {
    const fd = new FormData();
    fd.set("entityType", "REGULATORY_PRODUCT");
    fd.set("entityId", entityId);
    fd.set("category", opts.category ?? "CTD_FULL");
    fd.set("confidentiality", "INTERNAL");
    const step = opts.stepKey === undefined ? CTD_INITIALE_ETAPE : opts.stepKey;
    if (step) fd.set("stepKey", step);
    if (opts.ctd !== false) fd.set("ctd", "1");
    if (p.dossier) fd.set("folder", p.dossier);
    fd.append("files", new File([p.contenu ?? `${TAG}-${p.nom}-${Math.random()}`], p.nom));
    const res = await POST(new NextRequest("http://localhost/api/documents/upload", { method: "POST", body: fd }));
    sorties.push({ status: res.status, body: await res.json() });
  }
  return sorties;
}

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const vivantes = (id: string) => documentsDeLaCtd(id);
const corbeille = (id: string) => prisma.deletedRecord.findMany({ where: { kind: KIND_CORBEILLE_CTD, sourceId: id }, orderBy: { deletedAt: "asc" } });

/** Les fichiers (clé → blob) d'abord : ce qu'un banc écrit, il le retire — sinon le stockage garde ses octets. */
async function purgerFichiers(cles: string[]) {
  const stored = await prisma.storedFile.findMany({ where: { key: { in: cles } }, select: { blobId: true } });
  await prisma.storedFile.deleteMany({ where: { key: { in: cles } } });
  await prisma.fileBlob.deleteMany({ where: { id: { in: stored.map((s) => s.blobId) } } });
}

/** Remet le dossier à zéro entre deux cas : documents, entrées de corbeille, et les fichiers qu'ils désignaient. */
async function viderLaCtd(id: string) {
  const docs = await prisma.document.findMany({ where: { entityId: id }, select: { id: true, fileKey: true } });
  const recs = await prisma.deletedRecord.findMany({ where: { kind: KIND_CORBEILLE_CTD, sourceId: id }, select: { documents: true } });
  await prisma.document.deleteMany({ where: { id: { in: docs.map((d) => d.id) } } });
  await prisma.deletedRecord.deleteMany({ where: { kind: KIND_CORBEILLE_CTD, sourceId: id } });
  await purgerFichiers([
    ...docs.map((d) => d.fileKey),
    ...recs.flatMap((r) => ((r.documents as { fileKey?: string | null }[] | null) ?? []).map((x) => x.fileKey)),
  ].filter((k): k is string => Boolean(k)));
}

suite("CTD initiale — dépôt, arborescence, ajout, remplacement, suppression, corbeille, droits", () => {
  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) => prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, passwordHash: "x", role } });
    const [a, b, c, d, m] = await Promise.all([mk("moi", "REGULATORY_ASSISTANT"), mk("depo", "REGULATORY_ASSISTANT"), mk("etr", "REGULATORY_ASSISTANT"), mk("adm", "SUPER_ADMIN"), mk("mod", "REGULATORY_ASSISTANT")]);
    ids.push(a.id, b.id, c.id, d.id, m.id);
    // « Modifier sans téléverser » : le droit de modifier ne suffit pas à retirer une CTD — la porte est celle du DÉPÔT.
    await prisma.userAccess.create({ data: { userId: m.id, module: "REGULATORY", canView: true, canUpdate: true, canUpload: false, scope: "ASSIGNED" } });
    // « Déposer seulement » : un accès personnalisé qui remplace les défauts du rôle — téléverser, sans modifier.
    await prisma.userAccess.create({ data: { userId: b.id, module: "REGULATORY", canView: true, canUpload: true, canUpdate: false, canDelete: false, scope: "ASSIGNED" } });
    moi = await acteur(a.id, "REGULATORY_ASSISTANT");
    deposant = await acteur(b.id, "REGULATORY_ASSISTANT");
    etrangere = await acteur(c.id, "REGULATORY_ASSISTANT");
    admin = await acteur(d.id, "SUPER_ADMIN");
    modifieur = await acteur(m.id, "REGULATORY_ASSISTANT");
    const p = await prisma.regulatoryProduct.create({
      data: { dci: `${TAG}-dci`, reference: `${TAG}-REF`, assistantId: a.id, assignedUsers: { connect: [{ id: a.id }, { id: b.id }, { id: m.id }] } },
    });
    produit = p.id;
    produitAutre = (await prisma.regulatoryProduct.create({ data: { dci: `${TAG}-dci2`, reference: `${TAG}-REF2`, assistantId: a.id, assignedUsers: { connect: [{ id: a.id }] } } })).id;
    produitVerrouille = (await prisma.regulatoryProduct.create({ data: { dci: `${TAG}-verrou`, reference: `${TAG}-VER`, isLocked: true } })).id;
  }, 60_000);

  afterAll(async () => {
    const prods = [produit, produitAutre, produitVerrouille];
    const docs = await prisma.document.findMany({ where: { entityId: { in: prods } }, select: { id: true, fileKey: true } });
    const recs = await prisma.deletedRecord.findMany({ where: { kind: KIND_CORBEILLE_CTD, sourceId: { in: prods } }, select: { documents: true } });
    const cles = [
      ...docs.map((x) => x.fileKey),
      ...recs.flatMap((r) => ((r.documents as { fileKey?: string | null }[] | null) ?? []).map((x) => x.fileKey)),
    ].filter((k): k is string => Boolean(k));
    const stored = await prisma.storedFile.findMany({ where: { key: { in: cles } }, select: { blobId: true } });
    await prisma.document.deleteMany({ where: { entityId: { in: prods } } });
    await prisma.deletedRecord.deleteMany({ where: { kind: KIND_CORBEILLE_CTD, sourceId: { in: prods } } });
    await prisma.storedFile.deleteMany({ where: { key: { in: cles } } });
    await prisma.fileBlob.deleteMany({ where: { id: { in: stored.map((s) => s.blobId) } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => undefined);
    await prisma.regulatoryProduct.deleteMany({ where: { id: { in: prods } } }).catch(() => undefined);
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
  }, 60_000);

  it("prémisses : les acteurs sont ce que le banc dit qu'ils sont", async () => {
    // Elle voit et gère ; le déposant téléverse sans modifier ; l'étrangère ne voit rien ; le dossier verrouillé lui est fermé.
    expect(await droitsSurLaCtd(moi, produit)).toEqual({ deposer: true, gerer: true });
    expect(await droitsSurLaCtd(deposant, produit)).toEqual({ deposer: true, gerer: false });
    expect(await canAccessEntity(deposant, "REGULATORY_PRODUCT", produit, "UPDATE")).toBe(false);
    expect(await canAccessEntity(etrangere, "REGULATORY_PRODUCT", produit, "VIEW")).toBe(false);
    expect(await droitsSurLaCtd(etrangere, produit)).toEqual({ deposer: false, gerer: false });
    expect(await canAccessEntity(modifieur, "REGULATORY_PRODUCT", produit, "UPDATE")).toBe(true);
    expect(await canAccessEntity(modifieur, "REGULATORY_PRODUCT", produit, "UPLOAD")).toBe(false);
    expect(await droitsSurLaCtd(modifieur, produit)).toEqual({ deposer: false, gerer: false });
    expect(await canAccessEntity(moi, "REGULATORY_PRODUCT", produitVerrouille, "VIEW")).toBe(false);
    expect(moi.role).not.toBe("SUPER_ADMIN");
  });

  it("un .zip entier déposé à la création va sur l'étape 1, en « CTD complet », sur CE dossier — et se parcourt sans le télécharger", async () => {
    ACTEUR = moi;
    const z = new JSZip();
    z.file("0000/m1/lettre.txt", "bonjour ".repeat(200));
    z.file("0000/m3/qualite.txt", "qualité ".repeat(200));
    const [r] = await deposer(produit, [{ nom: `${TAG}-ctd.zip`, contenu: await z.generateAsync({ type: "nodebuffer" }) }]);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const docs = await vivantes(produit);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ stepKey: CTD_INITIALE_ETAPE, category: "CTD_FULL", entityType: "REGULATORY_PRODUCT", entityId: produit, folder: null });
    // Rien n'a atterri sur l'autre dossier de l'assistante (la CTD dans le mauvais dossier).
    expect(await prisma.document.count({ where: { entityId: produitAutre } })).toBe(0);

    // L'archive se liste par la route de la fiche, sans être téléchargée.
    const res = await zipGET(req(`/api/documents/${docs[0].id}/zip`), { params: Promise.resolve({ id: docs[0].id }) });
    const liste = await res.json();
    expect(liste.ok).toBe(true);
    expect((liste.entries as { path: string }[]).map((e) => e.path)).toEqual(expect.arrayContaining(["0000/m1/lettre.txt", "0000/m3/qualite.txt"]));
  });

  it("un dossier entier garde son arborescence, et deux « index.xml » de deux dossiers ne sont pas deux versions", async () => {
    ACTEUR = moi;
    await viderLaCtd(produit);
    const r = await deposer(produit, [
      { nom: "index.xml", dossier: "CTD/Module 1" }, { nom: "index.xml", dossier: "CTD/Module 2" }, { nom: "q.pdf", dossier: "CTD/Module 3/3.2.P" }, { nom: "lisezmoi.txt" },
    ]);
    expect(r.every((x) => x.status === 200 && x.body.ok)).toBe(true);
    const docs = await vivantes(produit);
    expect(docs.map((d) => [d.folder, d.name, d.version]).sort()).toEqual([
      [null, "lisezmoi.txt", 1], ["CTD/Module 1", "index.xml", 1], ["CTD/Module 2", "index.xml", 1], ["CTD/Module 3/3.2.P", "q.pdf", 1],
    ].sort());
    const arbre = arborescenceCtd(docs);
    expect(arbre.nbFichiers).toBe(4);
    expect(arbre.dossiers.map((d) => d.nom)).toEqual(["CTD"]);
  });

  it("un dépôt qui vise la CTD sans le dire est refusé en nommant les gestes ; la marque sur une autre cible aussi — rien n'est écrit", async () => {
    ACTEUR = moi;
    const avant = await prisma.document.count({ where: { entityId: produit } });
    const [sansMarque] = await deposer(produit, [{ nom: "x.pdf" }], { ctd: false });
    expect(sansMarque.status).toBe(200); // la route répond 200 avec l'erreur du fichier, comme pour tout fichier refusé
    expect(sansMarque.body.ok).toBe(false);
    expect(sansMarque.body.errors?.[0].error).toMatch(/Ajouter à la CTD/);
    const [mauvaiseCible] = await deposer(produit, [{ nom: "y.pdf" }], { category: "OTHER" });
    expect(mauvaiseCible.body.ok).toBe(false);
    expect(mauvaiseCible.body.errors?.[0].error).toMatch(/étape 1/);
    const [autreEtape] = await deposer(produit, [{ nom: "z.pdf" }], { stepKey: "sample" });
    expect(autreEtape.body.ok).toBe(false);
    expect(await prisma.document.count({ where: { entityId: produit } })).toBe(avant);
  });

  it("une pièce de l'étape 1 d'une AUTRE catégorie reste une pièce ordinaire : ce n'est pas la CTD", async () => {
    ACTEUR = moi;
    const [r] = await deposer(produit, [{ nom: "justificatif.pdf" }], { ctd: false, category: "SUPPORTING_DOC" });
    expect(r.body.ok).toBe(true);
    expect((await vivantes(produit)).some((d) => d.name === "justificatif.pdf")).toBe(false);
    // Et une pièce « CTD complet » d'une AUTRE étape (posée avant ce lot par la checklist, par exemple) n'en est pas non plus :
    // sans le fait de l'étape, retirer « la CTD » emporterait des pièces qui n'en font pas partie.
    await prisma.document.create({ data: { name: "ctd-ailleurs.zip", category: "CTD_FULL", entityType: "REGULATORY_PRODUCT", entityId: produit, stepKey: "sample", uploadedById: moi.id } });
    expect((await vivantes(produit)).some((d) => d.name === "ctd-ailleurs.zip")).toBe(false);
    expect(await prisma.document.count({ where: { entityId: produit, name: "justificatif.pdf", stepKey: CTD_INITIALE_ETAPE } })).toBe(1);
  });

  it("AJOUTER dans un sous-dossier : le fichier rejoint la CTD, à l'endroit choisi, sans en créer une seconde", async () => {
    ACTEUR = moi;
    const avant = (await vivantes(produit)).length;
    const [r] = await deposer(produit, [{ nom: "complement.pdf", dossier: "Compléments/Module 3" }]);
    expect(r.body.ok).toBe(true);
    const docs = await vivantes(produit);
    expect(docs).toHaveLength(avant + 1);
    expect(docs.find((d) => d.name === "complement.pdf")?.folder).toBe("Compléments/Module 3");
    // Toujours UN ensemble : une seule corbeille à venir, pas deux CTD.
    expect(arborescenceCtd(docs).nbFichiers).toBe(avant + 1);
  });

  it("RENOMMER un dossier : le dossier et ses descendants suivent, « Module 10 » et une pièce d'une autre étape ne bougent pas", async () => {
    ACTEUR = moi;
    await viderLaCtd(produit);
    await deposer(produit, [
      { nom: "a.pdf", dossier: "CTD/Module 1" }, { nom: "b.pdf", dossier: "CTD/Module 1/sous" }, { nom: "c.pdf", dossier: "CTD/Module 10" }, { nom: "d.pdf", dossier: "CTD/Module 2" },
    ]);
    // Une pièce d'une autre étape qui porte le MÊME chemin de dossier : elle n'est pas dans la CTD.
    await deposer(produit, [{ nom: "autre.pdf", dossier: "CTD/Module 1" }], { ctd: false, category: "OTHER", stepKey: "sample" });

    const conflit = await renommerDossierCtd(fd({ productId: produit, dossier: "CTD/Module 1", nouveauNom: "Module 2" }));
    expect(conflit.ok).toBe(false);
    expect(conflit.error).toMatch(/existe déjà/);
    const separateur = await renommerDossierCtd(fd({ productId: produit, dossier: "CTD/Module 1", nouveauNom: "a/b" }));
    expect(separateur.ok).toBe(false);
    const inconnu = await renommerDossierCtd(fd({ productId: produit, dossier: "CTD/Module 9", nouveauNom: "x" }));
    expect(inconnu.error).toMatch(/n'existe pas/);

    const r = await renommerDossierCtd(fd({ productId: produit, dossier: "CTD/Module 1", nouveauNom: "Module 1 corrigé" }));
    expect(r).toMatchObject({ ok: true, fichiers: 2 });
    const parNom = new Map((await vivantes(produit)).map((d) => [d.name, d.folder]));
    expect(parNom.get("a.pdf")).toBe("CTD/Module 1 corrigé");
    expect(parNom.get("b.pdf")).toBe("CTD/Module 1 corrigé/sous");
    expect(parNom.get("c.pdf")).toBe("CTD/Module 10");
    expect(parNom.get("d.pdf")).toBe("CTD/Module 2");
    expect((await prisma.document.findFirstOrThrow({ where: { entityId: produit, name: "autre.pdf" } })).folder).toBe("CTD/Module 1");
  });

  it("REMPLACER : l'ancienne CTD part d'un bloc à la corbeille (fichiers conservés), la nouvelle prend sa place — jamais deux CTD vivantes", async () => {
    ACTEUR = moi;
    await viderLaCtd(produit);
    await deposer(produit, [{ nom: "v1-a.pdf", dossier: "CTD" }, { nom: "v1-b.pdf", dossier: "CTD" }, { nom: "v1.zip" }]);
    const anciens = await vivantes(produit);
    expect(anciens).toHaveLength(3);
    const cles = anciens.map((d) => d.fileKey!);

    const r = await remplacerCtdInitiale(fd({ productId: produit }));
    expect(r).toMatchObject({ ok: true, fichiers: 3 });
    expect(await vivantes(produit)).toHaveLength(0); // l'ancienne ne vit plus
    const rec = await corbeille(produit);
    expect(rec).toHaveLength(1);
    expect((rec[0].payload as { motif: string }).motif).toBe("REMPLACEE");
    expect((rec[0].documents as unknown[]).length).toBe(3);
    // Les FICHIERS restent : seule la destruction réelle de l'entrée les efface.
    expect(await prisma.storedFile.count({ where: { key: { in: cles } } })).toBe(3);

    await deposer(produit, [{ nom: "v2-a.pdf", dossier: "CTD" }, { nom: "v2.zip" }]);
    const nouveaux = await vivantes(produit);
    expect(nouveaux.map((d) => d.name).sort()).toEqual(["v2-a.pdf", "v2.zip"]);
    expect(nouveaux.some((d) => d.name.startsWith("v1"))).toBe(false);
  });

  it("remplacer sans CTD existante est un premier dépôt : le geste réussit sans rien retirer", async () => {
    ACTEUR = moi;
    await viderLaCtd(produit);
    const r = await remplacerCtdInitiale(fd({ productId: produit }));
    expect(r.ok).toBe(true);
    expect(r.fichiers).toBe(0);
    expect(await corbeille(produit)).toHaveLength(0);
  });

  it("SUPPRIMER : réversible — tout part à la corbeille avec son audit ; une seconde suppression dit qu'il n'y a plus rien ; le Super Admin restaure à l'identique", async () => {
    ACTEUR = moi;
    await viderLaCtd(produit);
    await deposer(produit, [{ nom: "s1.pdf", dossier: "CTD/A" }, { nom: "s2.pdf", dossier: "CTD/B" }]);
    const avant = await vivantes(produit);
    const ancienIds = avant.map((d) => d.id).sort();

    const r = await supprimerCtdInitiale(fd({ productId: produit }));
    expect(r).toMatchObject({ ok: true, fichiers: 2 });
    expect(await vivantes(produit)).toHaveLength(0);
    const [rec] = await corbeille(produit);
    expect(rec.label).toBe("CTD initiale");
    expect(rec.deletedById).toBe(moi.id);
    expect((rec.payload as { motif: string }).motif).toBe("SUPPRIMEE");
    expect(await prisma.auditLog.count({ where: { entityType: "REGULATORY_PRODUCT", entityId: produit, actorId: moi.id, summary: { contains: "CTD initiale supprimée" } } })).toBe(1);

    const encore = await supprimerCtdInitiale(fd({ productId: produit }));
    expect(encore.ok).toBe(false);
    expect(encore.error).toMatch(/pas de CTD initiale/);
    expect(await corbeille(produit)).toHaveLength(1); // la seconde n'a rien écrit

    // Restauration : réservée au Super Admin, mêmes identifiants, mêmes fichiers.
    ACTEUR = moi;
    expect((await restoreDeletedRecord(fd({ id: rec.id }))).error).toMatch(/Réservé au Super Admin/);
    ACTEUR = admin;
    const rest = await restoreDeletedRecord(fd({ id: rec.id }));
    expect(rest.ok).toBe(true);
    const apres = await vivantes(produit);
    expect(apres.map((d) => d.id).sort()).toEqual(ancienIds);
    expect(apres.map((d) => d.folder).sort()).toEqual(["CTD/A", "CTD/B"]);
    expect((await prisma.deletedRecord.findUniqueOrThrow({ where: { id: rec.id } })).restoredAt).not.toBeNull();
  });

  it("restaurer quand une CTD vit déjà est refusé — les deux ensembles ne se fondent pas en un", async () => {
    ACTEUR = moi;
    await viderLaCtd(produit);
    await deposer(produit, [{ nom: "ancienne.pdf" }]);
    expect((await supprimerCtdInitiale(fd({ productId: produit }))).ok).toBe(true);
    await deposer(produit, [{ nom: "nouvelle.pdf" }]);
    const [rec] = await corbeille(produit);
    ACTEUR = admin;
    const r = await restoreDeletedRecord(fd({ id: rec.id }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/vit déjà/);
    expect((await vivantes(produit)).map((d) => d.name)).toEqual(["nouvelle.pdf"]);
    expect((await prisma.deletedRecord.findUniqueOrThrow({ where: { id: rec.id } })).restoredAt).toBeNull();
  });

  it("les dossiers d'AVANT ce lot (CTD déposée sur l'étape 1, sans marque) SONT une CTD initiale : visibles, retirables", async () => {
    ACTEUR = moi;
    await viderLaCtd(produit);
    await prisma.document.create({ data: { name: "ancien-ctd.zip", category: "CTD_FULL", entityType: "REGULATORY_PRODUCT", entityId: produit, stepKey: CTD_INITIALE_ETAPE, uploadedById: moi.id } });
    expect((await vivantes(produit)).map((d) => d.name)).toEqual(["ancien-ctd.zip"]);
    const r = await supprimerCtdInitiale(fd({ productId: produit }));
    expect(r).toMatchObject({ ok: true, fichiers: 1 });
  });

  describe("droits : ceux du dépôt de documents du dossier, jamais plus larges", () => {
    it("qui ne voit pas le dossier ne dépose rien (403), ne retire rien, ne renomme rien", async () => {
      ACTEUR = moi;
      await viderLaCtd(produit);
      await deposer(produit, [{ nom: "protegee.pdf", dossier: "CTD" }]);
      ACTEUR = etrangere;
      const [r] = await deposer(produit, [{ nom: "intrus.pdf" }]);
      expect(r.status).toBe(403);
      for (const a of [supprimerCtdInitiale(fd({ productId: produit })), remplacerCtdInitiale(fd({ productId: produit })), renommerDossierCtd(fd({ productId: produit, dossier: "CTD", nouveauNom: "X" }))]) {
        const x = await a;
        expect(x.ok).toBe(false);
        expect(x.error).toMatch(/ne pouvez pas modifier/);
      }
      expect((await vivantes(produit)).map((d) => d.name)).toEqual(["protegee.pdf"]);
      expect((await vivantes(produit))[0].folder).toBe("CTD");
    });

    it("qui peut SEULEMENT déposer ajoute des fichiers, mais ne supprime ni ne remplace ni ne renomme", async () => {
      ACTEUR = deposant;
      const [ajout] = await deposer(produit, [{ nom: "ajout-du-deposant.pdf", dossier: "CTD" }]);
      expect(ajout.body.ok).toBe(true);
      for (const a of [supprimerCtdInitiale(fd({ productId: produit })), remplacerCtdInitiale(fd({ productId: produit })), renommerDossierCtd(fd({ productId: produit, dossier: "CTD", nouveauNom: "X" }))]) {
        expect((await a).ok).toBe(false);
      }
      expect((await vivantes(produit)).map((d) => d.name).sort()).toEqual(["ajout-du-deposant.pdf", "protegee.pdf"]);
      expect(await corbeille(produit)).toHaveLength(0);
    });

    it("qui peut MODIFIER le dossier sans pouvoir y téléverser ne retire rien non plus : la porte est celle du dépôt, jamais plus large", async () => {
      ACTEUR = modifieur;
      const [r] = await deposer(produit, [{ nom: "refuse.pdf" }]);
      expect(r.status).toBe(403);
      for (const a of [supprimerCtdInitiale(fd({ productId: produit })), remplacerCtdInitiale(fd({ productId: produit })), renommerDossierCtd(fd({ productId: produit, dossier: "CTD", nouveauNom: "X" }))]) {
        expect((await a).ok).toBe(false);
      }
      expect((await vivantes(produit)).map((d) => d.name).sort()).toEqual(["ajout-du-deposant.pdf", "protegee.pdf"]);
    });

    it("un dossier VERROUILLÉ (confidentiel) reste fermé : ni dépôt, ni retrait", async () => {
      ACTEUR = moi;
      const [r] = await deposer(produitVerrouille, [{ nom: "secret.pdf" }]);
      expect(r.status).toBe(403);
      expect((await supprimerCtdInitiale(fd({ productId: produitVerrouille }))).ok).toBe(false);
      expect(await prisma.document.count({ where: { entityId: produitVerrouille } })).toBe(0);
    });
  });

  it("deux retraits SIMULTANÉS ne partagent pas la CTD : un seul passe, une seule entrée de corbeille, rien n'est perdu", async () => {
    ACTEUR = moi;
    await viderLaCtd(produit);
    await deposer(produit, [{ nom: "c1.pdf" }, { nom: "c2.pdf" }, { nom: "c3.pdf" }]);
    const cible = (await vivantes(produit))[0].id;

    // La barrière : un verrou de LIGNE sur un document de la CTD laisse chaque geste LIRE, puis le bloque à son
    // écriture. On attend que les DEUX soient bloqués, puis on relâche : le second trouve la CTD déjà partie.
    const lances: Promise<{ ok: boolean; error?: string }>[] = [];
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Document" WHERE id = ${cible} FOR UPDATE`;
      for (let i = 0; i < 2; i++) {
        const g = supprimerCtdInitiale(fd({ productId: produit }));
        g.catch(() => undefined);
        lances.push(g);
        const debut = Date.now();
        for (;;) {
          await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
          const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
            WITH att AS (SELECT pid, pg_blocking_pids(pid) AS par FROM pg_stat_activity WHERE datname = current_database()),
                 directs AS (SELECT pid FROM att WHERE pg_backend_pid() = ANY(par))
            SELECT count(*)::int AS n FROM att WHERE pg_backend_pid() = ANY(par) OR par && ARRAY(SELECT pid FROM directs)`;
          if (n >= lances.length) break;
          if (Date.now() - debut > 15_000) throw new Error(`le geste n°${lances.length} n'a pas atteint la barrière`);
          await new Promise((r) => setTimeout(r, 25));
        }
      }
    }, { timeout: 30_000 });
    const sorties = await Promise.all(lances);
    expect(sorties.filter((s) => s.ok)).toHaveLength(1);
    expect(sorties.find((s) => !s.ok)?.error).toMatch(/vient d'être modifiée|pas de CTD initiale/);
    expect(await corbeille(produit)).toHaveLength(1);
    expect((await corbeille(produit))[0].documents).toHaveLength(3);
    expect(await vivantes(produit)).toHaveLength(0);
  });
});
