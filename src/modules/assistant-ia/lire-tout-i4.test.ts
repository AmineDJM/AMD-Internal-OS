import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import { attendu } from "@/lib/journal";
import type { CurrentUser } from "@/lib/session";
import { portsArtefact } from "@/platform/ia/artifact/ports";
import { JeuxDuTour } from "./domaine/analyse/jeux";
import { accesParDefaut } from "./infra/role-config";
import { executerVue } from "./infra/primitives/lire";
import { PERSONA_ASSISTANT_IA } from "./infra/travaux";
import { deposerLivrableTravail } from "./infra/travaux-livrables";
import { controlerLivrable, observerLecture } from "./domaine/observation/controle";
import { limitesDuJeu, verificationDe } from "./domaine/primitives/tables";
import { outilsV1 } from "./infra/outils-v1";
import { sessionDe } from "./infra/testing/audit/taches/aides";
import { effacerAnnuaireI4, semerAnnuaireI4, type SemisAnnuaireI4 } from "./infra/testing/annuaire-i4";
import { ecouter, installerEspion, relever } from "./infra/testing/audit/espion";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT I4 — « ADAM LIT TOUT » (décision 0067), contre la base : la lecture générique sur un annuaire FICTIF, ses droits
 * (le délégué ne voit que son panel, une table sans portée n'est lue que du Super Admin, les colonnes du coffre ne sortent
 * pas), l'essai à blanc du plan, le tableur produit DEPUIS les lignes lues, le contrôle final qui refuse le vide.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `i4${Date.now().toString(36)}`;
let sa: CurrentUser, delegue: CurrentUser, vendeur: CurrentUser;
let semis: SemisAnnuaireI4;
const lire = (u: CurrentUser, e: Record<string, unknown>, jeux = new JeuxDuTour()) => executerVue(u, e, jeux, { acces: accesParDefaut(u), lignesMax: 2_000 });
const CHEFS_INFECTIO = [
  { champ: "title", valeur: "chef de service" },
  { champ: "specialtyRef.name", op: "contient", valeur: "infectiologie" },
  { champ: "name", op: "contient", valeur: TAG },
];
const noms = (r: Record<string, unknown>) => ((r.lignes ?? []) as { name: string }[]).map((l) => l.name).sort();

async function compte(role: string, nom: string): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { email: `${nom}.${TAG}@adventum-test.dz`, name: `${nom} ${TAG}`, role: role as never, passwordHash: "x", isActive: true } });
  return sessionDe(u.id);
}

