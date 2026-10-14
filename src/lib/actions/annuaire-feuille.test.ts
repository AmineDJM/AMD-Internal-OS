import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR,
  getUser: async () => ACTEUR,
  requireModule: async () => ACTEUR,
}));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { colorerCellulesAnnuaire } from "@/lib/actions/annuaire-couleurs-actions";
import { saveDirectoryCustomCell, addDirectoryDoctor } from "@/lib/actions/medical-directory-actions";
import { createInstitution, updateInstitution } from "@/lib/actions/medical-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__feuille__";
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

/**
 * ═══════════════════════════════════════════════════════════
 * LA FEUILLE DES ANNUAIRES, PAR SES VRAIS POINTS D'ENTRÉE (§118.133).
 *
 * Les server actions que l'écran appelle — pas un état injecté à la main (§118.14). Ce que le
 * module PUR décide (la sélection, la palette) est testé à part ; ici on vérifie que le code
 * l'APPELLE, que la garde est la MÊME que celle de l'écriture d'une cellule, et que la base
 * porte ce qu'il faut — et rien de plus.
 *
 * Les acteurs n'ont PAS de vue globale, sauf là où c'est le fait testé : une garde de portée
 * éprouvée avec un Super Admin ne peut pas tomber (§118.104), et un sabotage qui retirerait
 * `canAccessEntity` passerait au vert.
 * ═══════════════════════════════════════════════════════════
 */
