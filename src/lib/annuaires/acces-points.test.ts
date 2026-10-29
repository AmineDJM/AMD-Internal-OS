import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR,
  getUser: async () => ACTEUR,
  getCurrentUser: async () => ACTEUR,
  requireModule: async () => ACTEUR,
}));

import { readFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { getAccess, userCan, peutAnnuaire, type SessionUser } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { canAccessEntity } from "@/lib/entity-access";
import { visibleTabs } from "@/lib/nav-tabs";
import { ANNUAIRES_TABS } from "@/lib/labels";
import { canEditDirectory } from "@/lib/directory/access";
import { chargerFeuillePraticiens } from "@/lib/queries/annuaires";
import { createInstitution, updateInstitution, deleteInstitution } from "@/lib/actions/medical-actions";
import { createCompanyContact } from "@/lib/actions/company-contact-actions";
import { addDirectoryDoctor, saveDirectoryCell, deleteDirectoryDoctors } from "@/lib/actions/medical-directory-actions";
import { colorerCellulesAnnuaire } from "@/lib/actions/annuaire-couleurs-actions";
import { saveAccessMatrix, saveModuleAccess } from "@/lib/actions/access-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__acces_annuaire__";
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ACCÈS PAR ANNUAIRE, PAR SES VRAIS POINTS D'ENTRÉE (§118.147, §118.14).
 *
 * Tous les acteurs sont des LECTEURS sans vue globale et sans le module du référentiel — c'est
 * précisément la personne pour qui la règle existe (l'assistante à qui l'on ouvre les
 * établissements sans lui ouvrir la Promotion médicale). Une porte éprouvée avec un Super Admin
 * ne peut pas tomber (§118.104) ; les prémisses de chaque acteur sont donc VÉRIFIÉES d'abord.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Accès par annuaire — écrans, actions, console, conversation", () => {
  let assistante = "", lecteurMed = "", bloque = "", personnes = "", admin = "", kam = "", cible = "";
  let docMed = "", docPharma = "", etab = "";

  // Le compte de session porte aussi son nom et son adresse : `canEditDirectory` lit un
  // `CurrentUser`, et un acteur amputé ne compilerait pas là où l'écran l'appelle.
  const acteur = async (id: string, role = "VIEWER") =>
    ({
      id, role, secondaryRole: null, name: TAG, email: `${TAG}${id}`, mustChangePassword: false,
      access: await getAccess(id, role as never),
    } as unknown as SessionUser & CurrentUser);

  /**
   * LE NETTOYAGE ATTRAPE CE QUE LE BANC ÉCRIT — nom composé compris. Une fiche ajoutée par la
   * feuille s'appelle « Nouveau __tag__Médecin » : un critère `name startsWith TAG` la manquait, et
   * deux sabotages joués ont laissé des pharmaciens en base, qui ont fait tomber le cas suivant
   * sur un compte de 2 au lieu de 0 (§118.91 : un nettoyage qui ne trouve pas ce qu'il a écrit).
   * Joué AVANT comme APRÈS : un run interrompu ne doit pas empoisonner le suivant.
   */
  const nettoyer = async () => {
    const fiches = { OR: [{ name: { startsWith: TAG } }, { lastName: { startsWith: TAG } }] };
    await prisma.directoryCellStyle.deleteMany({ where: { OR: [{ doctor: fiches }, { institution: { name: { startsWith: TAG } } }] } }).catch(() => {});
    await prisma.medicalDoctor.deleteMany({ where: fiches }).catch(() => {});
    await prisma.medicalInstitution.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.companyContact.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  };

  beforeAll(async () => {
    await nettoyer();
    const mk = (s: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role: role as never, passwordHash: "x" } });
    const [a, l, b, p, ad, k, c] = await Promise.all([
      mk("assistante", "VIEWER"), mk("lecteur-med", "VIEWER"), mk("bloque", "VIEWER"), mk("personnes", "VIEWER"),
      mk("admin", "SUPER_ADMIN"), mk("kam", "MEDICAL_DELEGATE"), mk("cible", "VIEWER"),
    ]);
    assistante = a.id; lecteurMed = l.id; bloque = b.id; personnes = p.id; admin = ad.id; kam = k.id; cible = c.id;

    const acces = (userId: string, o: { view?: boolean; create?: boolean; update?: boolean; del?: boolean; sections: string[] }) =>
      prisma.userAccess.create({
        data: {
          userId, module: "DIRECTORIES", canView: o.view ?? true,
          canCreate: o.create ?? false, canUpdate: o.update ?? false, canDelete: o.del ?? false,
          scope: "ALL", sections: o.sections,
        },
      });
    await Promise.all([
      // L'assistante : établissements ET partenaires, en création et modification — pas en suppression.
      acces(assistante, { create: true, update: true, sections: ["ETABLISSEMENTS", "PARTENAIRES"] }),
      // Un lecteur à qui l'on ouvre l'annuaire des MÉDECINS seulement.
      acces(lecteurMed, { create: true, update: true, sections: ["MEDECINS"] }),
      // Un accès BLOQUÉ qui porte des sections en base (formulaire forgé, ou reste d'un ancien
      // réglage) : elles ne doivent rien ouvrir.
      acces(bloque, { view: false, create: true, update: true, del: true, sections: ["MEDECINS"] }),
      acces(personnes, { update: true, sections: ["PERSONNES"] }),
    ]);

    const [dm, dp] = await Promise.all([
      prisma.medicalDoctor.create({ data: { name: `${TAG}Dr Med`, title: "PROFESSEUR", delegateId: k.id, wilaya: "Alger" } }),
      prisma.medicalDoctor.create({ data: { name: `${TAG}Dr Pharma`, title: "PHARMACIEN", delegateId: k.id, wilaya: "Oran" } }),
    ]);
    docMed = dm.id; docPharma = dp.id;
    etab = (await prisma.medicalInstitution.create({ data: { name: `${TAG}CHU Témoin`, wilaya: "ALGER" } })).id;
  });

  afterAll(nettoyer);

  it("PRÉMISSES : ces lecteurs n'ont ni la Promotion médicale, ni les Moyens généraux", async () => {
    // Sans ces lignes, chaque cas ci-dessous pourrait passer par le module du référentiel et ne
    // plus rien prouver de la section cochée.
    for (const id of [assistante, lecteurMed, bloque, personnes]) {
      const u = await acteur(id);
      expect(userCan(u, "MEDICAL", "VIEW"), id).toBe(false);
      expect(userCan(u, "GENERAL_MEANS", "CREATE"), id).toBe(false);
      expect(userCan(u, "RH", "UPDATE"), id).toBe(false);
    }
  });

  describe("l'accès effectif porte les annuaires cochés — et seulement sur un accès personnalisé", () => {
    it("les sections voyagent avec l'accès au module Annuaires", async () => {
      const a = await acteur(assistante);
      expect([...(a.access.modules.get("DIRECTORIES")?.sections ?? [])].sort()).toEqual(["ETABLISSEMENTS", "PARTENAIRES"]);
    });

    it("un accès BLOQUÉ n'ouvre rien, quelles que soient les sections en base", async () => {
      const b = await acteur(bloque);
      expect(peutAnnuaire(b, "MEDECINS", "VIEW")).toBe(false);
      expect(await canAccessEntity(b, "DOCTOR", docMed, "UPDATE")).toBe(false);
    });
  });

  describe("les ONGLETS s'ouvrent à la personne à qui l'on vient d'ouvrir l'annuaire", () => {
    it("l'assistante voit les établissements et les partenaires, jamais les praticiens", async () => {
      const onglets = await visibleTabs(await acteur(assistante), ANNUAIRES_TABS);
      const vu = Object.fromEntries(onglets.map((t) => [t.label, t.show]));
      expect(vu["Établissements"]).toBe(true);
      expect(vu["Partenaires"]).toBe(true);
      expect(vu["Médecins"]).toBe(false);
      expect(vu["Pharmaciens"]).toBe(false);
    });

    it("l'annuaire des médecins n'ouvre PAS celui des pharmaciens", async () => {
      const onglets = await visibleTabs(await acteur(lecteurMed), ANNUAIRES_TABS);
      const vu = Object.fromEntries(onglets.map((t) => [t.label, t.show]));
      expect(vu["Médecins"]).toBe(true);
      expect(vu["Pharmaciens"]).toBe(false);
      expect(vu["Établissements"]).toBe(false);
    });
  });

  describe("les ÉTABLISSEMENTS et les PARTENAIRES, par les actions de l'écran", () => {
    it("l'assistante crée et modifie un établissement ; la suppression, non cochée, reste fermée", async () => {
      ACTEUR = await acteur(assistante);
      const cree = await createInstitution(fd({ name: `${TAG}Clinique Nouvelle`, wilaya: "ALGER" }));
      expect(cree.ok, cree.error).toBe(true);
      const maj = await updateInstitution(fd({ id: etab, name: `${TAG}CHU Témoin`, wilaya: "BLIDA", type: "CHU", sector: "PUBLIC" }));
      expect(maj.ok, maj.error).toBe(true);
      expect((await prisma.medicalInstitution.findUnique({ where: { id: etab } }))?.wilaya).toBe("Blida");
      const sup = await deleteInstitution(fd({ id: etab }));
      expect(sup.ok).toBe(false);
      expect(await prisma.medicalInstitution.count({ where: { id: etab } })).toBe(1);
    });

    it("un lecteur SANS la section établissements est refusé — la section ne se devine pas", async () => {
      ACTEUR = await acteur(lecteurMed);
      const r = await createInstitution(fd({ name: `${TAG}Refusée`, wilaya: "ALGER" }));
      expect(r.ok).toBe(false);
      expect(await prisma.medicalInstitution.count({ where: { name: `${TAG}Refusée` } })).toBe(0);
    });

    it("l'assistante ajoute un partenaire ; le lecteur des médecins, non", async () => {
      ACTEUR = await acteur(assistante);
      const ok = await createCompanyContact(undefined, fd({ name: `${TAG}Traiteur du Port`, kind: "Traiteur" }));
      expect(ok.ok, ok.error).toBe(true);
      ACTEUR = await acteur(lecteurMed);
      const non = await createCompanyContact(undefined, fd({ name: `${TAG}Refusé` }));
      expect(non.ok).toBe(false);
    });

    it("les couleurs de la feuille des établissements suivent la même porte ; celles des praticiens, non", async () => {
      ACTEUR = await acteur(assistante);
      const ok = await colorerCellulesAnnuaire({ feuille: "etablissements", cellules: [`${etab}:wilaya`], couleur: "vert" });
      expect(ok.ok, ok.error).toBe(true);
      const non = await colorerCellulesAnnuaire({ feuille: "praticiens", cellules: [`${docMed}:wilaya`], couleur: "vert" });
      expect(non.ok).toBe(false);
      expect(await prisma.directoryCellStyle.count({ where: { doctorId: docMed } })).toBe(0);
    });
  });

  describe("les PRATICIENS : l'annuaire de SON grade, ligne par ligne", () => {
    it("la garde par enregistrement suit le grade de la fiche", async () => {
      const l = await acteur(lecteurMed);
      expect(await canAccessEntity(l, "DOCTOR", docMed, "UPDATE")).toBe(true);
      expect(await canAccessEntity(l, "DOCTOR", docPharma, "UPDATE")).toBe(false);
      // Le geste non coché reste fermé, même sur l'annuaire ouvert.
      expect(await canAccessEntity(l, "DOCTOR", docMed, "DELETE")).toBe(false);
      // Et qui n'a pas coché les praticiens ne lit pas une fiche par son identifiant.
      expect(await canAccessEntity(await acteur(assistante), "DOCTOR", docMed, "VIEW")).toBe(false);
    });

    it("écrire une cellule : le médecin oui, le pharmacien non", async () => {
      ACTEUR = await acteur(lecteurMed);
      const ok = await saveDirectoryCell({ id: docMed, field: "wilaya", value: "Tizi Ouzou" });
      expect(ok.ok, ok.error).toBe(true);
      const non = await saveDirectoryCell({ id: docPharma, field: "wilaya", value: "Tizi Ouzou" });
      expect(non.ok).toBe(false);
      expect((await prisma.medicalDoctor.findUnique({ where: { id: docPharma } }))?.wilaya).toBe("Oran");
    });

    it("ajouter une ligne : le grade de la NOUVELLE fiche décide de l'annuaire", async () => {
      ACTEUR = await acteur(lecteurMed);
      const med = await addDirectoryDoctor({ lastName: `${TAG}Médecin`, firstName: "Nouveau", specialty: "", wilaya: "" });
      expect(med.ok, med.error).toBe(true);
      // Ce qui le ferait tomber : lire le droit AVANT le grade, donc juger un pharmacien sur
      // l'annuaire des médecins.
      const pharma = await addDirectoryDoctor({ lastName: `${TAG}Pharmacien`, firstName: "Refusé", specialty: "", wilaya: "", title: "PHARMACIEN" });
      expect(pharma.ok).toBe(false);
      expect(pharma.ok ? "" : pharma.error).toContain("pharmaciens");
      expect(await prisma.medicalDoctor.count({ where: { lastName: `${TAG}Pharmacien` } })).toBe(0);
    });

    it("supprimer, non coché, est refusé à la porte ; les couleurs ne débordent pas sur l'autre grade", async () => {
      ACTEUR = await acteur(lecteurMed);
      const sup = await deleteDirectoryDoctors([docMed]);
      expect(sup.ok).toBe(false);
      expect(await prisma.medicalDoctor.count({ where: { id: docMed } })).toBe(1);
      const c = await colorerCellulesAnnuaire({ feuille: "praticiens", cellules: [`${docMed}:phone`, `${docPharma}:phone`], couleur: "jaune" });
      expect(c.ok, c.error).toBe(true);
      expect(c.touchees).toBe(1);
      expect(c.ignorees).toBe(1);
      expect(await prisma.directoryCellStyle.count({ where: { doctorId: docPharma } })).toBe(0);
    });

    it("l'annuaire ouvert par la console s'ouvre EN ENTIER — pas la portée d'un délégué, qui serait vide", async () => {
      const l = await acteur(lecteurMed);
      const entier = await chargerFeuillePraticiens(l, { grade: "medecins", canManage: false, entier: true });
      const ids = new Set(entier?.rows.map((r) => r.id));
      // La fiche d'un AUTRE délégué y est : c'est un référentiel, pas un portefeuille.
      expect(ids.has(docMed)).toBe(true);
      expect(ids.has(docPharma), "le grade filtre toujours").toBe(false);
      // Sans `entier`, la portée du MODULE s'applique — et ce lecteur n'en a aucune. C'est ce qui
      // rend la décision de la page nécessaire, et ce cas ce qui la prouve.
      const module = await chargerFeuillePraticiens(l, { grade: "medecins", canManage: false });
      expect(module?.rows.some((r) => r.id === docMed)).toBe(false);
    });
  });

  describe("les PERSONNES : seule la modification a un sens", () => {
    it("la section personnes ouvre la tenue de l'annuaire ; l'absence de section, non", async () => {
      expect(canEditDirectory(await acteur(personnes))).toBe(true);
      expect(canEditDirectory(await acteur(assistante))).toBe(false);
    });
  });

  describe("la CONSOLE enregistre ce qu'elle montre — et rien d'autre", () => {
    it("la matrice d'un compte : les annuaires cochés sur un accès personnalisé au module Annuaires", async () => {
      ACTEUR = await acteur(admin, "SUPER_ADMIN");
      const r = await saveAccessMatrix(fd({
        userId: cible,
        mode_DIRECTORIES: "CUSTOM", act_DIRECTORIES_UPDATE: "on",
        sect_DIRECTORIES_ETABLISSEMENTS: "on", sect_DIRECTORIES_BIDON: "on",
        // Un autre module ne porte JAMAIS de sections, même si un formulaire en envoie.
        mode_RH: "CUSTOM", sect_RH_MEDECINS: "on",
      }));
      expect(r.ok, r.error).toBe(true);
      const lignes = await prisma.userAccess.findMany({ where: { userId: cible }, select: { module: true, sections: true } });
      const par = Object.fromEntries(lignes.map((l) => [l.module, l.sections]));
      expect(par.DIRECTORIES).toEqual(["ETABLISSEMENTS"]);
      expect(par.RH).toEqual([]);
      // Et l'effet est RÉEL : la personne modifie désormais les établissements.
      expect(peutAnnuaire(await acteur(cible), "ETABLISSEMENTS", "UPDATE")).toBe(true);
    });

    it("bloquer l'accès efface les annuaires : un accès bloqué n'en porte pas", async () => {
      ACTEUR = await acteur(admin, "SUPER_ADMIN");
      await saveAccessMatrix(fd({ userId: cible, mode_DIRECTORIES: "BLOCKED", sect_DIRECTORIES_ETABLISSEMENTS: "on" }));
      const l = await prisma.userAccess.findUnique({ where: { userId_module: { userId: cible, module: "DIRECTORIES" } } });
      expect(l?.canView).toBe(false);
      expect(l?.sections).toEqual([]);
    });

    it("la vue « par module » enregistre les annuaires du compte, par son identifiant", async () => {
      ACTEUR = await acteur(admin, "SUPER_ADMIN");
      const f = new FormData();
      f.set("module", "DIRECTORIES");
      f.append("userId", cible);
      f.set(`mode_${cible}`, "CUSTOM");
      f.set(`act_${cible}_CREATE`, "on");
      f.set(`sect_${cible}_PARTENAIRES`, "on");
      f.set(`sect_${cible}_PHARMACIENS`, "on");
      const r = await saveModuleAccess(f);
      expect(r.ok, r.error).toBe(true);
      const l = await prisma.userAccess.findUnique({ where: { userId_module: { userId: cible, module: "DIRECTORIES" } } });
      expect(l?.sections).toEqual(["PHARMACIENS", "PARTENAIRES"]);
      expect(peutAnnuaire(await acteur(cible), "PHARMACIENS", "CREATE")).toBe(true);
    });

    it("hors Super Admin, la console refuse — les sections ne se posent pas par une porte à côté", async () => {
      ACTEUR = await acteur(assistante);
      const r = await saveAccessMatrix(fd({ userId: assistante, mode_DIRECTORIES: "CUSTOM", sect_DIRECTORIES_MEDECINS: "on" }));
      expect(r.ok).toBe(false);
      const l = await prisma.userAccess.findUnique({ where: { userId_module: { userId: assistante, module: "DIRECTORIES" } } });
      expect(l?.sections).not.toContain("MEDECINS");
    });
  });
});

