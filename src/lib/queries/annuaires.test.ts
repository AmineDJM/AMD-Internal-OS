import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { chargerFeuillePraticiens, chargerEtablissements } from "@/lib/queries/annuaires";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__chargeurs__";

/**
 * ═══════════════════════════════════════════════════════════
 * LES CHARGEURS DES ANNUAIRES, PAR LE VRAI POINT D'ENTRÉE.
 *
 * Le module « Annuaires » et les écrans d'origine lisent la MÊME fonction ; ce banc tient ce
 * qu'elle promet à un acteur SANS vue globale — un délégué — parce qu'une portée éprouvée avec un
 * Super Admin ne peut pas tomber (§118.104) :
 *   - le grade sépare médecins et pharmaciens, et les comptes suivent le même filtre ;
 *   - un annuaire nommé FERMÉ rend `null` à qui n'y est pas nommé, et ses fiches n'apparaissent
 *     pas dans la vue « Tous » ;
 *   - le compte de praticiens par établissement se calcule dans la portée de la personne.
 * ═══════════════════════════════════════════════════════════
 */
suite("Chargeurs des annuaires — grade, annuaire fermé, portée", () => {
  let kam = "", autre = "", patron = "";
  let dirFerme = "", etab = "";

  const acteur = async (id: string, role: string) =>
    ({ id, role, secondaryRole: null, access: await getAccess(id, role as never) } as unknown as SessionUser);

  beforeAll(async () => {
    const mk = (s: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role: role as never, passwordHash: "x" } });
    const [k, a, p] = await Promise.all([mk("kam", "MEDICAL_DELEGATE"), mk("autre", "MEDICAL_DELEGATE"), mk("patron", "DIRECTION")]);
    kam = k.id; autre = a.id; patron = p.id;

    const e = await prisma.medicalInstitution.create({ data: { name: `${TAG}EPH Test`, wilaya: "Alger" } });
    etab = e.id;
    // Un annuaire FERMÉ à une seule personne (l'autre délégué).
    const d = await prisma.medicalDirectory.create({ data: { name: `${TAG}Ferme`, createdById: p.id } });
    dirFerme = d.id;
    await prisma.medicalDirectoryAccess.create({ data: { directoryId: d.id, userId: autre, grantedById: p.id } });

    await Promise.all([
      prisma.medicalDoctor.create({ data: { name: `${TAG}Dr Médecin`, delegateId: kam, title: "GENERALISTE", institutionId: etab } }),
      prisma.medicalDoctor.create({ data: { name: `${TAG}Pharmacien Officine`, delegateId: kam, title: "PHARMACIEN" } }),
      prisma.medicalDoctor.create({ data: { name: `${TAG}Dr Autre`, delegateId: autre, title: "PROFESSEUR", institutionId: etab } }),
      prisma.medicalDoctor.create({ data: { name: `${TAG}Dr Dans Fermé`, delegateId: kam, directoryId: d.id } }),
    ]);
  });

  afterAll(async () => {
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.medicalDirectory.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.medicalInstitution.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("le grade filtre la feuille ET ses comptes ; la portée du délégué tient", async () => {
    const u = await acteur(kam, "MEDICAL_DELEGATE");
    const medecins = await chargerFeuillePraticiens(u, { grade: "medecins", canManage: false });
    const pharmaciens = await chargerFeuillePraticiens(u, { grade: "pharmaciens", canManage: false });
    const tous = await chargerFeuillePraticiens(u, { grade: null, canManage: false });
    const noms = (f: NonNullable<typeof tous>) => f.rows.map((r) => r.id);
    expect(medecins && pharmaciens && tous).toBeTruthy();
    if (!medecins || !pharmaciens || !tous) return;
    // Dans la portée du délégué : un médecin visible, un pharmacien, et une fiche rangée dans un
    // annuaire FERMÉ qui ne doit apparaître dans aucune des trois vues.
    expect(medecins.rows).toHaveLength(1);
    expect(pharmaciens.rows).toHaveLength(1);
    expect(tous.rows).toHaveLength(2);
    expect(medecins.rows.every((r) => r.title !== "PHARMACIEN")).toBe(true);
    expect(pharmaciens.rows.every((r) => r.title === "PHARMACIEN")).toBe(true);
    // Le délégué ne voit pas les fiches de l'autre — dans aucune des trois vues.
    const autres = await prisma.medicalDoctor.findMany({ where: { delegateId: autre }, select: { id: true } });
    for (const f of [medecins, pharmaciens, tous]) for (const a of autres) expect(noms(f)).not.toContain(a.id);
    // Les comptes de l'annuaire général suivent le grade : un pharmacien ne compte pas chez les médecins.
    expect(pharmaciens.generalCount).toBe(1);
    expect(medecins.generalCount).toBeGreaterThanOrEqual(1);
    expect(tous.generalCount).toBe(medecins.generalCount + pharmaciens.generalCount);
    // `people` n'est chargé que pour qui GÈRE : un délégué ne reçoit pas la liste des comptes.
    expect(tous.people).toEqual([]);
  });

  it("un annuaire fermé rend null à qui n'y est pas nommé, et ses fiches n'entrent pas dans « Tous »", async () => {
    const u = await acteur(kam, "MEDICAL_DELEGATE");
    expect(await chargerFeuillePraticiens(u, { annuaire: dirFerme, grade: null, canManage: false })).toBeNull();
    const tous = await chargerFeuillePraticiens(u, { grade: null, canManage: false });
    const dansFerme = await prisma.medicalDoctor.findFirst({ where: { name: `${TAG}Dr Dans Fermé` }, select: { id: true } });
    expect(tous?.rows.map((r) => r.id)).not.toContain(dansFerme?.id);
    expect(tous?.directories.map((d) => d.id)).not.toContain(dirFerme);
    // Celui qui y est nommé l'ouvre ; la direction aussi.
    const nomme = await acteur(autre, "MEDICAL_DELEGATE");
    expect((await chargerFeuillePraticiens(nomme, { annuaire: dirFerme, grade: null, canManage: false }))?.openDirectoryId).toBe(dirFerme);
    const dir = await acteur(patron, "DIRECTION");
    expect((await chargerFeuillePraticiens(dir, { annuaire: dirFerme, grade: null, canManage: true }))?.directories.map((d) => d.id)).toContain(dirFerme);
  });

  it("le compte de praticiens par établissement se calcule dans la portée de la personne", async () => {
    const u = await acteur(kam, "MEDICAL_DELEGATE");
    const feuille = await chargerEtablissements(u);
    const ligne = feuille.rows.find((r) => r.id === etab);
    // Deux praticiens y sont rattachés (le sien et celui de l'autre délégué) : il n'en voit qu'un.
    expect(ligne?.doctorCount).toBe(1);
    const dir = await acteur(patron, "DIRECTION");
    expect((await chargerEtablissements(dir)).rows.find((r) => r.id === etab)?.doctorCount).toBe(2);
    // Et la wilaya héritée est rendue sous son nom officiel.
    expect(ligne?.wilaya).toBe("Alger");
  });
});
