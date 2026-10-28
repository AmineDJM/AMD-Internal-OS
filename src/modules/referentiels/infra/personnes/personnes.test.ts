import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Hors requête, `cookies()` lève : les portes des fiches jugent sur les droits, pas sur la sélection d'en-tête.
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { reprisesPersonnes } from "../reprises/personnes";
import { repriseDoublonsPersonnes } from "./reprise-doublons";
import { rattacher } from "./rattachement";
import { relierALaPersonne, relierCommeLaLigne } from "./double-ecriture";
import { annulerFusionPersonnes, fusionnerPersonnes } from "./fusion";
import { lireFichePersonne } from "./fiche";
import { canAccessEntity } from "@/lib/entity-access";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA REPRISE R1 « PERSONNES », DE BOUT EN BOUT, CONTRE LA VRAIE BASE (lot V2-B).
 *
 * Le Dr Tadjeddine est un compte, un salarié (relié au compte), un praticien, un bénéficiaire tiré de
 * l'annuaire, un voyageur saisi à la main et un candidat embauché. On prouve :
 *   1. l'aperçu à blanc n'écrit rien ;
 *   2. les liens que l'ERP porte déjà font UNE Personne (compte + salarié + candidat ; praticien + bénéficiaire) ;
 *   3. rejouée, la reprise ne fait plus rien ;
 *   4. le reste (voyageur, praticien ↔ compte) est PROPOSÉ, jamais fusionné ; la fusion est un geste tracé
 *      qui se défait ;
 *   5. la double écriture ne fait rien interrupteur éteint, relie interrupteur allumé ;
 *   6. la fiche 360° ne montre à chacun que ce que l'écran d'origine lui montre.
 *
 * Les lignes du banc ont des identifiants préfixés qui se trient APRÈS tout cuid : le curseur des reprises
 * (`apresId`) les isole des autres lignes de la base de test.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const P = "zzzz__rep__";
/** Les acteurs se trient AVANT le curseur : la reprise des comptes ne les voit pas. */
const A = "zzzz__act__";
const NIN = "109870123456789012";