suite("I4 — Adam lit tout", () => {
  beforeAll(async () => {
    installerEspion(prisma as never);
    [sa, delegue, vendeur] = await Promise.all([compte("SUPER_ADMIN", "amine"), compte("MEDICAL_DELEGATE", "yanis"), compte("SALES_USER", "radia")]);
    semis = await semerAnnuaireI4(TAG, delegue.id);
  }, 120_000);

  afterAll(async () => {
    const users = [sa, delegue, vendeur].filter(Boolean).map((u) => u.id);
    await effacerAnnuaireI4(TAG).catch(attendu("test I4 : annuaire", null));
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: users } } }).catch(attendu("test I4 : Drive", null));
    await prisma.user.deleteMany({ where: { id: { in: users } } }).catch(attendu("test I4 : comptes", null));
  }, 120_000);

  it("CAS DE PRODUCTION — les chefs de service d'infectiologie : exactement les bons (ni le professeur, ni le cardiologue, ni l'archivé)", async () => {
    const r = await lire(sa, { table: "MedicalDoctor", filtres: CHEFS_INFECTIO, champs: ["name", "title", "specialtyRef.name", "institutionRef.name", "serviceRef.name", "wilaya", "phone", "email"] });
    expect(r.statut, JSON.stringify(r).slice(0, 400)).toBe("LU");
    expect(noms(r)).toEqual(semis.attendus);
    expect(r.filtresAppliques).toEqual(["title = CHEF_DE_SERVICE", "specialtyRef.name contient infectiologie", `name contient ${TAG}`]);
    const l = (r.lignes as Record<string, unknown>[])[0]!;
    // Le libellé d'écran, pas le code ; la relation à un niveau ; le lien de la fiche.
    expect(l.title).toBe("Chef de service");
    expect(String(l["institutionRef.name"])).toContain(TAG);
    expect(String(l.lien)).toMatch(/^\/praticiens\//);
    // Le nom de la table se dit aussi en français (catalogue des bases).
    expect((await lire(sa, { table: "médecins", filtres: CHEFS_INFECTIO })).total).toBe(semis.attendus.length);
  });

  it("LE DÉLÉGUÉ ne voit que son secteur : les mêmes filtres → ses deux chefs de service, rien d'autre ne sort de la base", async () => {
    ecouter([{ titulaire: "superadmin", nature: "NOTE", valeur: `Dr Karim Ziani ${TAG}`, libelle: "praticien hors panel" }], delegue.id);
    const r = await lire(delegue, { table: "MedicalDoctor", filtres: CHEFS_INFECTIO, champs: ["name", "phone", "institutionRef.name"] });
    expect(relever()).toEqual([]);
    expect(noms(r)).toEqual(semis.duDelegue);
  });

  it("DROITS — table sans portée déclarée (journal d'audit) : Super Admin seul ; table secrète ; colonnes du coffre et secrets absents", async () => {
    expect(await lire(delegue, { table: "AuditLog" })).toMatchObject({ statut: "FERMEE", droit: "Super Admin" });
    expect(await lire(delegue, { table: "Sale" })).toMatchObject({ statut: expect.stringMatching(/FERMEE|LU/) });
    expect(await lire(vendeur, { table: "DemandeActualisationSoldes" })).toMatchObject({ statut: "FERMEE" });
    expect(await lire(sa, { table: "DonneeSensible" })).toMatchObject({ statut: "FERMEE", droit: "coffre" });
    expect(await lire(sa, { table: "Employee", champs: ["lastName", "iban"] })).toMatchObject({ statut: "CHAMP_INCONNU" });
    expect(await lire(sa, { table: "User", champs: ["name", "passwordHash"] })).toMatchObject({ statut: "CHAMP_INCONNU" });
    const u = await lire(sa, { table: "User", filtres: [{ champ: "name", op: "contient", valeur: TAG }] });
    expect(u.statut).toBe("LU");
    expect(JSON.stringify(u)).not.toMatch(/passwordHash/);
  });

  it("L'ESSAI À BLANC compte, répartit, et dit comment élargir quand c'est zéro", async () => {
    const r = await lire(sa, { table: "MedicalDoctor", filtres: CHEFS_INFECTIO, champs: ["name", "wilaya"], compter: true });
    expect(r).toMatchObject({ statut: "COMPTE", total: semis.attendus.length });
    expect(String(r.essai)).toMatch(/4 ligne\(s\) ; wilaya : 3 valeur\(s\)/);
    const vide = await lire(sa, { table: "MedicalDoctor", filtres: [...CHEFS_INFECTIO, { champ: "wilaya", valeur: "Tamanrasset" }], compter: true });
    expect(vide.total).toBe(0);
    expect(vide.sansFiltre).toMatchObject({ "wilaya = Tamanrasset": semis.attendus.length });
    // Par la persona d'une mission : une table inconnue est une FAUTE du plan, avant le départ.
    const faute = await PERSONA_ASSISTANT_IA.essayer!(sa.id, "lire", { table: "Praticienzz" });
    expect(faute).toMatchObject({ ok: false });
  });

  it("UN SEUL JEU D'OUTILS : la mission reçoit `lire` et les lectures de la conversation, sans aucun geste", async () => {
    const acces = accesParDefaut(sa);
    const conversation = new Set(outilsV1(sa, [], undefined, undefined, null, acces, { capacites: true }).map((o) => o.def.name));
    const mission = (await PERSONA_ASSISTANT_IA.catalogue(sa.id)).lectures.map((l) => l.nom);
    expect(mission).toContain("lire");
    expect(mission).toContain("annuaire_terrain");
    for (const n of mission) expect(conversation.has(n), n).toBe(true);
    for (const n of ["produire", "fichier", "create_task", "proposer_memoire"]) expect(mission).not.toContain(n);
  });

  it("LE LIVRABLE VIENT DES DONNÉES — tableur : les lignes lues, source = lien, vérification, limites calculées", async () => {
    const r = await lire(sa, { table: "MedicalDoctor", filtres: CHEFS_INFECTIO, champs: ["name", "institutionRef.name", "serviceRef.name", "wilaya", "phone", "email"] });
    const lectures = [{ cle: "lire", titre: "Chefs de service d'infectiologie", outil: "lire", statut: "DONE", sortie: r }];
    const d = await deposerLivrableTravail(sa.id, { travailId: `t${TAG}`, titre: `Cartographie ${TAG}`, contenu: "## Synthèse\n4 chefs de service.", format: "xlsx", reprise: false, lectures });
    expect(d.ok, JSON.stringify(d)).toBe(true);
    const nodeId = (d as { document: { nodeId: string } }).document.nodeId;
    const v = await prisma.fileVersion.findFirstOrThrow({ where: { nodeId }, orderBy: { version: "desc" }, select: { version: true } });
    const octets = await portsArtefact.documents.lire(sa.id, nodeId, v.version);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(octets as never);
    const f = wb.worksheets[0]!;
    const entete = (f.getRow(1).values as unknown[]).slice(1);
    expect(entete).toEqual(expect.arrayContaining(["name", "Source (fiche)", "Vérification"]));
    expect(f.rowCount - 1).toBe(semis.attendus.length);
    const lignes = f.getSheetValues().slice(2).map((v) => (v as unknown[]).map(String).join(" | "));
    expect(lignes.join("\n")).toMatch(/\/praticiens\//);
    expect(lignes.find((x) => x.includes("Ferhat"))).toMatch(/incomplète \(sans serviceRef\.name, email\)/);
    expect(lignes.find((x) => x.includes("Bouzid"))).toMatch(/ancienne \(mise à jour le 2024-03-01\)/);
    const synthese = wb.getWorksheet("Synthèse")!.getSheetValues().slice(2).map((v) => String((v as unknown[])[1] ?? "")).join("\n");
    expect(synthese).toMatch(/1 ligne\(s\) sur 4 sans « wilaya »/);
    expect(synthese).toMatch(/LIMITES \(calculées/);
  });

  it("LE CONTRÔLE FINAL REFUSE LE VIDE — aucune ligne lue : ÉCHEC nommé (quelle lecture, combien, quel droit), jamais « livré »", async () => {
    const zero = await lire(sa, { table: "MedicalDoctor", filtres: [...CHEFS_INFECTIO, { champ: "wilaya", valeur: "Tamanrasset" }] });
    const d = await deposerLivrableTravail(sa.id, { travailId: `z${TAG}`, titre: "Vide", contenu: "| Nom |\n|---|\n| Non disponible |", format: "xlsx", reprise: false, lectures: [{ cle: "lire", titre: "Chefs", outil: "lire", statut: "DONE", sortie: zero }] });
    expect(d).toMatchObject({ ok: false, definitif: true });
    expect((d as { erreur: string }).erreur).toMatch(/« Chefs » \(lire\) : 0 ligne\(s\) \(filtres : title = CHEF_DE_SERVICE/);
    const refus = controlerLivrable([observerLecture({ cle: "x", titre: "Annuaire", outil: "lire", statut: "FAILED", sortie: null, erreur: "La base « Terrain » ne vous est pas ouverte" })], { format: "docx", lignes: 0 });
    expect(refus).toMatchObject({ ok: false });
    expect((refus as { raison: string }).raison).toMatch(/échec — La base « Terrain »/);
    // Un tableur rédigé par le modèle sans aucune lecture : refusé aussi.
    expect(controlerLivrable([], { format: "xlsx", lignes: 0 })).toMatchObject({ ok: false });
  });

  it("pur : la vérification et les limites ne s'écrivent pas par le modèle", () => {
    const now = new Date("2026-11-04T00:00:00Z");
    expect(verificationDe({ a: "x", b: null, majLe: "2025-01-01" }, ["a", "b"], "majLe", now)).toBe("ancienne (mise à jour le 2025-01-01) ; incomplète (sans b)");
    expect(limitesDuJeu([{ a: "x", b: "" }, { a: null, b: "y" }], ["a", "b"], null, now)).toEqual(["1 ligne(s) sur 2 sans « a »", "1 ligne(s) sur 2 sans « b »"]);
  });
});