suite("Feuille des annuaires — couleurs, colonnes sur mesure, wilaya", () => {
  let kamA = "", kamB = "", patron = "", lecteur = "";
  let docA = "", docB = "", docAvecColonne = "";
  let dirId = "", etabId = "";

  const acteur = async (id: string, role: string) =>
    ({ id, role, secondaryRole: null, access: await getAccess(id, role as never) } as unknown as SessionUser);

  beforeAll(async () => {
    const mk = (s: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role: role as never, passwordHash: "x" } });
    const [a, b, p, l] = await Promise.all([
      mk("kam-a", "MEDICAL_DELEGATE"), mk("kam-b", "MEDICAL_DELEGATE"), mk("patron", "DIRECTION"), mk("lecteur", "VIEWER"),
    ]);
    kamA = a.id; kamB = b.id; patron = p.id; lecteur = l.id;

    const dir = await prisma.medicalDirectory.create({ data: { name: `${TAG}Infectiologues`, createdById: p.id } });
    dirId = dir.id;
    await prisma.medicalDirectoryColumn.create({
      data: { directoryId: dir.id, key: "c_dernier_congres", label: "Dernier congrès", kind: "DATE", position: 0 },
    });
    await prisma.medicalDirectoryColumn.create({
      data: { directoryId: dir.id, key: "c_score", label: "Score", kind: "NUMBER", position: 1 },
    });
    await prisma.medicalDirectoryColumn.create({
      data: { directoryId: dir.id, key: "c_statut", label: "Statut", kind: "CHOICE", options: "Actif|Dormant", position: 2 },
    });

    const [dA, dB, dC] = await Promise.all([
      prisma.medicalDoctor.create({ data: { name: `${TAG}Dr A`, delegateId: kamA, wilaya: "Alger" } }),
      prisma.medicalDoctor.create({ data: { name: `${TAG}Dr B`, delegateId: kamB, wilaya: "Oran" } }),
      prisma.medicalDoctor.create({ data: { name: `${TAG}Dr C`, delegateId: kamA, directoryId: dir.id } }),
    ]);
    docA = dA.id; docB = dB.id; docAvecColonne = dC.id;

    const etab = await prisma.medicalInstitution.create({ data: { name: `${TAG}CHU Test`, wilaya: "ALGER" } });
    etabId = etab.id;
  });

  afterAll(async () => {
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.medicalInstitution.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.medicalDirectory.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  // ── LES PRÉMISSES DES ACTEURS, vérifiées : sans elles, les cas ci-dessous ne prouvent rien. ──
  it("les acteurs sont ce que le banc croit qu'ils sont", async () => {
    const a = await acteur(kamA, "MEDICAL_DELEGATE");
    const l = await acteur(lecteur, "VIEWER");
    expect(userCan(a, "MEDICAL", "UPDATE")).toBe(true);
    expect(userCan(l, "MEDICAL", "UPDATE")).toBe(false);
  });

  describe("colorer des cellules — la même garde que l'écriture d'une cellule", () => {
    it("un délégué colore la cellule de SON praticien, et la couleur est en base sous sa clé de palette", async () => {
      ACTEUR = await acteur(kamA, "MEDICAL_DELEGATE");
      const r = await colorerCellulesAnnuaire({ feuille: "praticiens", cellules: [`${docA}:wilaya`], couleur: "jaune" });
      expect(r.ok).toBe(true);
      expect(r.touchees).toBe(1);
      expect(r.ignorees).toBe(0);
      const rows = await prisma.directoryCellStyle.findMany({ where: { doctorId: docA } });
      expect(rows.map((x) => [x.field, x.color])).toEqual([["wilaya", "jaune"]]);
      expect(rows[0]!.setById).toBe(kamA);
    });

    it("une sélection qui déborde sur le praticien d'un AUTRE délégué ne colore que le sien — et le dit", async () => {
      ACTEUR = await acteur(kamA, "MEDICAL_DELEGATE");
      const r = await colorerCellulesAnnuaire({
        feuille: "praticiens",
        cellules: [`${docA}:phone`, `${docB}:phone`],
        couleur: "vert",
      });
      expect(r.ok).toBe(true);
      expect(r.touchees).toBe(1);
      expect(r.ignorees).toBe(1);
      expect(r.message).toContain("hors de votre portée");
      expect(await prisma.directoryCellStyle.count({ where: { doctorId: docB } })).toBe(0);
      // Et quand RIEN n'est à sa portée, c'est un refus, pas un « 0 cellule colorée » vert.
      const rien = await colorerCellulesAnnuaire({ feuille: "praticiens", cellules: [`${docB}:phone`], couleur: "vert" });
      expect(rien.ok).toBe(false);
      expect(rien.ignorees).toBe(1);
    });

    it("une couleur hors palette est refusée ; une colonne que la feuille n'a pas est ignorée", async () => {
      ACTEUR = await acteur(kamA, "MEDICAL_DELEGATE");
      const hex = await colorerCellulesAnnuaire({ feuille: "praticiens", cellules: [`${docA}:wilaya`], couleur: "#ffff00" });
      expect(hex.ok).toBe(false);
      expect(hex.error).toContain("palette");
      // « city » n'est plus une colonne de la feuille : la colorer fabriquerait une couleur invisible.
      const ville = await colorerCellulesAnnuaire({ feuille: "praticiens", cellules: [`${docA}:city`], couleur: "bleu" });
      expect(ville.ok).toBe(false);
      expect(await prisma.directoryCellStyle.count({ where: { doctorId: docA, field: "city" } })).toBe(0);
    });

    it("recolorer remplace ; effacer supprime la ligne ; une cellule effacée deux fois reste effacée", async () => {
      ACTEUR = await acteur(kamA, "MEDICAL_DELEGATE");
      await colorerCellulesAnnuaire({ feuille: "praticiens", cellules: [`${docA}:wilaya`], couleur: "rouge" });
      expect((await prisma.directoryCellStyle.findFirst({ where: { doctorId: docA, field: "wilaya" } }))?.color).toBe("rouge");
      const eff = await colorerCellulesAnnuaire({ feuille: "praticiens", cellules: [`${docA}:wilaya`], couleur: null });
      expect(eff.ok).toBe(true);
      expect(eff.touchees).toBe(1);
      expect(await prisma.directoryCellStyle.count({ where: { doctorId: docA, field: "wilaya" } })).toBe(0);
      const encore = await colorerCellulesAnnuaire({ feuille: "praticiens", cellules: [`${docA}:wilaya`], couleur: "" });
      expect(encore.ok).toBe(true);
    });

    it("la clé d'une colonne sur mesure n'est acceptée que pour une fiche de l'annuaire qui la porte", async () => {
      ACTEUR = await acteur(kamA, "MEDICAL_DELEGATE");
      const ok = await colorerCellulesAnnuaire({ feuille: "praticiens", cellules: [`${docAvecColonne}:c_score`], couleur: "violet" });
      expect(ok.ok).toBe(true);
      expect(ok.touchees).toBe(1);
      // La même clé sur une fiche de l'annuaire GÉNÉRAL : la colonne n'existe pas là.
      const hors = await colorerCellulesAnnuaire({ feuille: "praticiens", cellules: [`${docA}:c_score`], couleur: "violet" });
      expect(hors.ok).toBe(false);
    });

    it("les établissements demandent le droit de modification du module — un simple lecteur est refusé", async () => {
      ACTEUR = await acteur(lecteur, "VIEWER");
      const refus = await colorerCellulesAnnuaire({ feuille: "etablissements", cellules: [`${etabId}:name`], couleur: "jaune" });
      expect(refus.ok).toBe(false);
      expect(await prisma.directoryCellStyle.count({ where: { institutionId: etabId } })).toBe(0);
      ACTEUR = await acteur(patron, "DIRECTION");
      const ok = await colorerCellulesAnnuaire({ feuille: "etablissements", cellules: [`${etabId}:name`, `${etabId}:wilaya`], couleur: "jaune" });
      expect(ok.ok).toBe(true);
      expect(ok.touchees).toBe(2);
      // Une colonne inconnue de la feuille des établissements est ignorée, pas écrite.
      const inconnue = await colorerCellulesAnnuaire({ feuille: "etablissements", cellules: [`${etabId}:city`], couleur: "jaune" });
      expect(inconnue.ok).toBe(false);
    });

    it("supprimer la ligne emporte ses couleurs — la cascade, pas un nettoyage à penser", async () => {
      ACTEUR = await acteur(kamA, "MEDICAL_DELEGATE");
      const ephemere = await prisma.medicalDoctor.create({ data: { name: `${TAG}Dr Éphémère`, delegateId: kamA } });
      await colorerCellulesAnnuaire({ feuille: "praticiens", cellules: [`${ephemere.id}:email`], couleur: "gris" });
      expect(await prisma.directoryCellStyle.count({ where: { doctorId: ephemere.id } })).toBe(1);
      await prisma.medicalDoctor.delete({ where: { id: ephemere.id } });
      expect(await prisma.directoryCellStyle.count({ where: { doctorId: ephemere.id } })).toBe(0);
    });
  });

  describe("les colonnes sur mesure s'éditent selon leur type", () => {
    it("un nombre accepte la virgule française et refuse un mot ; un choix n'accepte que ses options", async () => {
      ACTEUR = await acteur(kamA, "MEDICAL_DELEGATE");
      expect((await saveDirectoryCustomCell({ id: docAvecColonne, key: "c_score", value: "12,5" })).ok).toBe(true);
      let d = await prisma.medicalDoctor.findUnique({ where: { id: docAvecColonne }, select: { custom: true } });
      expect((d?.custom as Record<string, unknown>).c_score).toBe(12.5);

      const mot = await saveDirectoryCustomCell({ id: docAvecColonne, key: "c_score", value: "douze" });
      expect(mot.ok).toBe(false);
      expect(mot.error).toContain("nombre");

      const choix = await saveDirectoryCustomCell({ id: docAvecColonne, key: "c_statut", value: "Perdu" });
      expect(choix.ok).toBe(false);
      expect(choix.error).toContain("Actif");
      expect((await saveDirectoryCustomCell({ id: docAvecColonne, key: "c_statut", value: "Dormant" })).ok).toBe(true);

      const date = await saveDirectoryCustomCell({ id: docAvecColonne, key: "c_dernier_congres", value: "12/09/2026" });
      expect(date.ok).toBe(false);
      expect((await saveDirectoryCustomCell({ id: docAvecColonne, key: "c_dernier_congres", value: "2026-09-12" })).ok).toBe(true);

      // Une valeur vide EFFACE la clé — une cellule vidée est une absence, pas une chaîne vide.
      expect((await saveDirectoryCustomCell({ id: docAvecColonne, key: "c_score", value: "  " })).ok).toBe(true);
      d = await prisma.medicalDoctor.findUnique({ where: { id: docAvecColonne }, select: { custom: true } });
      const custom = d?.custom as Record<string, unknown>;
      expect("c_score" in custom).toBe(false);
      expect(custom.c_statut).toBe("Dormant");
      expect(custom.c_dernier_congres).toBe("2026-09-12");
    });

    it("la clé d'un autre annuaire est refusée, et la garde de ligne est celle des cellules", async () => {
      ACTEUR = await acteur(kamA, "MEDICAL_DELEGATE");
      const general = await saveDirectoryCustomCell({ id: docA, key: "c_score", value: "3" });
      expect(general.ok).toBe(false);
      ACTEUR = await acteur(kamB, "MEDICAL_DELEGATE");
      const autrui = await saveDirectoryCustomCell({ id: docAvecColonne, key: "c_score", value: "3" });
      expect(autrui.ok).toBe(false);
      expect(autrui.error).toContain("Non autorisé");
    });
  });

  describe("la wilaya est le seul découpage géographique — liste fermée, casse pardonnée", () => {
    it("un établissement créé avec « ALGER » porte « Alger » ; « Atlantis » est refusée ; la ville est ignorée", async () => {
      ACTEUR = await acteur(patron, "DIRECTION");
      const r = await createInstitution(fd({ name: `${TAG}EPH Nouveau`, type: "EPH", sector: "PUBLIC", wilaya: "ALGER", city: "Rouiba" }));
      expect(r.ok).toBe(true);
      const row = await prisma.medicalInstitution.findUnique({ where: { id: r.id! } });
      expect(row?.wilaya).toBe("Alger");
      expect(row?.city).toBeNull();

      const faux = await createInstitution(fd({ name: `${TAG}Clinique Nulle Part`, wilaya: "Atlantis" }));
      expect(faux.ok).toBe(false);
      expect(faux.error).toContain("58 wilayas");
      expect(await prisma.medicalInstitution.count({ where: { name: `${TAG}Clinique Nulle Part` } })).toBe(0);

      const modif = await updateInstitution(fd({ id: r.id!, name: `${TAG}EPH Nouveau`, wilaya: "oran" }));
      expect(modif.ok).toBe(true);
      expect((await prisma.medicalInstitution.findUnique({ where: { id: r.id! } }))?.wilaya).toBe("Oran");
    });

    it("une fiche ajoutée depuis l'onglet Pharmaciens porte le grade PHARMACIEN et l'annuaire visé", async () => {
      ACTEUR = await acteur(kamA, "MEDICAL_DELEGATE");
      const r = await addDirectoryDoctor({ lastName: `${TAG}Officine`, firstName: "Nadia", specialty: "", wilaya: "Béjaïa", title: "PHARMACIEN", directoryId: dirId });
      expect(r.ok).toBe(true);
      const row = await prisma.medicalDoctor.findUnique({ where: { id: r.id! } });
      expect(row?.title).toBe("PHARMACIEN");
      expect(row?.directoryId).toBe(dirId);
      expect(row?.wilaya).toBe("Béjaïa");
      const mauvais = await addDirectoryDoctor({ lastName: `${TAG}X`, firstName: "", specialty: "", wilaya: "", title: "ARCHIDUC" });
      expect(mauvais.ok).toBe(false);
    });
  });
});
