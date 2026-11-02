import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT S1 — LA FUITE DU 02/11 (décision 0048), REJOUÉE CONTRE LA VRAIE BASE.
 *
 * La Direction (Amine, Super Admin) ouvre le compte de Radia (non Super Admin) en « Vue exacte » :
 *   — accueil « Bonjour Radia » (un RENDU : la vue y est honorée) ;
 *   — « Salut » → « Salut Amine ! » ; « Quel est mon salaire ? » → « Aucune fiche RH n'est rattachée à votre compte » ;
 *   — « Quel est le salaire de radia ? » / « et de assia ? » → les montants.
 * Cause : le message part par une ACTION SERVEUR, dont le corps porte le Super Admin RÉEL (`visualise` = Radia,
 * §118.184) — le tour se jouait avec l'identité, la mémoire et les droits d'Amine (qui n'a pas de fiche RH).
 *
 * Ce banc tient :
 *   1. Vue exacte : l'action refuse, `jouerTour` refuse (Super Admin avec `visualise`, ou identité vue avec
 *      `impersonatedBy`) — AUCUN appel de modèle ; la confirmation d'une carte aussi.
 *   2. Connexion RÉELLE de Radia : la consigne nomme Radia (jamais Amine) ; « mon salaire » rend le sien (fiche liée) ;
 *      celui d'Assia est refusé, même famille « Salaires & paie » ouverte À SON RÔLE par la console.
 *   3. Sans fiche liée : « mon salaire » est refusé — le lien manquant n'ouvre jamais plus.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => undefined }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", async (original) => ({ ...(await original<typeof import("@/lib/session")>()), requireUser: async () => ACTEUR, getCurrentUser: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { remplacerLecteurInterrupteurIaPourTests } from "@/lib/ai-settings";