/**
 * LES POINTS D'APPEL (§118.49) — les écrans qui montrent un annuaire lisent LA règle, pas le
 * module seul. Vérifier le corps de `peutAnnuaire` sans ses appelants ne prouverait rien : le
 * défaut que ce lot ferme n'était pas une règle fausse, c'était une règle que personne ne posait.
 */
describe("les écrans et la conversation interrogent la règle de l'annuaire", () => {
  const lire = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("chaque page d'annuaire garde sa porte par peutAnnuaire", () => {
    expect(lire("src/app/(app)/annuaires/feuille-praticiens.tsx")).toMatch(/peutAnnuaire\(user, cle, "VIEW"\)/);
    expect(lire("src/app/(app)/annuaires/etablissements/page.tsx")).toMatch(/peutAnnuaire\(user, "ETABLISSEMENTS", "VIEW"\)/);
    expect(lire("src/app/(app)/annuaires/partenaires/page.tsx")).toMatch(/peutAnnuaire\(user, "PARTENAIRES", "CREATE"\)/);
  });

  it("la feuille ouverte par la console se charge EN ENTIER, et l'import de fichier reste à la Promotion médicale", () => {
    const src = lire("src/app/(app)/annuaires/feuille-praticiens.tsx");
    expect(src).toMatch(/entier:\s*annuaireOuvertParConsole\(user, cle, "VIEW"\)/);
    expect(src).toMatch(/canImportFile=\{userCan\(user, "MEDICAL", "CREATE"\)\}/);
  });

  it("l'export applique la même porte ET l'exclusion des annuaires nommés fermés", () => {
    const src = lire("src/app/api/medical/annuaire/export/route.ts");
    expect(src).toMatch(/peutAnnuaire\(user, cle, "VIEW"\)/);
    // L'exclusion passe par la clause PARTAGÉE avec la recherche globale (§118.177) : l'export
    // l'appelle avec l'ouverture « entière » qu'il a lue, et la clause porte l'exclusion — les deux
    // moitiés, sinon une clause vidée de son exclusion passerait par un point d'appel intact.
    expect(src).toMatch(/await clausePraticiensVisibles\(user, \{ entier \}\)/);
    const clause = lire("src/lib/queries/annuaires.ts");
    const corps = clause.slice(clause.indexOf("export async function clausePraticiensVisibles"));
    expect(corps.slice(0, corps.indexOf("\n}\n"))).toMatch(/await clauseAnnuairesFermes\(user\)/);
  });

  it("la conversation sur les établissements pose la même question que l'écran", () => {
    const src = lire("src/lib/assistant/propositions/donnees-et-corbeille.ts"); // ex-`assistant.ts` (lot V4)
    expect(src).toMatch(/peutAnnuaire\(user, "ETABLISSEMENTS", "CREATE"\)/);
    expect(src).toMatch(/peutAnnuaire\(user, "ETABLISSEMENTS", "UPDATE"\)/);
  });

  it("les deux consoles montent les cases d'annuaire, et les deux enregistrements les lisent", () => {
    expect(lire("src/app/(app)/admin/users/[id]/access-matrix.tsx")).toMatch(/<AnnuairesCoches/);
    expect(lire("src/app/(app)/admin/access/module-access-grid.tsx")).toMatch(/<AnnuairesCoches/);
    const actions = lire("src/lib/actions/access-actions.ts");
    expect(actions.match(/annuairesCoches\(module, mode, formData, `sect_/g)?.length).toBe(2);
  });
});
