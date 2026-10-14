import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
// La wilaya devinée par l'IA n'a rien à faire dans ce banc : aucune sortie réelle (§118.86).
vi.mock("@/lib/medical/wilaya-ai", () => ({ inferWilayas: async () => new Map() }));

let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR,
  getUser: async () => ACTEUR,
  requireModule: async () => ACTEUR,
}));

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { getAccess, peutAnnuaire, userCan, type SessionUser } from "@/lib/rbac";
import { updateInstitution, updateDoctor } from "@/lib/actions/medical-actions";
import {
  ajouterServicesEtablissement, renommerServiceEtablissement, supprimerServiceEtablissement,
} from "@/lib/actions/etablissement-services-actions";
import {
  saveDirectoryCell, addDirectoryDoctor, importDirectorySheet, rattacherEtablissementsParNom,
} from "@/lib/actions/medical-directory-actions";
import { chargerFeuillePraticiens, chargerEtablissements } from "@/lib/queries/annuaires";
import { createSector, updateSector, saveRepProfile } from "@/lib/actions/sales-planning-actions";
import { loadPanelPlanifiable } from "@/lib/queries/tour-schedule";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__etabsvc__";
const fd = (o: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) for (const x of v) f.append(k, x);
    else f.set(k, v);
  }
  return f;
};
/** Un vrai classeur, comme celui qu'on téléverse — pas un état injecté (§118.14). */
const classeur = (lignes: string[][]) => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(lignes), "Annuaire");
  const buf = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new File([new Uint8Array(buf)], "annuaire.xlsx");
};

/**
 * ═══════════════════════════════════════════════════════════
 * L'ANNUAIRE DES ÉTABLISSEMENTS ET SES LIENS, PAR LES VRAIS POINTS D'ENTRÉE (§118.172).
 *
 * Décision de la Direction (01/10) : réparer le bouton « rendre actif » ; chaque établissement a
 * ses SERVICES (ajouter, renommer, supprimer) ; la feuille des médecins et des pharmaciens se
 * RATTACHE à cet annuaire pour l'établissement et le service. Et l'import des praticiens, relu à
 * cette occasion, perdait des données et débordait de la portée de la personne.
 *
 * Les acteurs n'ont PAS de vue globale là où la portée est le fait testé (§118.104).
 * ═══════════════════════════════════════════════════════════
 */