import { remplacerModelesPourTests } from "./infra/generer";
import { remplacerReglagesPourTests } from "./infra/consommation";
import { modeleFactice } from "./infra/testing/modele-factice";
import { effacerJournalDe } from "./infra/testing/journal";
import { jouerTour } from "./infra/fil/tour";
import { enVueExacteIa, refusAssistantVueExacte } from "./domaine/acces-regles";
import { confirmerActionBeta, envoyerMessageBeta } from "@/app/(app)/assistant/beta/actions";
import { contratEnVigueur, fonctionEnVigueur, perimetreEnVigueur, perimetreQuiCouvre, perimetresDesAvenants, type AvenantLu } from "./domaine/perimetres";
import { estFamilleIa, resoudreAccesIa, FAMILLES_IA, type FamilleIa } from "./domaine/acces-regles";
import { accesAssistantIa } from "./infra/role-config";
import { outilsV1 } from "./infra/outils-v1";
import { accueilPour, prenomDe, sectionProfil } from "./domaine/profil-personne";
import { oublierProfil, profilDeLaPersonne } from "./infra/profil-personne";
import { apercuAssistantDe, enregistrerAvenantIa, accorderDroitDateIa } from "./actions-consommation";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__s1_${Date.now().toString(36)}_`;
const reponse = (message: string) => ({ texte: JSON.stringify({ message, components: [] }) });
const chiffres = (s: string) => s.replace(/[\s  ]/g, "");

describe("la règle pure de la Vue exacte", () => {
  it("une identité vue, ou un Super Admin qui visualise : l'assistant ne joue pas", () => {
    expect(enVueExacteIa({})).toBe(false);
    expect(enVueExacteIa({ visualise: { id: "r", name: "Radia" } })).toBe(true);
    expect(enVueExacteIa({ impersonatedBy: { id: "a", name: "Amine" } })).toBe(true);
    expect(refusAssistantVueExacte("Radia KEBIR")).toContain("Radia KEBIR");
    expect(refusAssistantVueExacte(null)).toContain("Vue exacte");
  });
});

describe("les périmètres sensibles (pur)", () => {
  const J = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
  const av = (o: Partial<AvenantLu>): AvenantLu => ({ id: "a", objet: "DELEGATION", fonction: null, famille: "SALAIRES", companyId: "P", effetLe: J(-1), finLe: J(30), motif: "m", revoqueLe: null, ...o });
  const tous = Object.fromEntries(FAMILLES_IA.map((f) => [f, true])) as Record<FamilleIa, boolean>;

  it("en vigueur : de la date d'effet au jour de fin compris", () => {
    expect(perimetreEnVigueur({ du: J(-1), au: null })).toBe(true);
    expect(perimetreEnVigueur({ du: J(2), au: null })).toBe(false);
    expect(perimetreEnVigueur({ du: J(-10), au: J(-2) })).toBe(false);
    expect(perimetreEnVigueur({ du: J(-10), au: new Date().toISOString().slice(0, 10) })).toBe(true);
  });

  it("un avenant de délégation ouvre SA famille sur SON entité, en vigueur, contrat valide — rien d'autre", () => {
    const p = perimetresDesAvenants([av({})], true, estFamilleIa);
    expect(perimetreQuiCouvre(p, "SALAIRES", "P")).not.toBeNull();
    expect(perimetreQuiCouvre(p, "SALAIRES", "A")).toBeNull();
    expect(perimetreQuiCouvre(p, "SALAIRES", null)).toBeNull();
    expect(perimetreQuiCouvre(p, "CONTRATS_RH", "P")).toBeNull();
    expect(perimetresDesAvenants([av({})], false, estFamilleIa)).toEqual([]);
    expect(perimetresDesAvenants([av({ companyId: null })], true, estFamilleIa)).toEqual([]);
    expect(perimetresDesAvenants([av({ revoqueLe: J(-1) })], true, estFamilleIa)).toEqual([]);
    expect(perimetresDesAvenants([av({ effetLe: J(3) })], true, estFamilleIa)).toEqual([]);
    expect(perimetresDesAvenants([av({ famille: "INCONNUE" })], true, estFamilleIa)).toEqual([]);
  });

  it("le contrat fait foi : échu ou fiche inactive, plus rien ; la fonction suit le dernier avenant de fonction", () => {
    expect(contratEnVigueur(null)).toBe(false);
    expect(contratEnVigueur({ isActive: true, contractEnd: null })).toBe(true);
    expect(contratEnVigueur({ isActive: true, contractEnd: J(-3) })).toBe(false);
    expect(contratEnVigueur({ isActive: false, contractEnd: null })).toBe(false);
    expect(fonctionEnVigueur("Assistante", [])).toEqual({ fonction: "Assistante", origine: "CONTRAT", ref: null });
    expect(fonctionEnVigueur("Assistante", [av({ id: "f", objet: "FONCTION", fonction: "Responsable paie" })]).fonction).toBe("Responsable paie");
  });

  it("un réglage de rôle ou de personne SANS date n'ouvre jamais autrui ; une fermeture nominative prime sur l'avenant", () => {
    const perimetres = perimetresDesAvenants([av({})], true, estFamilleIa);
    const sansPerimetre = resoudreAccesIa({ superAdmin: false, droits: tous, role: { ouvertes: ["SALAIRES"], fermees: [] }, personne: { ouvertes: ["SALAIRES"], fermees: [] } });
    expect(sansPerimetre.ouvertes).toContain("SALAIRES");
    expect(sansPerimetre.perimetres).toEqual([]);
    const avecAvenant = resoudreAccesIa({ superAdmin: false, droits: tous, perimetres });
    expect(avecAvenant.ouvertes).toContain("SALAIRES");
    const ferme = resoudreAccesIa({ superAdmin: false, droits: tous, perimetres, personne: { ouvertes: [], fermees: ["SALAIRES"] } });
    expect(ferme.ouvertes).not.toContain("SALAIRES");
    expect(ferme.perimetres).toEqual([]);
  });
});

describe("le profil de la personne (pur)", () => {
  it("le prénom : le mot qui n'est pas un NOM en capitales", () => {
    expect(prenomDe("Radia KEBIR")).toBe("Radia");
    expect(prenomDe("KEBIR Radia")).toBe("Radia");
    expect(prenomDe("Assia")).toBe("Assia");
    expect(prenomDe("")).toBe("");
  });
  it("l'accueil suit l'adresse choisie", () => {
    expect(accueilPour("Radia", "TU")).toMatch(/^Bonjour Radia 👋[\s\S]*ton assistant/);
    expect(accueilPour("Radia", "VOUS")).toMatch(/votre assistant/);
  });
  it("la section dit à qui il parle, interdit un autre prénom, et dit l'absence de fiche sans rien ouvrir", () => {
    const t = sectionProfil({ userId: "u", nom: "Radia KEBIR", prenom: "Radia", adresse: "VOUS", role: "Assistante de Direction", roleSecondaire: null, fiche: null, famillesOuvertes: [], perimetres: [] });
    expect(t).toContain("Tu parles à : Radia KEBIR");
    expect(t).toContain("JAMAIS par un autre prénom");
    expect(t).toContain("AUCUNE n'est liée");
    expect(t).toContain("AUCUN périmètre nominatif");
  });
});

suite("S1 — le scénario du 02/11 contre la base", () => {
  let amine: CurrentUser;
  let radia: CurrentUser;
  let sansFiche: CurrentUser;
  let assia: CurrentUser;
  const cleAvant = process.env.OPENAI_API_KEY;

  const session = async (role: string, nom: string, assistantIa = false): Promise<CurrentUser> => {
    const u = await prisma.user.create({ data: { name: `${nom} ${TAG}`, email: `${TAG}${nom.toLowerCase()}@t.dz`, passwordHash: "x", role: role as never } });
    if (assistantIa) await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
    const access = await getAccess(u.id, u.role);
    return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
  };

  beforeAll(async () => {
    process.env.OPENAI_API_KEY = "cle-de-banc";
    remplacerLecteurInterrupteurIaPourTests(async () => false);
    remplacerReglagesPourTests({ valeursSensibles: "EN_CLAIR" });
    amine = await session("SUPER_ADMIN", "Amine", true);
    radia = await session("COORDINATOR", "Radia", true);
    sansFiche = await session("COORDINATOR", "Nadia", true);
    assia = await session("MEDICAL_DELEGATE", "Assia");
    await prisma.employee.create({ data: { fullName: `Radia ${TAG}KEBIR`, userId: radia.id, position: "Assistante de direction", baseSalary: 105180, grossSalary: 180673, netToPay: 110000 } });
    await prisma.employee.create({ data: { fullName: `Assia ${TAG}ABDELAZIZ`, userId: assia.id, position: "Pharmacienne", baseSalary: 350000, netToPay: 400000, iban: "DZ5900400174401234567890" } });
  });
  afterEach(() => { remplacerModelesPourTests(null); ACTEUR = null; });
  afterAll(async () => {
    if (cleAvant === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = cleAvant;
    remplacerLecteurInterrupteurIaPourTests(null);
    remplacerReglagesPourTests(null);
    const ids = [amine, radia, sansFiche, assia].filter(Boolean).map((u) => u.id);
    await prisma.assistantIaAcces.deleteMany({ where: { OR: [{ userId: { in: ids } }, { role: "COORDINATOR", updatedById: TAG }] } }).catch(() => {});
    await prisma.accesDonneeSensible.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await effacerJournalDe(ids);
    await prisma.assistantActionIntent.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { contains: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("VUE EXACTE — l'action du message (corps = Super Admin réel + `visualise`) refuse, sans appeler le modèle", async () => {
    const f = modeleFactice([reponse("Salut Amine ! Comment puis-je vous aider ?")]);
    remplacerModelesPourTests([f.modele as never]);
    ACTEUR = { ...amine, visualise: { id: radia.id, name: radia.name } };
    for (const q of ["Salut", "Quel est mon salaire ?", "Quel est le salaire de radia ?", "et de assia ?"]) {
      const r = await envoyerMessageBeta(q, undefined, []);
      expect(r.ok, q).toBe(false);
      expect(r.error).toContain("Vue exacte");
      expect(r.content).toBe("");
    }
    expect(f.promptsRecus).toHaveLength(0);
  });

  it("VUE EXACTE — `jouerTour` lui-même refuse, quelle que soit la forme de l'identité (échec fermé)", async () => {
    const f = modeleFactice([reponse("ne doit pas répondre")]);
    remplacerModelesPourTests([f.modele as never]);
    const corpsAction = await jouerTour({ ...amine, visualise: { id: radia.id, name: radia.name } }, { texte: "Salut", pieces: [], historique: [] });
    const rendu = await jouerTour({ ...radia, impersonatedBy: { id: amine.id, name: amine.name } }, { texte: "Salut", pieces: [], historique: [] });
    expect(corpsAction.ok).toBe(false);
    expect(rendu.ok).toBe(false);
    expect(f.promptsRecus).toHaveLength(0);
  });

  it("VUE EXACTE — une carte ne se confirme pas non plus", async () => {
    ACTEUR = { ...amine, visualise: { id: radia.id, name: radia.name } };
    const r = await confirmerActionBeta("intention-quelconque");
    expect(r.ok).toBe(false);
  });

  it("RADIA, connexion réelle — la consigne nomme Radia, jamais Amine ; « mon salaire » rend le sien", async () => {
    const f = modeleFactice([
      { appel: { outil: "lire_paie", entree: { nom: "moi" } } },
      (prompt) => reponse(chiffres(prompt).includes("110000") ? "Votre net est de 110 000 DZD." : "Je n'ai pas la valeur."),
    ]);
    remplacerModelesPourTests([f.modele as never]);
    ACTEUR = radia;
    const r = await envoyerMessageBeta("Quel est mon salaire ?", undefined, []);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("110 000 DZD");
    const recu = JSON.stringify(f.promptsRecus);
    expect(recu).toContain(`Radia ${TAG}`);
    expect(recu).not.toContain("Amine");
  });

  it("RADIA, connexion réelle — le salaire d'Assia est REFUSÉ ; aucun de ses montants n'atteint le modèle", async () => {
    const f = modeleFactice([
      { appel: { outil: "lire_paie", entree: { nom: `Assia ${TAG}ABDELAZIZ` } } },
      reponse("Je ne peux pas vous donner le salaire d'Assia."),
    ]);
    remplacerModelesPourTests([f.modele as never]);
    const r = await jouerTour(radia, { texte: `et de assia ${TAG}ABDELAZIZ ?`, pieces: [], historique: [] });
    expect(r.ok).toBe(true);
    const recu = chiffres(JSON.stringify(f.promptsRecus));
    expect(recu).not.toMatch(/400000|350000|DZ5900400174401234567890/);
  });

  it("RADIA — même la famille « Salaires & paie » ouverte à SON RÔLE (réglage large) n'ouvre pas la paie d'autrui", async () => {
    await prisma.assistantIaAcces.upsert({
      where: { role: "COORDINATOR" },
      create: { role: "COORDINATOR", ouvertes: ["SALAIRES", "CONTRATS_RH", "FICHES"], updatedById: TAG },
      update: { ouvertes: ["SALAIRES", "CONTRATS_RH", "FICHES"], updatedById: TAG },
    });
    try {
      const f = modeleFactice([
        { appel: { outil: "lire_paie", entree: { nom: `Assia ${TAG}ABDELAZIZ` } } },
        reponse("Refusé."),
      ]);
      remplacerModelesPourTests([f.modele as never]);
      const r = await jouerTour(radia, { texte: `Quel est le salaire d'Assia ${TAG}ABDELAZIZ ?`, pieces: [], historique: [] });
      expect(r.ok).toBe(true);
      expect(chiffres(JSON.stringify(f.promptsRecus))).not.toMatch(/400000|350000/);
    } finally {
      await prisma.assistantIaAcces.deleteMany({ where: { role: "COORDINATOR", updatedById: TAG } });
    }
  });

  it("SANS FICHE LIÉE — « mon salaire » est refusé : le lien manquant n'ouvre jamais plus", async () => {
    const f = modeleFactice([
      { appel: { outil: "lire_paie", entree: { nom: "moi" } } },
      (prompt) => reponse(/110000|400000/.test(chiffres(prompt)) ? "FUITE" : "Aucune fiche RH n'est rattachée à votre compte."),
    ]);
    remplacerModelesPourTests([f.modele as never]);
    const r = await jouerTour(sansFiche, { texte: "Quel est mon salaire ?", pieces: [], historique: [] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).not.toContain("FUITE");
  });
  describe("délégations datées (avenant, console)", () => {
    let entiteP = "";
    let entiteA = "";
    let ficheRadia = "";
    const KARIM = `Karim ${TAG}MANSOURI`;
    const ASSIA = `Assia ${TAG}ABDELAZIZ`;
    const lirePaieDe = async (nom: string) => {
      const f = modeleFactice([{ appel: { outil: "lire_paie", entree: { nom } } }, reponse("ok")]);
      remplacerModelesPourTests([f.modele as never]);
      const r = await jouerTour(radia, { texte: `Quel est le salaire de ${nom} ?`, pieces: [], historique: [] });
      expect(r.ok).toBe(true);
      return chiffres(JSON.stringify(f.promptsRecus));
    };
    beforeAll(async () => {
      entiteP = (await prisma.company.create({ data: { name: `Pharmagène ${TAG}` } })).id;
      entiteA = (await prisma.company.create({ data: { name: `Adventum ${TAG}` } })).id;
      ficheRadia = (await prisma.employee.findFirstOrThrow({ where: { userId: radia.id } })).id;
      await prisma.employee.updateMany({ where: { userId: assia.id }, data: { companyId: entiteA } });
      await prisma.employee.create({ data: { fullName: KARIM, companyId: entiteP, baseSalary: 222222, netToPay: 177777 } });
    });
    afterEach(async () => {
      await prisma.avenantContrat.deleteMany({ where: { employeeId: ficheRadia } });
      await prisma.assistantIaDroitDate.deleteMany({ where: { userId: radia.id } });
      await prisma.assistantIaAcces.deleteMany({ where: { userId: radia.id } });
      await prisma.employee.update({ where: { id: ficheRadia }, data: { contractEnd: null, isActive: true } });
    });
    afterAll(async () => {
      await prisma.employee.deleteMany({ where: { fullName: KARIM } });
      await prisma.employee.updateMany({ where: { userId: assia.id }, data: { companyId: null } });
      await prisma.company.deleteMany({ where: { id: { in: [entiteP, entiteA] } } });
    });
    const J = (n: number) => new Date(Date.now() + n * 86_400_000);
    const deleguer = (o: Record<string, unknown> = {}) => prisma.avenantContrat.create({
      data: { employeeId: ficheRadia, objet: "DELEGATION", famille: "SALAIRES", companyId: entiteP, effetLe: J(-1), finLe: J(30), motif: `Intérim paie Pharmagène ${TAG}`, ...o },
    });

    it("un réglage NOMINATIF sans date (ancienne console) n'ouvre plus la paie d'autrui", async () => {
      await prisma.assistantIaAcces.create({ data: { userId: radia.id, ouvertes: ["SALAIRES"] } });
      expect(await lirePaieDe(KARIM)).not.toMatch(/222222|177777/);
    });

    it("un avenant de DÉLÉGATION de la paie de Pharmagène : Karim (Pharmagène) oui, Assia (Adventum) jamais ; audité avec le motif", async () => {
      const a = await deleguer();
      expect(await lirePaieDe(KARIM)).toMatch(/222222|177777/);
      expect(await lirePaieDe(ASSIA)).not.toMatch(/400000|350000/);
      const audit = await prisma.auditLog.findMany({ where: { actorId: radia.id, summary: { contains: a.id } } });
      expect(audit.length).toBeGreaterThan(0);
      expect(audit[0]!.summary).toContain("Intérim paie Pharmagène");
    });

    it("avant sa date d'effet, après sa fin, révoqué, ou contrat échu : l'avenant ne vaut pas", async () => {
      for (const o of [{ effetLe: J(2) }, { effetLe: J(-30), finLe: J(-2) }, { revoqueLe: J(-1) }]) {
        await deleguer(o);
        expect(await lirePaieDe(KARIM), JSON.stringify(o)).not.toMatch(/222222|177777/);
        await prisma.avenantContrat.deleteMany({ where: { employeeId: ficheRadia } });
      }
      await deleguer();
      await prisma.employee.update({ where: { id: ficheRadia }, data: { contractEnd: J(-5) } });
      expect(await lirePaieDe(KARIM)).not.toMatch(/222222|177777/);
    });

    it("un droit DATÉ de la console, nommément : ouvert dans ses dates, fermé révoqué", async () => {
      const d = await prisma.assistantIaDroitDate.create({ data: { userId: radia.id, famille: "SALAIRES", companyId: entiteP, du: J(-1), au: J(10), motif: `Audit paie ${TAG}` } });
      expect((await accesAssistantIa(radia)).perimetres?.map((p) => p.origine)).toEqual(["CONSOLE"]);
      expect(await lirePaieDe(KARIM)).toMatch(/222222|177777/);
      await prisma.assistantIaDroitDate.update({ where: { id: d.id }, data: { revoqueLe: new Date() } });
      expect(await lirePaieDe(KARIM)).not.toMatch(/222222|177777/);
    });

    it("D1 — « Fiches collaborateurs » ouverte au rôle n'offre pas l'extraction du registre complet (directory_list)", async () => {
      await prisma.assistantIaAcces.upsert({
        where: { role: "COORDINATOR" },
        create: { role: "COORDINATOR", ouvertes: ["FICHES"], updatedById: TAG },
        update: { ouvertes: ["FICHES"], updatedById: TAG },
      });
      try {
        const acces = await accesAssistantIa(radia);
        const liste = outilsV1(radia, [], [], [], null, acces).find((o) => o.def.name === "directory_list");
        expect(liste?.allowed(radia) ?? false).toBe(false);
      } finally {
        await prisma.assistantIaAcces.deleteMany({ where: { role: "COORDINATOR", updatedById: TAG } });
      }
    });
  });
  describe("le profil construit par le serveur, la console", () => {
    afterEach(async () => {
      await prisma.assistantIaPreference.deleteMany({ where: { userId: radia.id } });
      const fiche = await prisma.employee.findFirst({ where: { userId: radia.id } });
      if (fiche) await prisma.avenantContrat.deleteMany({ where: { employeeId: fiche.id } });
      oublierProfil(radia.id);
    });

    it("la consigne du tour porte SON profil (poste, contrat, avenant de fonction) — et jamais le prénom d'un autre", async () => {
      const fiche = await prisma.employee.findFirstOrThrow({ where: { userId: radia.id } });
      await prisma.avenantContrat.create({ data: { employeeId: fiche.id, objet: "FONCTION", fonction: "Office manager", effetLe: new Date(Date.now() - 86_400_000), motif: `Avenant n°2 ${TAG}` } });
      await prisma.assistantIaPreference.create({ data: { userId: radia.id, adresse: "TU" } });
      oublierProfil(radia.id);
      const f = modeleFactice([reponse("Salut Radia !")]);
      remplacerModelesPourTests([f.modele as never]);
      const r = await jouerTour(radia, { texte: "Salut", pieces: [], historique: [{ role: "assistant", content: "Salut Amine !" }] });
      expect(r.ok).toBe(true);
      const systeme = JSON.stringify(f.promptsRecus[0]);
      expect(systeme).toContain(`Tu parles à : Radia ${TAG}`);
      expect(systeme).toContain("prénom « Radia »");
      expect(systeme).toContain("Office manager (par avenant)");
      expect(systeme).toContain("tutoiement");
      expect(systeme).not.toMatch(/Tu parles à : Amine/);
    });

    it("le profil ne vient que de SA fiche : celle d'Assia n'y entre jamais", async () => {
      const { profil, section } = await profilDeLaPersonne(radia, await accesAssistantIa(radia));
      expect(profil.userId).toBe(radia.id);
      expect(section).not.toContain("ABDELAZIZ");
      expect(section).not.toContain("Pharmacienne");
    });

    it("« Ce que son assistant voit » : Super Admin seul ; le calcul est celui du moteur", async () => {
      ACTEUR = radia;
      expect((await apercuAssistantDe(assia.id)).ok).toBe(false);
      ACTEUR = { ...amine, visualise: { id: radia.id, name: radia.name } };
      expect((await apercuAssistantDe(radia.id)).ok).toBe(false);
      ACTEUR = amine;
      const r = await apercuAssistantDe(radia.id);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.apercu.consigne).toContain(`Tu parles à : Radia ${TAG}`);
        expect(r.apercu.profil.famillesOuvertes).not.toContain("SALAIRES");
      }
    });

    it("la console refuse une délégation sans entité, un droit sans motif ; accorde un droit daté nommément", async () => {
      ACTEUR = amine;
      const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
      expect((await enregistrerAvenantIa(fd({ userId: radia.id, objet: "DELEGATION", famille: "SALAIRES", effetLe: "2026-11-01", motif: "Intérim" }))).ok).toBe(false);
      expect((await accorderDroitDateIa(fd({ userId: radia.id, famille: "SALAIRES", du: "2026-11-01", motif: "" }))).ok).toBe(false);
      expect((await accorderDroitDateIa(fd({ userId: radia.id, famille: "BUDGETS", du: "2026-11-01", motif: "Audit annuel" }))).ok).toBe(false);
      expect((await accorderDroitDateIa(fd({ userId: amine.id, famille: "SALAIRES", du: "2026-11-01", motif: "Audit annuel" }))).ok).toBe(false);
      expect((await accorderDroitDateIa(fd({ userId: radia.id, famille: "SALAIRES", du: "2026-11-01", au: "2026-11-30", motif: `Audit annuel ${TAG}` }))).ok).toBe(true);
      ACTEUR = radia;
      expect((await accorderDroitDateIa(fd({ userId: radia.id, famille: "SALAIRES", du: "2026-11-01", motif: "Je m'ouvre tout" }))).ok).toBe(false);
      await prisma.assistantIaDroitDate.deleteMany({ where: { userId: radia.id } });
    });
  });
});
