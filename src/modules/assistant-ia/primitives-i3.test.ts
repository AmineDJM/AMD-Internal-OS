import { afterAll, beforeAll, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { prisma } from "@/lib/prisma";
import { attendu } from "@/lib/journal";
import type { CurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { getDriveListing, getDriveSpacesForUser } from "@/lib/queries/drive";
import { champSensible } from "@/modules/coffre/partage";
import { annulerGeste, executerHorsRequete } from "@/platform/ia/hors-requete";
import { remplacerLecteurInterrupteurIaPourTests } from "@/lib/ai-settings";
import { composerDocx, paragraphe } from "@/lib/artifact/factory/word";
import { JeuxDuTour } from "./domaine/analyse/jeux";
import { problemesDeDeclaration } from "./domaine/primitives/vues";
import { VUES } from "./infra/primitives/vues";
import { executerVue } from "./infra/primitives/lire";
import { produireLivrable } from "./infra/primitives/produire";
import { executerFichier } from "./infra/primitives/fichier";
import { observerFichier } from "./infra/primitives/observer";
import { MASQUES_PAR_LES_PRIMITIVES } from "./infra/primitives";
import { outilsV1 } from "./infra/outils-v1";
import { sessionDe } from "./infra/testing/audit/taches/aides";
import { ecouter, installerEspion, relever } from "./infra/testing/audit/espion";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT I3 (décision 0065) — LES PRIMITIVES CONTRE LA BASE : les cas témoins de l'audit AU2, la sécurité S1 sous l'espion de
 * Prisma (la ligne d'autrui ne SORT PAS de la base), l'espace d'Adam, et K10 (annuler = la version précédente).
 *
 *   • « nos produits commercialisés en infectiologie » → Amoxil et Azitrom (l'aire lue sur le DOSSIER, pas sur la BU) ;
 *   • « copie l'annuaire des pharmacies d'Oran en Excel, ajoute une colonne statut, range-le dans ton Drive » → 3 lignes,
 *     une colonne statut, AUCUNE ligne « Total », rangé dans l'espace d'Adam, invisible des autres ;
 *   • « convertis ce Word en PDF et remplace la date » → v2 du Word (v1 gardée), un PDF ; annuler → v1 de nouveau.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `i3${Date.now().toString(36)}`;
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
let sa: CurrentUser, delegue: CurrentUser, lecteur: CurrentUser, autre: CurrentUser;
const ids: Record<string, string> = {};
const lire = (u: CurrentUser, e: Record<string, unknown>, jeux = new JeuxDuTour()) => executerVue(u, e, jeux, new Date("2026-11-03T10:00:00Z"));

async function compte(role: string, nom: string): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { email: `${nom}.${TAG}@adventum-test.dz`, name: `${nom} ${TAG}`, role: role as never, passwordHash: "x", isActive: true } });
  return sessionDe(u.id);
}

suite("I3 — les primitives contre la base", () => {
  beforeAll(async () => {
    installerEspion(prisma as never);
    remplacerLecteurInterrupteurIaPourTests(async () => false);
    [sa, delegue, lecteur, autre] = await Promise.all([compte("SUPER_ADMIN", "amine"), compte("MEDICAL_DELEGATE", "yanis"), compte("VIEWER", "samia"), compte("SALES_USER", "radia")]);
    const societe = await prisma.company.create({ data: { name: `Adventum ${TAG}`, shortName: `ADV${TAG}` } });
    const bu = await prisma.businessUnit.create({ data: { name: `Infectiologie / Hématologie ${TAG}` } });
    const produit = async (k: string, nom: string, dossier: { status: string; segments: string[]; classe: string; locked?: boolean }, buId?: string) => {
      const p = await prisma.product.create({ data: { code: `${TAG}${k}`, canonicalName: `${nom} ${TAG}`, dci: nom, identityKey: `${TAG}${k}`, companyId: societe.id, lifecycle: "MARKETED" } });
      await prisma.regulatoryProduct.create({ data: { reference: `${TAG}-${k}`, dci: nom, status: dossier.status as never, therapeuticSegments: dossier.segments, therapeuticClass: dossier.classe, productId: p.id, isLocked: dossier.locked ?? false } });
      if (buId) await prisma.promoProduct.create({ data: { productId: p.id, businessUnitId: buId, name: nom } as never }).catch(attendu("test I3 : profil promo facultatif", null));
      return p.id;
    };
    ids.amoxil = await produit("A", "Amoxil 1 g", { status: "DECISION_OBTAINED", segments: ["Infectiologie"], classe: "Pénicilline" });
    ids.azitrom = await produit("Z", "Azitrom 500 mg", { status: "CLOSED", segments: ["Infectiologie"], classe: "Macrolide" });
    ids.posa = await produit("P", "Posaconazole", { status: "PRE_SUBMISSION", segments: ["Infectiologie & Réanimation"], classe: "Antifongique" });
    ids.riva = await produit("R", "Rivaroxaban", { status: "DECISION_OBTAINED", segments: ["Hématologie"], classe: "Anticoagulant" }, bu.id);
    ids.secret = await produit("S", "Secretum", { status: "DECISION_OBTAINED", segments: ["Infectiologie"], classe: "Pénicilline", locked: true });
    for (const [i, w] of ["Oran", "Oran", "Oran", "Alger"].entries()) {
      await prisma.medicalInstitution.create({ data: { name: `Pharmacie ${["Ibn Sina", "El Amel", "Es Salam", "Centrale"][i]} ${TAG}`, type: "PHARMACIE", sector: "PRIVE", wilaya: w, city: w, phone: `041 2${i} 33 44`, isActive: true } as never });
    }
    // Une tâche d'Amine, que Radia ne doit jamais lire ; une à Radia, en octobre.
    await prisma.task.create({ data: { title: `Préparer le comité secret ${TAG}`, assignedToId: sa.id, createdById: sa.id, priority: "HIGH", status: "TODO" } });
    await prisma.task.create({ data: { title: `Relancer la pharmacie ${TAG}`, assignedToId: autre.id, createdById: autre.id, priority: "MEDIUM", status: "TODO", dueDate: new Date("2026-10-14T00:00:00Z") } });
    // Le Word de Radia, daté du 14 octobre 2026.
    const docx = composerDocx({ blocs: [paragraphe("Convocation au comité"), paragraphe("Date : 14 octobre 2026"), paragraphe("Lieu : siège")], titre: "Convocation" }).octets;
    const b = await putBlob(docx);
    ids.word = (await enregistrerFichierDrive(autre, { parentId: null }, { blobId: b.blobId, size: b.size, sha256: b.sha256, mimeType: DOCX, name: `Convocation ${TAG}.docx` })).id;
  }, 180_000);

  afterAll(async () => {
    remplacerLecteurInterrupteurIaPourTests(null);
    const users = [sa, delegue, lecteur, autre].filter(Boolean).map((u) => u.id);
    await prisma.driveNode.deleteMany({ where: { OR: [{ ownerId: { in: users } }, { space: { accessUserIds: { hasSome: users } } }] } }).catch(attendu("test I3 : ménage du Drive", null));
    await prisma.driveSpace.deleteMany({ where: { accessUserIds: { hasSome: users } } }).catch(attendu("test I3 : ménage des espaces", null));
    await prisma.task.deleteMany({ where: { title: { contains: TAG } } });
    await prisma.medicalInstitution.deleteMany({ where: { name: { contains: TAG } } });
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } });
    await prisma.promoProduct.deleteMany({ where: { productId: { in: Object.values(ids) } } }).catch(attendu("test I3 : profils promo", null));
    await prisma.product.deleteMany({ where: { code: { startsWith: TAG } } });
    await prisma.businessUnit.deleteMany({ where: { name: { contains: TAG } } });
    await prisma.company.deleteMany({ where: { name: { contains: TAG } } });
    await prisma.assistantGesteJournal.deleteMany({ where: { principalId: { in: users } } }).catch(attendu("test I3 : journal", null));
    await prisma.user.deleteMany({ where: { id: { in: users } } }).catch(attendu("test I3 : comptes encore référencés", null));
  }, 120_000);

  it("LE REGISTRE : cinq vues ; chaque déclaration saine (aucune colonne du coffre, droit dit, écran) ; une portée par vue", () => {
    expect(VUES.map((v) => v.nom)).toEqual(["produits", "etablissements", "missions", "taches", "demandes"]);
    for (const v of VUES) {
      expect(problemesDeDeclaration(v, (m, c) => champSensible(m, c) !== null), v.nom).toEqual([]);
      expect(typeof v.portee).toBe("function");
    }
  });

  it("CAS TÉMOIN — « nos produits commercialisés en infectiologie » → Amoxil et Azitrom (règle de l'ERP ; la BU n'est pas l'aire)", async () => {
    const r = await lire(sa, { vue: "produits", filtres: [{ champ: "etape", valeur: "commercialisé" }, { champ: "aires", op: "contient", valeur: "infectieux" }, { champ: "nom", op: "contient", valeur: TAG }], champs: ["nom", "etape", "aires", "commercialise"] });
    expect(r.statut).toBe("LU");
    const noms = (r.lignes as { nom: string }[]).map((l) => l.nom.replace(` ${TAG}`, "")).sort();
    // Le Super Admin voit aussi le dossier verrouillé ; Rivaroxaban (BU « Infectiologie / Hématologie ») n'y est PAS.
    expect(noms).toEqual(["Amoxil 1 g", "Azitrom 500 mg", "Secretum"]);
    expect(r.filtresAppliques).toEqual(["etape = COMMERCIALISE", "aires contient infectieux", `nom contient ${TAG}`]);
  });

  it("S1 — un délégué ne voit pas le dossier VERROUILLÉ : la ligne ne sort même pas de la base (espion de Prisma)", async () => {
    if (!userCan(delegue, "PRODUCTS", "VIEW")) return void expect((await lire(delegue, { vue: "produits" })).statut).toBe("FERMEE");
    ecouter([{ titulaire: "superadmin", nature: "NOTE", valeur: `Secretum ${TAG}`, libelle: "produit verrouillé" }], delegue.id);
    const r = await lire(delegue, { vue: "produits", filtres: [{ champ: "nom", op: "contient", valeur: TAG }] });
    const lues = relever();
    expect(JSON.stringify(r)).not.toContain("Secretum");
    expect(lues).toEqual([]);
  });

  it("une vue FERMÉE reste offerte et REFUSE en nommant le droit — jamais un jeu vide ; rien n'est lu", async () => {
    const ferme = [lecteur, autre, delegue].find((u) => !userCan(u, "PRODUCTS", "VIEW"));
    expect(ferme, "un des comptes de test n'a pas le module Produits").toBeTruthy();
    ecouter([{ titulaire: "superadmin", nature: "NOTE", valeur: `Amoxil 1 g ${TAG}`, libelle: "produit" }], ferme!.id);
    const r = await lire(ferme!, { vue: "produits" });
    expect(relever()).toEqual([]);
    expect(r).toMatchObject({ statut: "FERMEE", droit: "Produits (consultation)" });
    expect(String(r.raison)).toMatch(/demande le droit « Produits \(consultation\) »/);
    expect(r).not.toHaveProperty("lignes");
  });

  it("S1 — les tâches d'autrui : Radia filtre sur Amine → 0 ligne, et la tâche d'Amine ne sort pas de la base", async () => {
    ecouter([{ titulaire: "superadmin", nature: "NOTE", valeur: `Préparer le comité secret ${TAG}`, libelle: "tâche d'Amine" }], autre.id);
    const r = await lire(autre, { vue: "taches", filtres: [{ champ: "assignee", op: "contient", valeur: "amine" }] });
    expect(relever()).toEqual([]);
    expect(r).toMatchObject({ statut: "LU", total: 0 });
    // Ses propres tâches : « octobre 2026 » est NORMALISÉ (l'outil de paie le refusait, AU2 §3.4 point 5).
    const oct = await lire(autre, { vue: "taches", filtres: [{ champ: "echeance", valeur: "octobre 2026" }] });
    expect(oct).toMatchObject({ total: 1, filtresAppliques: ["echeance = 2026-10"] });
    expect((oct.lignes as { lien: string }[])[0]!.lien).toMatch(/^\/mon-espace\/taches\?tache=/);
  });

  it("S1 — une vue inventée (la table des salariés) ou un champ du coffre : refusés, nommés, rien lu", async () => {
    expect(await lire(autre, { vue: "Employee", filtres: [{ champ: "baseSalary", op: ">", valeur: "0" }] })).toMatchObject({ statut: "INCONNUE" });
    const r = await lire(sa, { vue: "etablissements", champs: ["nom", "iban", "salaire"] });
    expect(r).toMatchObject({ statut: "CHAMP_INCONNU" });
    expect(String(r.raison)).toMatch(/iban, salaire/);
  });

  it("CAS TÉMOIN — « copie l'annuaire des pharmacies d'Oran en Excel, ajoute une colonne statut, range-le dans ton Drive »", async () => {
    const jeux = new JeuxDuTour();
    const l = await lire(sa, { vue: "etablissements", filtres: [{ champ: "type", valeur: "pharmacies" }, { champ: "wilaya", valeur: "oran" }, { champ: "nom", op: "contient", valeur: TAG }], champs: ["nom", "ville", "adresse", "telephone", "secteurs"], jeu: "pharmacies_oran" }, jeux);
    expect(l).toMatchObject({ statut: "LU", total: 3, filtresAppliques: ["type = PHARMACIE", "wilaya = oran", `nom contient ${TAG}`] });
    const p = await produireLivrable(sa, { format: "xlsx", nom: `Pharmacies d'Oran ${TAG}`, jeu: "pharmacies_oran", colonnesAjoutees: ["statut"] }, { jeux });
    expect(p.statut, JSON.stringify(p)).toBe("FAIT");
    const o = p.observation as { projection: { feuilles: { colonnes: string[]; lignes: number; totaux: unknown[]; cellulesJson: number }[]; anomalies: unknown } };
    expect(o.projection.feuilles[0]).toMatchObject({ lignes: 3, totaux: [], cellulesJson: 0 });
    expect(o.projection.feuilles[0]!.colonnes).toEqual(["nom", "ville", "adresse", "telephone", "secteurs", "lien", "statut"]);
    expect(o.projection.anomalies).toBe("aucune");
    expect(p.rangeDans).toBe("Espace d'Adam › Brouillons");
    // L'ESPACE D'ADAM : à Amine seul — un onglet pour lui, pour personne d'autre (pas même un autre Super Admin).
    const espace = await prisma.driveSpace.findFirstOrThrow({ where: { accessUserIds: { equals: [sa.id] } } });
    expect(espace).toMatchObject({ name: "Espace d'Adam", managerUserIds: [sa.id], accessRoles: [], managerRoles: [] });
    expect((await getDriveSpacesForUser(sa)).map((s) => s.id)).toContain(espace.id);
    const autreSa = await compte("SUPER_ADMIN", "second");
    expect((await getDriveSpacesForUser(autreSa)).map((s) => s.id)).not.toContain(espace.id);
    expect(await getDriveListing(autreSa, null, false, espace.id)).toBeNull();
    expect(await getDriveListing(autre, null, false, espace.id)).toBeNull();
    await prisma.user.delete({ where: { id: autreSa.id } }).catch(attendu("test I3 : second SA", null));
    // Un total, seulement DEMANDÉ ; sur les téléphones, il se voit dans l'observation (anomalie), il n'est pas tu.
    const t = await produireLivrable(sa, { format: "xlsx", nom: `Pharmacies d'Oran ${TAG}`, jeu: "pharmacies_oran", totaux: ["telephone"] }, { jeux });
    expect(t).toMatchObject({ version: 2 });
    expect(JSON.stringify((t.observation as { projection: unknown }).projection)).toMatch(/additionne telephone/);
  });

  it("produire(docx|pdf) : HTML libre, assaini ; l'observation rend le texte et les tableaux réellement écrits", async () => {
    const r = await produireLivrable(sa, { format: "docx", nom: `Planning ${TAG}`, html: "<h1>Planning</h1><table><tr><th>Jour</th><th>Activité</th></tr><tr><td>Lundi</td><td>Visites</td></tr></table><p>Le reste en texte simple.</p><script>x</script>" }, { jeux: new JeuxDuTour() });
    expect(r.statut, JSON.stringify(r)).toBe("FAIT");
    const o = (r.observation as { projection: Record<string, unknown> }).projection;
    expect(o).toMatchObject({ format: "docx", tableaux: 1, retireParAssainissement: ["script"] });
    expect(String(o.texte)).toMatch(/Le reste en texte simple/);
    const pdf = await produireLivrable(sa, { format: "pdf", nom: `Planning ${TAG}`, html: "<p>Bonjour</p>", presentation: "libre" }, { jeux: new JeuxDuTour() });
    expect(pdf.statut, JSON.stringify(pdf)).toBe("FAIT");
    expect((pdf.observation as { projection: { format: string; pages: number } }).projection).toMatchObject({ format: "pdf", pages: 1 });
  }, 60_000);

  it("CAS TÉMOIN — « convertis ce Word en PDF et remplace la date » : v2 (v1 gardée) + PDF ; ANNULER → v1, PDF retiré", async () => {
    const r = await executerHorsRequete(autre, "test-i3", () => executerFichier(autre, { fichier: `Convocation ${TAG}.docx`, remplacements: [{ avant: "14 octobre 2026", apres: "20 novembre 2026" }], versFormat: "pdf" }));
    const f = r.resultat as Record<string, unknown>;
    expect(f.statut, JSON.stringify(f)).toBe("FAIT");
    expect(f.remplacementsVerifies).toEqual([{ avant: "14 octobre 2026", apres: "20 novembre 2026", encorePresent: 0, nouveauPresent: 1 }]);
    expect(await prisma.fileVersion.count({ where: { nodeId: ids.word } })).toBe(2);
    const etapes = f.etapes as { etape: string; lien?: string; rangeDans?: string }[];
    const conv = etapes.find((e) => e.etape === "conversion")!;
    expect(conv.rangeDans).toBe("Espace d'Adam › Copies");
    const pdfId = conv.lien!.replace("/drive/", "");
    const obs = await observerFichier(autre, ids.word);
    expect("erreur" in obs ? obs.erreur : String((obs.projection as { texte: string }).texte)).toMatch(/20 novembre 2026/);
    // K10 : le geste est au journal ; l'annuler rétablit la version précédente et retire le PDF créé.
    const g = await prisma.assistantGesteJournal.findFirstOrThrow({ where: { principalId: autre.id, capaciteId: "outil:fichier" }, orderBy: { creeLe: "desc" } });
    const c = (await executerHorsRequete(autre, "test-i3", () => annulerGeste(g.id, autre))).resultat as { refus?: string; compte?: Record<string, number> };
    expect(c.refus ?? null).toBeNull();
    expect(await prisma.fileVersion.count({ where: { nodeId: ids.word } })).toBe(1);
    expect(await prisma.driveNode.count({ where: { id: pdfId, isTrashed: false } })).toBe(0);
    const v1 = await observerFichier(autre, ids.word);
    expect("erreur" in v1 ? "" : String((v1.projection as { texte: string }).texte)).toMatch(/14 octobre 2026/);
  }, 120_000);

  it("un remplacement qui ne trouve rien SE VOIT (rien d'écrit, texte cherché absent) — le modèle rappelle l'outil, juste", async () => {
    const f = await executerFichier(autre, { fichier: ids.word, remplacements: [{ avant: "15 octobre 2026", apres: "20 novembre 2026" }] });
    expect(f.statut).toBe("FAIT");
    expect((f.etapes as { fait: boolean }[])[0]!.fait).toBe(false);
    expect(await prisma.fileVersion.count({ where: { nodeId: ids.word } })).toBe(1);
  });

  it("le fichier d'autrui : ni observé, ni copié, ni converti", async () => {
    expect(await observerFichier(delegue, ids.word)).toHaveProperty("erreur");
    expect(await executerFichier(delegue, { fichier: ids.word, copier: true })).toMatchObject({ statut: "REFUS" });
    expect(await executerFichier(delegue, { fichier: `Convocation ${TAG}.docx`, versFormat: "pdf" })).toMatchObject({ statut: "REFUS" });
  });

  it("L'INTERRUPTEUR : ADAM_PRIMITIVES=0 rend le catalogue d'avant (aucune primitive, rien de masqué)", () => {
    const noms = () => outilsV1(sa, [], [], [], null, undefined, { capacites: true }).map((o) => o.def.name);
    const avec = noms();
    expect(avec).toEqual(expect.arrayContaining(["lire", "produire", "fichier", "observer"]));
    for (const m of Object.keys(MASQUES_PAR_LES_PRIMITIVES)) expect(avec, m).not.toContain(m);
    process.env.ADAM_PRIMITIVES = "0";
    try {
      const sans = noms();
      expect(sans).not.toContain("lire");
      expect(sans).toEqual(expect.arrayContaining(["list_my_tasks", "modifier_document", "convertir_document"]));
    } finally {
      delete process.env.ADAM_PRIMITIVES;
    }
  });
});