suite("Établissements, services et liens des praticiens (§118.172)", () => {
  let kamA = "", kamB = "", patron = "", lecteur = "";
  let chu = "", eph = "", ferme = "", homo1 = "", homo2 = "", beni = "";
  let cardio = "", pneumo = "", svcEph = "";
  let docA = "", docB = "", pharma = "", ancienA = "", ancienB = "", ancienHomo = "", ancienFerme = "";

  const acteur = async (id: string, role: string) =>
    ({ id, role, secondaryRole: null, access: await getAccess(id, role as never) } as unknown as SessionUser);

  /**
   * UNE COURSE JOUÉE, PAS ESPÉRÉE (§118.164e). Un verrou de LIGNE (`FOR UPDATE` sur la seule fiche
   * visée) laisse le geste LIRE et le bloque à l'ÉCRITURE de cette fiche — et de rien d'autre : un
   * verrou de table aurait aussi bloqué les bancs voisins, dont l'attente aurait pu passer pour
   * celle du geste. On lance, on attend qu'il soit BLOQUÉ (vu dans `pg_stat_activity`, rafraîchie à
   * chaque tour — Postgres en fige la vue dans une transaction), on fait `entretemps` dans la
   * transaction qui tient le verrou, puis on relâche. Un échec de barrière dit ce que faisaient les
   * sessions, pour qu'on n'accuse pas le verrou au hasard.
   */
  async function pendantQueLActionAttend<T>(ficheId: string, lancer: () => Promise<T>, entretemps: (tx: Prisma.TransactionClient) => Promise<void>): Promise<T> {
    let geste!: Promise<T>;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "MedicalDoctor" WHERE id = ${ficheId} FOR UPDATE`;
      geste = lancer();
      geste.catch(() => undefined);
      const debut = Date.now();
      for (;;) {
        await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
        const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock' AND query ILIKE '%UPDATE%MedicalDoctor%'`;
        if (n >= 1) break;
        if (Date.now() - debut > 10_000) {
          await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
          const vues = await tx.$queryRaw<{ etat: string | null; attente: string | null; requete: string }[]>`
            SELECT state AS etat, coalesce(wait_event_type, '') || ':' || coalesce(wait_event, '') AS attente, left(query, 90) AS requete
            FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`;
          throw new Error(`le geste n'a pas atteint la barrière — ${JSON.stringify(vues)}`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      await entretemps(tx);
    }, { timeout: 20_000 });
    return geste;
  }

  const nettoyer = async () => {
    await prisma.medicalDoctor.deleteMany({ where: { OR: [{ name: { contains: TAG } }, { lastName: { contains: TAG } }] } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.medicalInstitution.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { summary: { contains: TAG } } }).catch(() => {});
    // Le profil KAM n'a pas de clé étrangère vers son compte : supprimer le compte le laisserait.
    const comptes = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } }).catch(() => []);
    await prisma.salesRepProfile.deleteMany({ where: { repId: { in: comptes.map((c) => c.id) } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  };

  beforeAll(async () => {
    await nettoyer();
    const mk = (s: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role: role as never, passwordHash: "x" } });
    const [a, b, p, l] = await Promise.all([
      mk("kam-a", "MEDICAL_DELEGATE"), mk("kam-b", "MEDICAL_DELEGATE"), mk("patron", "DIRECTION"), mk("lecteur", "VIEWER"),
    ]);
    kamA = a.id; kamB = b.id; patron = p.id; lecteur = l.id;

    const etab = (name: string, extra: Record<string, unknown> = {}) =>
      prisma.medicalInstitution.create({ data: { name, wilaya: "Alger", type: "CHU", ...extra }, select: { id: true } });
    const vague1 = await Promise.all([
      etab(`${TAG}CHU Mustapha`),
      // Un téléphone et des notes : une modification qui EFFACERAIT ce qu'elle ne porte pas ne se
      // verrait pas sur un établissement qui n'en a aucun (§118.117 — un jeu d'essai à un seul terme).
      etab(`${TAG}EPH Rouiba`, { type: "EPH", phone: "023 00 00 02", notes: `${TAG}accès par la rue B` }),
      etab(`${TAG}Clinique Fermée`, { isActive: false }),
      etab(`${TAG}EPH Bordj`, { wilaya: "Bordj Bou Arreridj" }),
      etab(`${TAG}EPH Bordj`, { wilaya: "Bordj Menaïel" }),
      // ACCENTUÉ : c'est la seule différence d'écriture que la casse ne couvre pas, et l'import la
      // rencontre dès qu'un fichier a été saisi sur un clavier sans accents.
      etab(`${TAG}Hôpital Béni Messous`, { type: "EPH" }),
    ]);
    [chu, eph, ferme, homo1, homo2, beni] = vague1.map((r) => r.id);
    const svc = (institutionId: string, name: string) =>
      prisma.medicalInstitutionService.create({ data: { institutionId, name }, select: { id: true } });
    const vague2 = await Promise.all([svc(chu, "Cardiologie"), svc(chu, "Pneumologie"), svc(eph, "Urgences")]);
    [cardio, pneumo, svcEph] = vague2.map((r) => r.id);

    const doc = (name: string, extra: Record<string, unknown>) =>
      prisma.medicalDoctor.create({ data: { name: `${TAG}${name}`, lastName: `${TAG}${name}`, wilaya: "Alger", ...extra }, select: { id: true } });
    const vague3 = await Promise.all([
      doc("Dr A", { delegateId: kamA }),
      doc("Dr B", { delegateId: kamB }),
      doc("Pharma P", { delegateId: kamA, title: "PHARMACIEN", phone: "0550 00 00 01", email: "p@t.dz", potential: "VERY_HIGH" }),
      // LES FICHES D'AVANT LE LIEN : un établissement tapé à la main, sans identifiant.
      doc("Ancien A", { delegateId: kamA, institution: `${TAG}chu mustapha` }),
      doc("Ancien B", { delegateId: kamB, institution: `${TAG}CHU Mustapha` }),
      doc("Ancien Homo", { delegateId: kamA, institution: `${TAG}EPH Bordj` }),
      doc("Ancien Fermé", { delegateId: kamA, institution: `${TAG}Clinique Fermée` }),
    ]);
    [docA, docB, pharma, ancienA, ancienB, ancienHomo, ancienFerme] = vague3.map((r) => r.id);
  });

  afterAll(nettoyer);

  // ── LES PRÉMISSES DES ACTEURS : sans elles, les cas ci-dessous ne prouvent rien. ──
  it("les acteurs sont ce que le banc croit qu'ils sont", async () => {
    const a = await acteur(kamA, "MEDICAL_DELEGATE");
    const l = await acteur(lecteur, "VIEWER");
    const p = await acteur(patron, "DIRECTION");
    expect(peutAnnuaire(a, "ETABLISSEMENTS", "UPDATE")).toBe(true);
    expect(peutAnnuaire(l, "ETABLISSEMENTS", "UPDATE")).toBe(false);
    // Le délégué ne voit QUE ses praticiens : c'est ce qui rend la portée éprouvable.
    expect(a.access.modules.get("MEDICAL")?.scope).not.toBe("ALL");
    expect(p.access.modules.get("MEDICAL")?.scope).toBe("ALL");
    expect(userCan(a, "MEDICAL", "CREATE")).toBe(true);
  });

  describe("le bouton « rendre actif » (§118.172 — le témoin caché qui gagnait toujours)", () => {
    it("désactiver puis réactiver, par le formulaire RÉEL : témoin « off » suivi de la case cochée", async () => {
      ACTEUR = await acteur(patron, "DIRECTION");
      // Case DÉCOCHÉE : seul le témoin part.
      const off = await updateInstitution(fd({ id: eph, isActive: "off" }));
      expect(off.ok).toBe(true);
      expect((await prisma.medicalInstitution.findUnique({ where: { id: eph } }))?.isActive).toBe(false);
      // Case COCHÉE : le témoin PUIS la case — `formData.get` rendait le premier, « off », et la
      // réactivation était impossible depuis l'écran.
      const on = await updateInstitution(fd({ id: eph, isActive: ["off", "on"] }));
      expect(on.ok).toBe(true);
      expect((await prisma.medicalInstitution.findUnique({ where: { id: eph } }))?.isActive).toBe(true);
    });

    it("une modification qui ne porte QUE l'état ne touche à rien d'autre", async () => {
      ACTEUR = await acteur(patron, "DIRECTION");
      const avant = await prisma.medicalInstitution.findUniqueOrThrow({ where: { id: eph } });
      await updateInstitution(fd({ id: eph, isActive: "off" }));
      const apres = await prisma.medicalInstitution.findUniqueOrThrow({ where: { id: eph } });
      expect(apres.name).toBe(avant.name);
      expect(apres.type).toBe(avant.type);
      expect(apres.wilaya).toBe(avant.wilaya);
      // La prémisse d'abord : sans téléphone ni notes au départ, leur effacement passerait inaperçu.
      expect([avant.phone, avant.notes]).toEqual(["023 00 00 02", `${TAG}accès par la rue B`]);
      expect([apres.phone, apres.notes]).toEqual([avant.phone, avant.notes]);
      expect(apres.isActive).toBe(false);
      await updateInstitution(fd({ id: eph, isActive: "on" }));
    });

    it("un formulaire qui ne dit RIEN de l'état ne le change pas", async () => {
      ACTEUR = await acteur(patron, "DIRECTION");
      await updateInstitution(fd({ id: ferme, notes: `${TAG}note` }));
      expect((await prisma.medicalInstitution.findUnique({ where: { id: ferme } }))?.isActive).toBe(false);
    });

    it("un nom vidé est refusé, et rien n'est écrit", async () => {
      ACTEUR = await acteur(patron, "DIRECTION");
      const r = await updateInstitution(fd({ id: chu, name: "   " }));
      expect(r.ok).toBe(false);
      expect((await prisma.medicalInstitution.findUnique({ where: { id: chu } }))?.name).toBe(`${TAG}CHU Mustapha`);
    });
  });

  describe("les services d'un établissement", () => {
    it("une liste collée s'ajoute d'un coup ; les répétitions sont DITES, pas recréées", async () => {
      ACTEUR = await acteur(kamA, "MEDICAL_DELEGATE");
      const r = await ajouterServicesEtablissement(fd({ institutionId: eph, noms: "Néphrologie, Pédiatrie ; Gériatrie\nnéphrologie" }));
      expect(r.ok).toBe(true);
      expect(r.message).toContain("3 service(s) ajouté(s)");
      expect(r.message).toContain("Répété");
      const noms = (await prisma.medicalInstitutionService.findMany({ where: { institutionId: eph }, select: { name: true } })).map((s) => s.name).sort();
      expect(noms).toEqual(["Gériatrie", "Néphrologie", "Pédiatrie", "Urgences"]);
    });

    it("ce qui existe déjà — sans égard à la casse ni aux accents — n'est pas recréé", async () => {
      ACTEUR = await acteur(kamA, "MEDICAL_DELEGATE");
      const r = await ajouterServicesEtablissement(fd({ institutionId: eph, noms: "PEDIATRIE, urgences, Oncologie" }));
      expect(r.ok).toBe(true);
      expect(r.message).toContain("1 service(s) ajouté(s)");
      expect(r.message).toContain("Déjà présent(s) : Pédiatrie, Urgences");
      expect(await prisma.medicalInstitutionService.count({ where: { institutionId: eph } })).toBe(5);
    });

    it("renommer en un homonyme est refusé ; renommer sinon garde les praticiens rattachés", async () => {
      ACTEUR = await acteur(patron, "DIRECTION");
      await prisma.medicalDoctor.update({ where: { id: docA }, data: { institutionId: chu, institution: `${TAG}CHU Mustapha`, serviceId: pneumo } });
      const homo = await renommerServiceEtablissement(fd({ id: pneumo, name: "cardiologie" }));
      expect(homo.ok).toBe(false);
      expect(homo.error).toContain("Cardiologie");
      const ok = await renommerServiceEtablissement(fd({ id: pneumo, name: "Pneumo-phtisiologie" }));
      expect(ok.ok).toBe(true);
      const d = await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: docA }, include: { serviceRef: true } });
      expect(d.serviceRef?.name).toBe("Pneumo-phtisiologie");
    });

    it("supprimer un service garde le praticien dans son établissement, sans service — et le dit", async () => {
      ACTEUR = await acteur(patron, "DIRECTION");
      const r = await supprimerServiceEtablissement(fd({ id: pneumo }));
      expect(r.ok).toBe(true);
      expect(r.message).toContain("1 praticien(s) restent rattachés à l'établissement, sans service");
      const d = await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: docA } });
      expect(d.serviceId).toBeNull();
      expect(d.institutionId).toBe(chu);
    });

    it("qui ne peut pas modifier l'annuaire ne touche à aucun service", async () => {
      ACTEUR = await acteur(lecteur, "VIEWER");
      expect((await ajouterServicesEtablissement(fd({ institutionId: eph, noms: "Interdit" }))).ok).toBe(false);
      expect((await renommerServiceEtablissement(fd({ id: svcEph, name: "Interdit" }))).ok).toBe(false);
      expect((await supprimerServiceEtablissement(fd({ id: svcEph }))).ok).toBe(false);
      expect(await prisma.medicalInstitutionService.count({ where: { id: svcEph } })).toBe(1);
    });

    it("le chargeur de l'écran rend chaque service avec ce qu'il porte", async () => {
      const f = await chargerEtablissements(await acteur(patron, "DIRECTION"), {});
      const ligne = f.rows.find((r) => r.id === chu)!;
      expect(ligne.services.map((s) => s.name)).toEqual(["Cardiologie"]);
      const lEph = f.rows.find((r) => r.id === eph)!;
      expect(lEph.services.map((s) => s.name)).toEqual(["Gériatrie", "Néphrologie", "Oncologie", "Pédiatrie", "Urgences"]);
    });
  });

  describe("la feuille des praticiens se RATTACHE à l'annuaire des établissements", () => {
    it("choisir un établissement pose le lien ET le nom ; choisir un service exige le sien", async () => {
      ACTEUR = await acteur(kamA, "MEDICAL_DELEGATE");
      expect((await saveDirectoryCell({ id: docA, field: "institution", value: eph })).ok).toBe(true);
      let d = await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: docA } });
      expect(d.institutionId).toBe(eph);
      expect(d.institution).toBe(`${TAG}EPH Rouiba`);
      // Le service d'un AUTRE établissement est refusé — une requête forgée ignore un menu.
      const autre = await saveDirectoryCell({ id: docA, field: "service", value: cardio });
      expect(autre.ok).toBe(false);
      expect(autre.error).toContain("n'appartient pas");
      expect((await saveDirectoryCell({ id: docA, field: "service", value: svcEph })).ok).toBe(true);
      d = await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: docA } });
      expect(d.serviceId).toBe(svcEph);
    });

    it("changer d'établissement RETIRE le service ; le vider retire tout", async () => {
      ACTEUR = await acteur(kamA, "MEDICAL_DELEGATE");
      expect((await saveDirectoryCell({ id: docA, field: "institution", value: chu })).ok).toBe(true);
      let d = await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: docA } });
      expect(d.institutionId).toBe(chu);
      expect(d.serviceId).toBeNull();
      expect((await saveDirectoryCell({ id: docA, field: "institution", value: "" })).ok).toBe(true);
      d = await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: docA } });
      expect([d.institutionId, d.institution, d.serviceId]).toEqual([null, null, null]);
    });

    it("pas de service sans établissement ; pas de rattachement à un établissement désactivé", async () => {
      ACTEUR = await acteur(kamA, "MEDICAL_DELEGATE");
      const sans = await saveDirectoryCell({ id: docA, field: "service", value: cardio });
      expect(sans.ok).toBe(false);
      expect(sans.error).toContain("d'abord l'établissement");
      const fermeR = await saveDirectoryCell({ id: docA, field: "institution", value: ferme });
      expect(fermeR.ok).toBe(false);
      expect(fermeR.error).toContain("désactivé");
      expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: docA } })).institutionId).toBeNull();
    });

    it("un délégué ne rattache pas le praticien d'un AUTRE délégué", async () => {
      ACTEUR = await acteur(kamA, "MEDICAL_DELEGATE");
      const r = await saveDirectoryCell({ id: docB, field: "institution", value: chu });
      expect(r.ok).toBe(false);
      expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: docB } })).institutionId).toBeNull();
    });

    it("l'ajout d'une ligne choisit l'établissement et son service dès la création", async () => {
      ACTEUR = await acteur(kamA, "MEDICAL_DELEGATE");
      const r = await addDirectoryDoctor({ lastName: `${TAG}Nouveau`, firstName: "N", specialty: "", wilaya: "", institutionId: chu, serviceId: cardio });
      expect(r.ok).toBe(true);
      const d = await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: r.id! } });
      expect([d.institutionId, d.institution, d.serviceId, d.delegateId]).toEqual([chu, `${TAG}CHU Mustapha`, cardio, kamA]);
      const faux = await addDirectoryDoctor({ lastName: `${TAG}Faux`, firstName: "", specialty: "", wilaya: "", institutionId: eph, serviceId: cardio });
      expect(faux.ok).toBe(false);
      expect(await prisma.medicalDoctor.count({ where: { lastName: `${TAG}Faux` } })).toBe(0);
    });

    it("la ligne de la feuille montre le NOM rattaché, et une fiche d'avant se dit « à rattacher »", async () => {
      const feuille = await chargerFeuillePraticiens(await acteur(patron, "DIRECTION"), { canManage: false });
      const nouveau = feuille!.rows.find((r) => r.lastName === `${TAG}Nouveau`)!;
      expect([nouveau.institution, nouveau.service]).toEqual([`${TAG}CHU Mustapha`, "Cardiologie"]);
      const ancien = feuille!.rows.find((r) => r.id === ancienA)!;
      expect([ancien.institutionId, ancien.institution]).toEqual([null, `${TAG}chu mustapha`]);
      // Les options de la feuille : l'annuaire entier, avec les services de chacun.
      const opt = feuille!.etablissements.find((e) => e.id === chu)!;
      expect(opt.services.map((s) => s.name)).toEqual(["Cardiologie"]);
    });

    it("une modification de fiche qui ne cite pas l'établissement le GARDE (le chemin d'Adam le perdait)", async () => {
      ACTEUR = await acteur(patron, "DIRECTION");
      await prisma.medicalDoctor.update({ where: { id: docA }, data: { institutionId: chu, institution: `${TAG}CHU Mustapha`, serviceId: cardio } });
      const r = await updateDoctor(fd({ id: docA, name: `${TAG}Dr A`, phone: "0661 00 00 00", institution: `${TAG}CHU Mustapha` }));
      expect(r.ok).toBe(true);
      const d = await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: docA } });
      expect([d.institutionId, d.serviceId, d.phone]).toEqual([chu, cardio, "0661 00 00 00"]);
      // Et un établissement NOMMÉ autrement change vraiment le lien — sinon « établissement
      // modifié » serait une phrase sans effet.
      const r2 = await updateDoctor(fd({ id: docA, name: `${TAG}Dr A`, institution: `${TAG}EPH Rouiba` }));
      expect(r2.ok).toBe(true);
      const d2 = await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: docA } });
      expect([d2.institutionId, d2.institution, d2.serviceId]).toEqual([eph, `${TAG}EPH Rouiba`, null]);
    });
  });

  describe("rattacher en lot les fiches d'avant le lien — à coup sûr, et dans la portée", () => {
    it("rattache le nom qui désigne UN établissement actif ; laisse et NOMME les autres", async () => {
      ACTEUR = await acteur(kamA, "MEDICAL_DELEGATE");
      const r = await rattacherEtablissementsParNom({ ids: [ancienA, ancienB, ancienHomo, ancienFerme] });
      expect(r.ok).toBe(true);
      // ancienA (casse différente) → rattaché ; ancienB est à un AUTRE délégué → hors portée.
      expect(r.rattachees).toBe(1);
      expect(r.message).toContain("hors de votre portée");
      expect(r.message).toContain("plusieurs établissements de ce nom");
      expect(r.message).toContain("établissement désactivé");
      const a = await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: ancienA } });
      expect([a.institutionId, a.institution]).toEqual([chu, `${TAG}CHU Mustapha`]);
      const [b, h, f] = await Promise.all([ancienB, ancienHomo, ancienFerme].map((id) => prisma.medicalDoctor.findUniqueOrThrow({ where: { id } })));
      expect([b.institutionId, h.institutionId, f.institutionId]).toEqual([null, null, null]);
      // Rien n'a été choisi entre deux homonymes : le texte est intact.
      expect(h.institution).toBe(`${TAG}EPH Bordj`);
    });

    it("une fiche déjà rattachée entre-temps garde son choix", async () => {
      ACTEUR = await acteur(patron, "DIRECTION");
      await prisma.medicalDoctor.update({ where: { id: ancienB }, data: { institutionId: eph } });
      const r = await rattacherEtablissementsParNom({ ids: [ancienB] });
      expect(r.ok).toBe(true);
      expect(r.rattachees).toBe(0);
      expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: ancienB } })).institutionId).toBe(eph);
    });

    // LE PRÉFILTRE (`institutionId: null` à la LECTURE) a son propre témoin : une fiche déjà rattachée
    // n'est plus « à rattacher », et le message ne doit pas la nommer comme telle — même quand le texte
    // qu'elle garde ne désigne personne. Sans lui, la prise conditionnelle empêcherait encore
    // l'écriture, mais le message ferait chercher un rattachement qui est déjà fait.
    it("une fiche déjà rattachée n'est ni recomptée ni nommée « à rattacher »", async () => {
      ACTEUR = await acteur(patron, "DIRECTION");
      await prisma.medicalDoctor.update({ where: { id: ancienHomo }, data: { institutionId: homo1 } });
      try {
        const r = await rattacherEtablissementsParNom({ ids: [ancienHomo] });
        expect(r.ok).toBe(true);
        expect(r.rattachees).toBe(0);
        expect(r.message).not.toContain("à rattacher à la main");
        expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: ancienHomo } })).institutionId).toBe(homo1);
      } finally {
        await prisma.medicalDoctor.update({ where: { id: ancienHomo }, data: { institutionId: null } });
      }
    });

    // LA PRISE CONDITIONNELLE (`institutionId: null` à l'ÉCRITURE) ne se voit que dans une COURSE :
    // la fiche est libre quand l'action la LIT, et quelqu'un la rattache AVANT qu'elle l'écrive. Le
    // cas précédent ne l'atteint pas — le préfiltre l'arrête avant. La course est JOUÉE, pas espérée
    // (§118.164e) : un verrou sur la fiche laisse l'action la lire et la bloque à l'écriture ; pendant
    // qu'elle attend, une autre écriture rattache la fiche ailleurs ; puis on relâche.
    it("la course : rattachée PENDANT le rattachement en lot, la fiche garde le choix fait entre-temps", async () => {
      ACTEUR = await acteur(patron, "DIRECTION");
      await prisma.medicalDoctor.update({ where: { id: ancienB }, data: { institutionId: null } });
      const r = await pendantQueLActionAttend(
        ancienB,
        () => rattacherEtablissementsParNom({ ids: [ancienB] }),
        (tx) => tx.medicalDoctor.update({ where: { id: ancienB }, data: { institutionId: eph } }).then(() => undefined),
      );
      expect(r.ok).toBe(true);
      expect(r.rattachees, "la fiche avait été rattachée pendant l'attente : rien à compter").toBe(0);
      expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: ancienB } })).institutionId).toBe(eph);
    });
  });

  describe("l'import des praticiens — ce qu'il rattache, ce qu'il n'écrase plus, ce qu'il ne touche pas", () => {
    it("un fichier de trois colonnes ne remet PAS le grade, le potentiel, l'e-mail ni le délégué à zéro", async () => {
      ACTEUR = await acteur(patron, "DIRECTION");
      // Le pharmacien n'a pas d'établissement : un fichier SANS colonne d'établissement le retrouve par son nom.
      const r = await importDirectorySheet(fd({ file: classeur([["Nom complet", "Téléphone"], [`${TAG}Pharma P`, "0770 99 99 99"]]) as unknown as string }));
      expect(r.ok, r.error).toBe(true);
      expect(r.message).toContain("1 mise(s) à jour");
      const p = await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: pharma } });
      // Le défaut d'avant : grade « Autre » (il quittait l'annuaire des pharmaciens), potentiel
      // « Moyen », e-mail effacé, délégué retiré — sur un fichier qui ne parlait que du téléphone.
      expect(p.title).toBe("PHARMACIEN");
      expect(p.potential).toBe("VERY_HIGH");
      expect(p.email).toBe("p@t.dz");
      expect(p.delegateId).toBe(kamA);
      expect(p.phone).toBe("0770 99 99 99");
      expect(await prisma.medicalDoctor.count({ where: { name: `${TAG}Pharma P` } })).toBe(1);
    });

    it("un fichier sans colonne d'établissement ne crée pas de doublon d'un praticien hospitalier", async () => {
      ACTEUR = await acteur(patron, "DIRECTION");
      const r = await importDirectorySheet(fd({ file: classeur([["Nom complet", "Mail"], [`${TAG}Dr A`, "a@t.dz"]]) as unknown as string }));
      expect(r.ok, r.error).toBe(true);
      expect(await prisma.medicalDoctor.count({ where: { name: `${TAG}Dr A` } })).toBe(1);
      expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: docA } })).email).toBe("a@t.dz");
    });

    it("deux fiches du même nom sans établissement pour les distinguer : la ligne est écartée et DITE", async () => {
      ACTEUR = await acteur(patron, "DIRECTION");
      await prisma.medicalDoctor.create({ data: { name: `${TAG}Homonyme`, institution: "X" } });
      await prisma.medicalDoctor.create({ data: { name: `${TAG}Homonyme`, institution: "Y" } });
      const r = await importDirectorySheet(fd({ file: classeur([["Nom complet", "Mail"], [`${TAG}Homonyme`, "h@t.dz"]]) as unknown as string }));
      expect(r.ok, r.error).toBe(true);
      expect(r.message).toContain("plusieurs fiches portent ce nom");
      expect(await prisma.medicalDoctor.count({ where: { name: `${TAG}Homonyme` } })).toBe(2);
      expect(await prisma.medicalDoctor.count({ where: { name: `${TAG}Homonyme`, email: "h@t.dz" } })).toBe(0);
    });

    it("un délégué n'écrase pas la fiche d'un collègue, et POSSÈDE ce qu'il crée", async () => {
      ACTEUR = await acteur(kamA, "MEDICAL_DELEGATE");
      const r = await importDirectorySheet(fd({ file: classeur([
        ["Nom complet", "Téléphone", "Délégué"],
        [`${TAG}Dr B`, "0000", `${TAG}kam-b`],
        [`${TAG}Importé par A`, "1111", `${TAG}kam-b`],
      ]) as unknown as string }));
      expect(r.ok, r.error).toBe(true);
      expect(r.message).toContain("hors de votre portée");
      expect(r.message).toContain("colonne « Délégué » non appliquée");
      const b = await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: docB } });
      expect(b.phone).not.toBe("0000");
      expect(await prisma.medicalDoctor.count({ where: { name: `${TAG}Dr B` } })).toBe(1);
      // Le défaut d'avant : la fiche créée n'appartenait à personne, donc pas à lui — la feuille
      // ne la lui montrait pas. Et la colonne « Délégué » l'aurait donnée à un collègue.
      const cree = await prisma.medicalDoctor.findFirstOrThrow({ where: { name: `${TAG}Importé par A` } });
      expect(cree.delegateId).toBe(kamA);
      const feuille = await chargerFeuillePraticiens(await acteur(kamA, "MEDICAL_DELEGATE"), { canManage: false });
      expect(feuille!.rows.some((x) => x.id === cree.id)).toBe(true);
    });

    it("établissement et service se RATTACHENT à l'import ; l'inconnu reste « à rattacher », et rien n'est créé", async () => {
      ACTEUR = await acteur(patron, "DIRECTION");
      const r = await importDirectorySheet(fd({ file: classeur([
        ["Nom", "Prénom", "Établissement", "Service", "Spécialité"],
        [`${TAG}Imp1`, "Un", `${TAG}chu mustapha`, "cardiologie", "Cardiologie"],
        [`${TAG}Imp2`, "Deux", `${TAG}Hôpital Inconnu`, "Urgences", ""],
        [`${TAG}Imp3`, "Trois", `${TAG}EPH Rouiba`, "Radiologie", ""],
      ]) as unknown as string }));
      expect(r.ok, r.error).toBe(true);
      expect(r.message).toContain("2 rattachée(s) à l'annuaire des établissements");
      expect(r.message).toContain("absent de l'annuaire");
      expect(r.message).toContain(`${TAG}EPH Rouiba › Radiologie`);
      const [i1, i2, i3] = await Promise.all([`${TAG}Imp1`, `${TAG}Imp2`, `${TAG}Imp3`].map((n) => prisma.medicalDoctor.findFirstOrThrow({ where: { lastName: n } })));
      expect([i1.institutionId, i1.institution, i1.serviceId]).toEqual([chu, `${TAG}CHU Mustapha`, cardio]);
      expect([i2.institutionId, i2.institution, i2.serviceId]).toEqual([null, `${TAG}Hôpital Inconnu`, null]);
      expect([i3.institutionId, i3.serviceId]).toEqual([eph, null]);
      // Un service que l'établissement n'a pas n'est JAMAIS créé depuis un fichier.
      expect(await prisma.medicalInstitutionService.count({ where: { institutionId: eph, name: "Radiologie" } })).toBe(0);
    });

    it("le même fichier réimporté avec un nom d'établissement écrit autrement ne crée pas de jumeau", async () => {
      ACTEUR = await acteur(patron, "DIRECTION");
      const r = await importDirectorySheet(fd({ file: classeur([
        ["Nom", "Prénom", "Établissement"],
        [`${TAG}Imp1`, "Un", `${TAG}CHU  MUSTAPHA`],
      ]) as unknown as string }));
      expect(r.ok, r.error).toBe(true);
      expect(r.message).toContain("0 fiche(s) créée(s)");
      expect(await prisma.medicalDoctor.count({ where: { lastName: `${TAG}Imp1` } })).toBe(1);

      // LES ACCENTS — la seule différence que la casse et les espaces ne couvrent pas. Un fichier
      // saisi sans accents doit retrouver la fiche rattachée à « Hôpital Béni Messous ».
      const premier = await importDirectorySheet(fd({ file: classeur([
        ["Nom", "Prénom", "Établissement"],
        [`${TAG}Imp5`, "Cinq", `${TAG}Hôpital Béni Messous`],
      ]) as unknown as string }));
      expect(premier.ok, premier.error).toBe(true);
      expect((await prisma.medicalDoctor.findFirstOrThrow({ where: { lastName: `${TAG}Imp5` } })).institutionId).toBe(beni);
      const sansAccents = await importDirectorySheet(fd({ file: classeur([
        ["Nom", "Prénom", "Établissement"],
        [`${TAG}Imp5`, "Cinq", `${TAG}HOPITAL BENI MESSOUS`],
      ]) as unknown as string }));
      expect(sansAccents.ok, sansAccents.error).toBe(true);
      expect(sansAccents.message).toContain("0 fiche(s) créée(s)");
      expect(await prisma.medicalDoctor.count({ where: { lastName: `${TAG}Imp5` } })).toBe(1);
    });

    it("un fichier qui n'a QUE la colonne « Service » remplit aussi la spécialité, comme avant", async () => {
      ACTEUR = await acteur(patron, "DIRECTION");
      const r = await importDirectorySheet(fd({ file: classeur([
        ["Nom", "Prénom", "Service"],
        [`${TAG}Imp4`, "Quatre", "Néphrologie"],
      ]) as unknown as string }));
      expect(r.ok, r.error).toBe(true);
      const i4 = await prisma.medicalDoctor.findFirstOrThrow({ where: { lastName: `${TAG}Imp4` } });
      expect(i4.specialty).toBe("Néphrologie");
      // Sans établissement, le service ne se rattache à rien — et c'est dit.
      expect(i4.serviceId).toBeNull();
      expect(r.message).toContain("Néphrologie");
    });
  });
  describe("le découpage d'une BU : des établissements, avec tous leurs services ou certains", () => {
    let bu = "", secteur = "", panCardio = "", panSansService = "", panEph = "";

    beforeAll(async () => {
      const b = await prisma.businessUnit.create({ data: { name: `${TAG}BU Onco` }, select: { id: true } });
      bu = b.id;
      // Le KAM qu'on affecte au secteur est un KAM de cette BU — l'écran ne propose que ceux-là (§118.184 — S15).
      await prisma.salesRepProfile.upsert({ where: { repId: kamA }, create: { repId: kamA, businessUnitId: bu }, update: { businessUnitId: bu } });
      // Trois praticiens du panel à venir : un en cardiologie au CHU, un au CHU SANS service, un à l'EPH.
      const mk = (name: string, institutionId: string, serviceId: string | null) =>
        prisma.medicalDoctor.create({ data: { name: `${TAG}${name}`, institutionId, serviceId }, select: { id: true } });
      const v = await Promise.all([mk("Pan Cardio", chu, cardio), mk("Pan Sans Service", chu, null), mk("Pan EPH", eph, null)]);
      [panCardio, panSansService, panEph] = v.map((x) => x.id);
    });

    it("la prémisse : la Direction configure les secteurs", async () => {
      expect(userCan(await acteur(patron, "DIRECTION"), "SALES_PLANNING", "UPDATE")).toBe(true);
    });

    it("un secteur couvre le CHU pour la seule Cardiologie, et l'EPH en entier", async () => {
      ACTEUR = await acteur(patron, "DIRECTION");
      const r = await createSector(fd({
        businessUnitId: bu, name: `${TAG}Est`, city: "Alger", institutionIds: [chu, eph], repIds: [kamA],
        couverture: JSON.stringify({ [chu]: [cardio] }),
      }));
      expect(r.ok, r.error).toBe(true);
      secteur = r.id!;
      const liens = await prisma.salesSectorInstitution.findMany({
        where: { sectorId: secteur }, select: { institutionId: true, tousLesServices: true, services: { select: { serviceId: true } } },
      });
      const parEtab = new Map(liens.map((l) => [l.institutionId, l]));
      expect(parEtab.get(chu)?.tousLesServices).toBe(false);
      expect(parEtab.get(chu)?.services.map((x) => x.serviceId)).toEqual([cardio]);
      expect(parEtab.get(eph)?.tousLesServices).toBe(true);
    });

    it("le panel du KAM suit la couverture : le service choisi, l'établissement entier — jamais le praticien sans service d'un hôpital restreint", async () => {
      const panel = await loadPanelPlanifiable(kamA);
      const ids = new Set(panel.map((p) => p.id));
      expect(ids.has(panCardio)).toBe(true);
      expect(ids.has(panEph)).toBe(true);
      // On ne devine pas le service d'un praticien qui n'en a pas (§118.34).
      expect(ids.has(panSansService)).toBe(false);
      expect(panel.find((p) => p.id === panCardio)?.secteur).toBe(`${TAG}Est`);
    });

    it("un enregistrement qui ne dit RIEN de la couverture la garde (l'op d'Adam, un renommage)", async () => {
      ACTEUR = await acteur(patron, "DIRECTION");
      await prisma.salesSector.update({ where: { id: secteur }, data: { color: "#ff0000" } });
      const r = await updateSector(fd({ id: secteur, name: `${TAG}Est-Algérois`, institutionIds: [chu, eph], repIds: [kamA] }));
      expect(r.ok, r.error).toBe(true);
      const lien = await prisma.salesSectorInstitution.findFirstOrThrow({ where: { sectorId: secteur, institutionId: chu }, include: { services: true } });
      expect(lien.tousLesServices).toBe(false);
      expect(lien.services.map((x) => x.serviceId)).toEqual([cardio]);
      // La couleur et l'état que le formulaire ne porte pas ne changent pas.
      const sec = await prisma.salesSector.findUniqueOrThrow({ where: { id: secteur } });
      expect(sec.color).toBe("#ff0000");
      expect(sec.isActive).toBe(true);
    });

    it("« aucun service » est refusé en nommant l'établissement ; un service d'un autre hôpital aussi", async () => {
      ACTEUR = await acteur(patron, "DIRECTION");
      const vide = await updateSector(fd({ id: secteur, name: `${TAG}Est-Algérois`, institutionIds: [chu], couverture: JSON.stringify({ [chu]: [] }) }));
      expect(vide.ok).toBe(false);
      expect(vide.error).toContain(`${TAG}CHU Mustapha`);
      const autre = await updateSector(fd({ id: secteur, name: `${TAG}Est-Algérois`, institutionIds: [chu], couverture: JSON.stringify({ [chu]: [svcEph] }) }));
      expect(autre.ok).toBe(false);
      expect(autre.error).toContain("n'appartient pas");
      // Rien n'a bougé : l'EPH est toujours dans le secteur.
      expect(await prisma.salesSectorInstitution.count({ where: { sectorId: secteur } })).toBe(2);
    });

    it("rendre « tous les services » au CHU retire la restriction — et le panel s'élargit en conséquence", async () => {
      ACTEUR = await acteur(patron, "DIRECTION");
      const r = await updateSector(fd({ id: secteur, name: `${TAG}Est-Algérois`, institutionIds: [chu, eph], repIds: [kamA], couverture: "{}" }));
      expect(r.ok, r.error).toBe(true);
      const lien = await prisma.salesSectorInstitution.findFirstOrThrow({ where: { sectorId: secteur, institutionId: chu }, include: { services: true } });
      expect(lien.tousLesServices).toBe(true);
      expect(lien.services).toHaveLength(0);
      expect((await loadPanelPlanifiable(kamA)).some((p) => p.id === panSansService)).toBe(true);
    });

    it("rattacher à nouveau un KAM ne remet PAS sa capacité, son ETP ni sa note à zéro", async () => {
      ACTEUR = await acteur(patron, "DIRECTION");
      const config = { region: "Est", capDaysPerMonth: 15, capVisitsPerDay: 7, capFieldPct: 80, fteBudget: 0.8, seniority: "senior", note: "à suivre", isActive: true };
      // Un KAM retiré de sa BU garde son profil (« Retirer de la BU » ne pose que la BU à vide).
      await prisma.salesRepProfile.upsert({ where: { repId: kamB }, create: { repId: kamB, businessUnitId: null, ...config }, update: { businessUnitId: null, ...config } });
      // « Rattacher un KAM » : ce formulaire n'envoie que le KAM et la BU.
      const r = await saveRepProfile(fd({ repId: kamB, businessUnitId: bu }));
      expect(r.ok, r.error).toBe(true);
      let p = await prisma.salesRepProfile.findUniqueOrThrow({ where: { repId: kamB } });
      expect([p.businessUnitId, p.region, p.capDaysPerMonth, p.capVisitsPerDay, p.capFieldPct, Number(p.fteBudget), p.seniority, p.note, p.isActive])
        .toEqual([bu, "Est", 15, 7, 80, 0.8, "senior", "à suivre", true]);
      // La ligne d'un KAM envoie tout SAUF la note : corriger une capacité ne l'efface plus.
      const r2 = await saveRepProfile(fd({
        repId: kamB, businessUnitId: bu, region: "Est", capDaysPerMonth: "12", capVisitsPerDay: "7", capFieldPct: "80",
        fteBudget: "0.8", seniority: "senior", isActive: "off",
      }));
      expect(r2.ok, r2.error).toBe(true);
      p = await prisma.salesRepProfile.findUniqueOrThrow({ where: { repId: kamB } });
      expect([p.capDaysPerMonth, p.note, p.isActive]).toEqual([12, "à suivre", false]);
      // Un champ que le formulaire PORTE, vide, revient à la valeur globale — c'est ce qu'il dit.
      const r3 = await saveRepProfile(fd({ repId: kamB, capDaysPerMonth: "", isActive: "on" }));
      expect(r3.ok, r3.error).toBe(true);
      p = await prisma.salesRepProfile.findUniqueOrThrow({ where: { repId: kamB } });
      expect([p.capDaysPerMonth, p.isActive, p.businessUnitId, p.note]).toEqual([null, true, bu, "à suivre"]);
    });

    it("un secteur restreint dont le dernier service disparaît ne s'élargit JAMAIS tout seul", async () => {
      ACTEUR = await acteur(patron, "DIRECTION");
      const svc = await prisma.medicalInstitutionService.create({ data: { institutionId: chu, name: "Éphémère" }, select: { id: true } });
      await updateSector(fd({ id: secteur, name: `${TAG}Est-Algérois`, institutionIds: [chu], repIds: [kamA], couverture: JSON.stringify({ [chu]: [svc.id] }) }));
      await supprimerServiceEtablissement(fd({ id: svc.id }));
      const lien = await prisma.salesSectorInstitution.findFirstOrThrow({ where: { sectorId: secteur, institutionId: chu }, include: { services: true } });
      expect([lien.tousLesServices, lien.services.length]).toEqual([false, 0]);
      const panel = await loadPanelPlanifiable(kamA);
      expect(panel.some((p) => p.id === panCardio || p.id === panSansService)).toBe(false);
    });
  });
});