suite("Personnes — reprise, doublons, fusion, double écriture, fiche", () => {
  const acteurs: Record<string, SessionUser> = {};
  let reglageAvant: boolean | null = null;

  const acteur = async (cle: string, role: string) => {
    const u = await prisma.user.create({ data: { id: `${A}${cle}`, name: `${A}${cle}`, email: `${A}${cle}@t.dz`, role: role as never, passwordHash: "x" } });
    acteurs[cle] = { id: u.id, role, secondaryRole: null, access: await getAccess(u.id, role as never) } as unknown as SessionUser;
  };

  async function nettoyer() {
    const tables = ["recruitmentCandidate", "careBeneficiary", "adProVoyageur", "medicalDoctor", "employee"] as const;
    const personnes = new Set<string>();
    for (const t of tables) {
      const rows = await (prisma[t] as unknown as { findMany(a: object): Promise<{ personneId: string | null }[]> }).findMany({ where: { id: { startsWith: P } }, select: { personneId: true } });
      rows.forEach((r) => r.personneId && personnes.add(r.personneId));
    }
    (await prisma.user.findMany({ where: { id: { startsWith: P } }, select: { personneId: true } })).forEach((r) => r.personneId && personnes.add(r.personneId));
    await prisma.recruitmentCandidate.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.recruitmentRequest.deleteMany({ where: { reference: { startsWith: P } } });
    await prisma.careBeneficiary.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.adProItem.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.congressNational.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.adProVoyageur.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.medicalDoctor.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.employee.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: A } } });
    if (personnes.size) {
      await prisma.personne.updateMany({ where: { id: { in: [...personnes] } }, data: { fusionneeDansId: null } });
      await prisma.personne.deleteMany({ where: { id: { in: [...personnes] } } });
    }
  }

  beforeAll(async () => {
    await nettoyer();
    reglageAvant = (await prisma.appSetting.findUnique({ where: { id: "global" }, select: { refontePersonnesDoubleEcriture: true } }))?.refontePersonnesDoubleEcriture ?? null;
    await acteur("delegueA", "MEDICAL_DELEGATE");
    await acteur("delegueB", "MEDICAL_DELEGATE");
    await acteur("ventes", "HEAD_OF_SALES");
    await acteur("finances", "FINANCE_BUDGET_MANAGER");
    await acteur("sa", "SUPER_ADMIN");

    await prisma.user.create({ data: { id: `${P}u1`, name: "Zoubir Tadjeddine", email: `${P}z.tadjeddine@adventum.dz`, passwordHash: "x" } });
    await prisma.employee.create({ data: { id: `${P}e1`, fullName: "Zoubir TADJEDDINE", userId: `${P}u1`, birthDate: new Date("1979-04-12"), nationalId: NIN, iban: "DZ5900200001234567890123", isActive: true } });
    const demande = await prisma.recruitmentRequest.create({ data: { reference: `${P}REC`, requesterId: acteurs.sa.id, position: "Délégué", contractType: "CDI" } });
    await prisma.recruitmentCandidate.create({ data: { id: `${P}c1`, requestId: demande.id, fullName: "Zoubir Tadjeddine", employeeId: `${P}e1`, status: "HIRED" } });
    await prisma.medicalDoctor.create({ data: { id: `${P}d1`, name: "Dr TADJEDDINE Zoubir", lastName: "TADJEDDINE", firstName: "Zoubir", title: "PROFESSEUR", delegateId: acteurs.delegueB.id } });
    await prisma.congressNational.create({ data: { id: `${P}cn`, name: `${P}Congrès`, requesterId: acteurs.sa.id } });
    await prisma.careBeneficiary.create({ data: { id: `${P}b1`, doctorId: `${P}d1`, congressNationalId: `${P}cn` } });
    await prisma.adProItem.create({ data: { id: `${P}item`, label: "Billetterie congrès", congressNationalId: `${P}cn` } });
    await prisma.adProVoyageur.create({ data: { id: `${P}v1`, itemId: `${P}item`, nom: "TADJEDDINE", prenom: "Zoubir" } });
  });

  afterAll(async () => {
    if (reglageAvant !== null) await prisma.appSetting.update({ where: { id: "global" }, data: { refontePersonnesDoubleEcriture: reglageAvant } });
    await nettoyer();
  });

  const reprise = (cle: string) => reprisesPersonnes.find((r) => r.cle === cle)!;
  const ORDRE = ["personnes-users", "personnes-employes", "personnes-candidats", "personnes-medecins", "personnes-beneficiaires", "personnes-voyageurs"];
  const personneDe = async (t: "user" | "employee" | "recruitmentCandidate" | "medicalDoctor" | "careBeneficiary" | "adProVoyageur", id: string) =>
    ((await (prisma[t] as unknown as { findUnique(a: object): Promise<{ personneId: string | null } | null> }).findUnique({ where: { id: `${P}${id}` }, select: { personneId: true } }))?.personneId) ?? null;

  it("1-2-3. l'aperçu n'écrit rien ; les liens de l'ERP font une Personne ; rejouée, rien ne bouge", async () => {
    const apercus = [];
    for (const cle of ORDRE) apercus.push(await reprise(cle).apercu());
    expect(await personneDe("user", "u1")).toBeNull(); // à blanc : rien d'écrit
    // L'aperçu de NOS lignes (les reprises, elles, courent sur toute la table) annonce ce que l'exécution va faire.
    const creeesABlanc = new Set<string>();
    const prevu = [];
    for (const [source, id] of [["User", "u1"], ["Employee", "e1"], ["RecruitmentCandidate", "c1"], ["MedicalDoctor", "d1"], ["CareBeneficiary", "b1"], ["AdProVoyageur", "v1"]] as const) {
      prevu.push((await rattacher(prisma, source, `${P}${id}`, { aBlanc: true, creeesABlanc }))?.etat);
    }
    expect(prevu).toEqual(["creee", "liee", "liee", "creee", "liee", "creee"]);

    const executions = [];
    for (const cle of ORDRE) executions.push(await reprise(cle).executer({ taille: 50, apresId: P }));
    // Le compte crée ; le salarié et le candidat le rejoignent ; le praticien crée ; le bénéficiaire le rejoint ; le voyageur crée.
    expect(executions.map((b) => [b.creees, b.liees])).toEqual([[1, 0], [0, 1], [0, 1], [1, 0], [0, 1], [1, 0]]);
    expect(executions.every((b) => b.suite === null && b.erreurs.length === 0)).toBe(true);
    expect(apercus.every((a) => a.erreurs.length === 0)).toBe(true);

    const pCompte = await personneDe("user", "u1");
    expect(pCompte).toBeTruthy();
    expect(await personneDe("employee", "e1")).toBe(pCompte);
    expect(await personneDe("recruitmentCandidate", "c1")).toBe(pCompte);
    const pPraticien = await personneDe("medicalDoctor", "d1");
    expect(await personneDe("careBeneficiary", "b1")).toBe(pPraticien);
    expect(pPraticien).not.toBe(pCompte);
    expect(await personneDe("adProVoyageur", "v1")).not.toBe(pPraticien); // aucune fusion par le nom

    const compte = await prisma.personne.findUniqueOrThrow({ where: { id: pCompte! }, include: { roles: true } });
    expect(compte.naissance?.toISOString().slice(0, 10)).toBe("1979-04-12");
    expect(compte.roles.map((r) => r.role).sort()).toEqual(["CANDIDAT", "COLLABORATEUR"]);
    // AUCUNE donnée sensible recopiée sur la Personne.
    expect(JSON.stringify(compte)).not.toContain(NIN);
    expect(JSON.stringify(compte)).not.toContain("DZ59");
    expect((await prisma.personne.findUniqueOrThrow({ where: { id: pPraticien! } })).civilite).toBe("Pr");

    const rejeu = [];
    for (const cle of ORDRE) rejeu.push(await reprise(cle).executer({ taille: 50, apresId: P }));
    expect(rejeu.map((b) => b.creees + b.liees)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(rejeu.map((b) => b.ignorees)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(await prisma.personneRole.count({ where: { personneId: pCompte! } })).toBe(2);
  });

  it("4. les ressemblances sont PROPOSÉES, la fusion est tracée et se défait", async () => {
    const pPraticien = (await personneDe("medicalDoctor", "d1"))!;
    const pVoyageur = (await personneDe("adProVoyageur", "v1"))!;
    expect((await repriseDoublonsPersonnes.apercu()).doublonsProposes).toBeGreaterThanOrEqual(1);
    for (let curseur: string | null = null, i = 0; i < 100; i++) {
      const r = await repriseDoublonsPersonnes.executer({ taille: 500, apresId: curseur });
      curseur = r.suite;
      if (!curseur) break;
    }
    const [a, b] = pPraticien < pVoyageur ? [pPraticien, pVoyageur] : [pVoyageur, pPraticien];
    const prop = await prisma.doublonPersonne.findUniqueOrThrow({ where: { personneAId_personneBId: { personneAId: a, personneBId: b } } });
    expect(prop.statut).toBe("PROPOSE");
    expect(await personneDe("adProVoyageur", "v1")).toBe(pVoyageur); // proposé, PAS fusionné
    expect((await repriseDoublonsPersonnes.apercu()).doublonsProposes).toBe(0); // rejouée : rien de nouveau

    const fusion = await prisma.$transaction((tx) => fusionnerPersonnes(tx, { doublonId: prop.id, gardeeId: pPraticien, parId: acteurs.sa.id }));
    expect(fusion.deplacees).toEqual([`AdProVoyageur:${P}v1`]);
    expect(await personneDe("adProVoyageur", "v1")).toBe(pPraticien);
    expect((await prisma.personne.findUniqueOrThrow({ where: { id: pVoyageur } })).fusionneeDansId).toBe(pPraticien);
    expect((await prisma.personneRole.findMany({ where: { personneId: pPraticien, jusquA: null } })).map((r) => r.role)).toContain("VOYAGEUR");
    // La Personne absorbée renvoie à celle qui l'a absorbée ; la fiche gardée montre le voyage au Super Admin.
    expect((await lireFichePersonne(acteurs.delegueB, pVoyageur)).etat).toBe("FUSIONNEE");
    const vueSa = await lireFichePersonne(acteurs.sa, pPraticien);
    expect(vueSa.etat === "OUVERTE" && vueSa.fiche.voyages.map((v) => v.nature)).toEqual(["VOL"]);

    await prisma.$transaction((tx) => annulerFusionPersonnes(tx, { doublonId: prop.id, parId: acteurs.sa.id }));
    expect(await personneDe("adProVoyageur", "v1")).toBe(pVoyageur);
    expect((await prisma.personne.findUniqueOrThrow({ where: { id: pVoyageur } })).fusionneeDansId).toBeNull();
    expect((await prisma.doublonPersonne.findUniqueOrThrow({ where: { id: prop.id } })).statut).toBe("PROPOSE");
  });

  it("5. la double écriture : rien interrupteur éteint, la Personne interrupteur allumé, dans la transaction de l'écrivain", async () => {
    await prisma.appSetting.upsert({ where: { id: "global" }, create: { id: "global", refontePersonnesDoubleEcriture: false }, update: { refontePersonnesDoubleEcriture: false } });
    await prisma.$transaction(async (tx) => {
      const e = await tx.employee.create({ data: { id: `${P}e2`, fullName: "Nadir Ouslimani" } });
      await relierALaPersonne(tx, "Employee", e.id, null);
    });
    expect(await personneDe("employee", "e2")).toBeNull();

    await prisma.appSetting.update({ where: { id: "global" }, data: { refontePersonnesDoubleEcriture: true } });
    await prisma.$transaction(async (tx) => {
      const e = await tx.employee.create({ data: { id: `${P}e3`, fullName: "Nadir Ouslimani" } });
      await relierALaPersonne(tx, "Employee", e.id, null);
    });
    const p3 = await personneDe("employee", "e3");
    expect(p3).toBeTruthy();
    // La transaction de l'écrivain échoue ⇒ ni ligne, ni Personne.
    await expect(prisma.$transaction(async (tx) => {
      const e = await tx.employee.create({ data: { id: `${P}e4`, fullName: "Nadir Ouslimani" } });
      await relierALaPersonne(tx, "Employee", e.id, null);
      throw new Error("échec de l'écrivain");
    })).rejects.toThrow();
    expect(await prisma.employee.count({ where: { id: `${P}e4` } })).toBe(0);
    // L'embauche d'un candidat déjà relié : la fiche salarié rejoint SA Personne (pas une seconde).
    const demande = await prisma.recruitmentRequest.findFirstOrThrow({ where: { reference: `${P}REC` } });
    await prisma.$transaction(async (tx) => {
      const c = await tx.recruitmentCandidate.create({ data: { id: `${P}c2`, requestId: demande.id, fullName: "Lyna Berrahma" } });
      await relierALaPersonne(tx, "RecruitmentCandidate", c.id, null);
    });
    await prisma.$transaction(async (tx) => {
      const e = await tx.employee.create({ data: { id: `${P}e5`, fullName: "Lyna Berrahma" } });
      await tx.recruitmentCandidate.update({ where: { id: `${P}c2` }, data: { employeeId: e.id, status: "HIRED" } });
      await relierCommeLaLigne(tx, "Employee", e.id, { source: "RecruitmentCandidate", id: `${P}c2` }, null);
    });
    const pCandidate = await personneDe("recruitmentCandidate", "c2");
    expect(pCandidate).toBeTruthy();
    expect(await personneDe("employee", "e5")).toBe(pCandidate);
    expect((await prisma.personneRole.findMany({ where: { personneId: pCandidate! } })).map((r) => r.role).sort()).toEqual(["CANDIDAT", "COLLABORATEUR"]);
    // La reprise passée ensuite retombe sur la même Personne (identifiant déterministe) — et relie la ligne d'avant l'interrupteur.
    expect((await rattacher(prisma, "Employee", `${P}e3`))?.etat).toBe("deja");
    expect((await rattacher(prisma, "Employee", `${P}e2`))?.etat).toBe("creee");
  });

  it("6. la fiche 360° : aucune fuite — chaque ligne derrière la porte de son écran", async () => {
    const pPraticien = (await personneDe("medicalDoctor", "d1"))!;
    const pCompte = (await personneDe("user", "u1"))!;

    // Le praticien d'un autre délégué : la Personne n'existe pas pour lui.
    expect((await lireFichePersonne(acteurs.delegueA, pPraticien)).etat).toBe("ABSENTE");
    const vueB = await lireFichePersonne(acteurs.delegueB, pPraticien);
    expect(vueB.etat).toBe("OUVERTE");
    if (vueB.etat === "OUVERTE") {
      expect(vueB.fiche.fiches.map((f) => f.source)).toEqual(["MedicalDoctor"]);
      // La prise en charge suit la porte de SON congrès — la même fonction que l'écran du congrès —, et son rôle avec elle.
      const congresOuvert = await canAccessEntity(acteurs.delegueB, "CONGRESS_NATIONAL", `${P}cn`, "VIEW");
      expect(vueB.fiche.prisesEnCharge.length).toBe(congresOuvert ? 1 : 0);
      expect(vueB.fiche.roles.sort()).toEqual(congresOuvert ? ["BENEFICIAIRE", "PROFESSIONNEL_SANTE"] : ["PROFESSIONNEL_SANTE"]);
      // Le voyage (une autre Personne tant que personne n'a tranché) n'est pas sur cette fiche.
      expect(vueB.fiche.voyages).toEqual([]);
    }
    const vueSaPraticien = await lireFichePersonne(acteurs.sa, pPraticien);
    expect(vueSaPraticien.etat === "OUVERTE" && vueSaPraticien.fiche.prisesEnCharge.length)
      .toBe(await canAccessEntity(acteurs.sa, "CONGRESS_NATIONAL", `${P}cn`, "VIEW") ? 1 : 0);
    expect(await canAccessEntity(acteurs.sa, "CONGRESS_NATIONAL", `${P}cn`, "VIEW")).toBe(true);

    // L'annuaire interne montre le collègue — pas sa date de naissance, pas sa candidature.
    const vueVentes = await lireFichePersonne(acteurs.ventes, pCompte);
    expect(vueVentes.etat).toBe("OUVERTE");
    if (vueVentes.etat === "OUVERTE") {
      expect(vueVentes.fiche.naissance).toBeNull();
      expect(vueVentes.fiche.roles).toEqual(["COLLABORATEUR"]);
      expect(vueVentes.fiche.fiches.find((f) => f.source === "Employee")?.lien).toBeNull();
      expect(JSON.stringify(vueVentes)).not.toContain(NIN);
    }
    // Le Super Admin voit tout, sauf ce que la fiche ne charge jamais (NIN, IBAN).
    const vueSa = await lireFichePersonne(acteurs.sa, pCompte);
    expect(vueSa.etat).toBe("OUVERTE");
    if (vueSa.etat === "OUVERTE") {
      expect(vueSa.fiche.naissance?.toISOString().slice(0, 10)).toBe("1979-04-12");
      expect(vueSa.fiche.roles.sort()).toEqual(["CANDIDAT", "COLLABORATEUR"]);
      expect(JSON.stringify(vueSa)).not.toContain(NIN);
      expect(JSON.stringify(vueSa)).not.toContain("DZ59");
    }
  });
});
