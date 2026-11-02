import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccess, peutPiloterMissionsAdam, peutUtiliserAssistantIA, peutVoirAdam } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { ADAM_TABS, MODULE_LABELS, NAVIGATION, WORKSPACE_TABS, versEcranAdam } from "@/lib/labels";
import { navigationFor } from "@/lib/nav-access";
import { proposerTravail } from "@/lib/missions/travaux/service";
import { centreDeMissions, vueGlobaleDesMissions } from "@/lib/missions/view/control";
import { proprietaireDeMission, vueMission } from "@/lib/missions/view/workspace";
import { mesMissions, PERSONA_ASSISTANT_IA } from "./api";
import { accueilPour, presentationAdam, sectionProfil, identiteDuModele } from "./domaine/profil-personne";
import { profilDeLaPersonne } from "./infra/profil-personne";
import { accesAssistantIa } from "./infra/role-config";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT A1 — « UN SEUL ASSISTANT : ADAM » (Direction, 02/11/2026), CONTRE LA BASE LOCALE, sans Prisma simulé.
 *
 *   1. LE NOM : « Adam » au menu, dans la console des accès (libellé du module `ASSISTANT_IA`, clé inchangée), dans
 *      l'accueil et la consigne du modèle (« Je suis Adam, l'assistant de <prénom> », le prénom venant du COMPTE).
 *   2. LE MENU : un employé à qui Adam est ouvert voit « Adam » et « Missions d'Adam », jamais « My Chief of Staff » ;
 *      un employé sans Adam ne voit ni l'un ni l'autre ; le Super Admin voit Adam et ses missions, et plus le Chief of
 *      Staff (mis de côté pour tous). Les onglets de l'ex-Chief of Staff sont au Super Admin SEUL.
 *   3. LES MISSIONS : chacun lit SES missions — jamais celle d'un collègue (liste, fiche, travaux de l'assistant) ; le
 *      Super Admin a EN PLUS la vue globale, propriétaire nommé.
 *   4. « MISSIONS TERRAIN » : l'onglet des missions d'équipe de Mon espace est renommé, adresse et module inchangés.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const TAG = `__a1adam_${Date.now()}_`;

async function personne(nom: string, role: UserRole, adam = false): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${nom} ${TAG}`, email: `${TAG}${nom.toLowerCase()}@t.dz`, passwordHash: "x", role } });
  if (adam) await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

async function confier(u: CurrentUser, titre: string): Promise<string> {
  const plan = { titre, objectif: `Objectif : ${titre}`, etapes: [{ cle: "e0", type: "LIVRABLE", titre: "Note", consigne: "Une phrase.", format: "md" }] };
  const r = await proposerTravail(u.id, PERSONA_ASSISTANT_IA, plan, { origine: "banc-a1" });
  if (!r.ok) throw new Error(r.fautes.join(" "));
  return r.travailId;
}

const destinations = (menu: { href: string; tabs?: { href: string }[] }[]) => menu.map((n) => n.href);

let sa: CurrentUser;
let amina: CurrentUser; // déléguée médicale, Adam ouvert
let bilal: CurrentUser; // délégué médical, Adam ouvert
let chafia: CurrentUser; // déléguée médicale, SANS Adam
let missionAmina = "";
let missionBilal = "";
let executionBilal = "";

beforeAll(async () => {
  sa = await personne("Samir", "SUPER_ADMIN");
  amina = await personne("Amina", "MEDICAL_DELEGATE", true);
  bilal = await personne("Bilal", "MEDICAL_DELEGATE", true);
  chafia = await personne("Chafia", "MEDICAL_DELEGATE");
  missionAmina = await confier(amina, `${TAG} Synthèse des visites d'Amina`);
  missionBilal = await confier(bilal, `${TAG} Synthèse des visites de Bilal`);
  // Une mission d'EXÉCUTION (table Mission, kind RUNTIME) à Bilal : la liste d'exécution d'Amina ne doit pas la montrer.
  executionBilal = (await prisma.mission.create({
    data: { ownerId: bilal.id, title: `${TAG} Exécution de Bilal`, objective: "banc A1", kind: "RUNTIME", status: "PAUSED" },
    select: { id: true },
  })).id;
}, 60_000);

afterAll(async () => {
  await prisma.mission.deleteMany({ where: { owner: { email: { startsWith: TAG } } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
});

describe("1 · le NOM — « Adam » partout, la clé de module et les droits inchangés", () => {
  it("le menu et la console nomment Adam ; la clé reste ASSISTANT_IA", () => {
    const entree = NAVIGATION.find((n) => n.href === "/assistant");
    expect(entree?.module).toBe("ASSISTANT_IA");
    expect(entree?.label).toBe("Adam");
    expect(MODULE_LABELS.ASSISTANT_IA).toBe("Adam");
  });

  it("l'accueil et la consigne : « Je suis Adam, l'assistant de <prénom> » — le prénom vient du COMPTE", async () => {
    expect(presentationAdam("Amina")).toBe("Je suis Adam, l'assistant d'Amina");
    expect(presentationAdam("Radia")).toBe("Je suis Adam, l'assistant de Radia");
    expect(accueilPour("Amina", "VOUS")).toContain("Je suis Adam, l'assistant d'Amina.");
    expect(identiteDuModele()).toContain("Tu t'appelles « Adam »");
    // Le profil construit par le SERVEUR, à partir du compte en base — la section que le modèle reçoit.
    const { profil, section } = await profilDeLaPersonne(amina, await accesAssistantIa(amina));
    expect(profil.prenom).toBe("Amina");
    expect(section).toContain("Ta présentation : « Je suis Adam, l'assistant d'Amina ».");
    expect(sectionProfil(profil)).toContain("Je suis Adam, l'assistant d'Amina");
  });

  it("les accès restent ceux d'aujourd'hui, personne par personne", () => {
    expect(peutUtiliserAssistantIA(amina)).toBe(true);
    expect(peutUtiliserAssistantIA(chafia)).toBe(false);
    expect(peutVoirAdam(amina), "avoir Adam n'ouvre pas les capacités du Super Admin").toBe(false);
    expect(peutVoirAdam(sa)).toBe(true);
  });
});

describe("2 · le MENU — réel, calculé par `navigationFor` sur la base", () => {
  it("un employé à qui Adam est ouvert : « Adam » et « Missions d'Adam », jamais « My Chief of Staff »", async () => {
    const menu = await navigationFor(amina);
    const d = destinations(menu);
    expect(menu.find((n) => n.href === "/assistant")?.label).toBe("Adam");
    expect(menu.find((n) => n.href === "/centre-de-missions")?.label).toBe("Missions d'Adam");
    expect(d).not.toContain("/chief-of-staff");
    expect(menu.map((n) => n.label)).not.toContain("My Chief of Staff");
  });

  it("un employé sans Adam : ni Adam, ni ses missions — rien ne s'ouvre par le renommage", async () => {
    const d = destinations(await navigationFor(chafia));
    expect(d).not.toContain("/assistant");
    expect(d).not.toContain("/centre-de-missions");
    expect(d).not.toContain("/chief-of-staff");
  });

  it("le Super Admin : Adam et ses missions ; « My Chief of Staff » quitte son menu aussi (mis de côté, pas supprimé)", async () => {
    const d = destinations(await navigationFor(sa));
    expect(d).toEqual(expect.arrayContaining(["/assistant", "/centre-de-missions"]));
    expect(d).not.toContain("/chief-of-staff");
    expect(NAVIGATION.find((n) => n.href === "/chief-of-staff")?.module, "la clé reste au catalogue").toBe("CHIEF_OF_STAFF");
  });

  it("les onglets de l'ex-Chief of Staff : la règle qui les affiche ne s'ouvre qu'au Super Admin", () => {
    expect(ADAM_TABS.map((t) => t.label)).toEqual(["Conversation", "Boîte de réception", "Réglages d'Adam", "Bureau d'Adam"]);
    expect(peutVoirAdam(sa)).toBe(true);
    for (const u of [amina, bilal, chafia]) expect(peutVoirAdam(u), u.name).toBe(false);
  });

  it("/chief-of-staff mène à l'écran d'Adam — paramètres compris (retour Google, question, référence)", () => {
    expect(versEcranAdam("bureau", {})).toBe("/assistant");
    expect(versEcranAdam("bureau", { q: "Où en est Sofradis ?" })).toBe("/adam/bureau?q=O%C3%B9+en+est+Sofradis+%3F");
    expect(versEcranAdam("bureau", { ref: "REG-12", call: "1" })).toBe("/adam/bureau?ref=REG-12&call=1");
    expect(versEcranAdam("boite", {})).toBe("/adam/boite");
    expect(versEcranAdam("reglages", { connecte: "1" })).toBe("/adam/reglages?connecte=1");
  });
});

describe("3 · les MISSIONS — chacun les siennes, le Super Admin en plus la vue globale", () => {
  it("Amina lit SA mission confiée à Adam, avec son état réel — jamais celle de Bilal", async () => {
    const lues = (await mesMissions(amina.id, { toutes: true })).missions;
    expect(lues.map((m) => m.id)).toContain(missionAmina);
    expect(lues.map((m) => m.id)).not.toContain(missionBilal);
    const m = lues.find((x) => x.id === missionAmina)!;
    expect(m.etat).toBe("A_APPROUVER");
    expect(m.libelle.length).toBeGreaterThan(0);
  });

  it("… et réciproquement pour Bilal", async () => {
    const ids = (await mesMissions(bilal.id, { toutes: true })).missions.map((m) => m.id);
    expect(ids).toContain(missionBilal);
    expect(ids).not.toContain(missionAmina);
  });

  it("la liste d'exécution et la FICHE d'une mission sont filtrées par le propriétaire : la mission de Bilal n'existe pas pour Amina", async () => {
    const centre = await centreDeMissions(amina.id);
    expect([...centre.vivantes, ...centre.closes].map((l) => l.id)).not.toContain(executionBilal);
    expect(await vueMission(executionBilal, amina.id)).toBeNull();
    expect(await vueMission(missionBilal, amina.id)).toBeNull();
    // Le propriétaire, lui, la lit.
    expect(await vueMission(executionBilal, bilal.id)).not.toBeNull();
    expect((await centreDeMissions(bilal.id)).vivantes.map((l) => l.id)).toContain(executionBilal);
  });

  it("un employé n'a pas la règle du Super Admin : la fiche d'autrui ne se résout pas pour lui", () => {
    // La page `/missions/<id>` ne résout le propriétaire d'une autre personne que sous ce prédicat.
    expect(peutPiloterMissionsAdam(amina)).toBe(false);
    expect(peutPiloterMissionsAdam(sa)).toBe(true);
  });

  it("le Super Admin : la vue globale nomme le propriétaire de chaque mission, et la fiche d'autrui se lit", async () => {
    const vue = await vueGlobaleDesMissions({ limite: 200 });
    const parId = new Map(vue.lignes.map((l) => [l.id, l]));
    expect(parId.get(missionAmina)?.proprietaire.id).toBe(amina.id);
    expect(parId.get(missionBilal)?.proprietaire.id).toBe(bilal.id);
    expect(parId.get(executionBilal)?.genre).toBe("RUNTIME");
    expect(vue.personnes).toBeGreaterThanOrEqual(2);
    expect(await proprietaireDeMission(executionBilal)).toBe(bilal.id);
    expect(await vueMission(executionBilal, (await proprietaireDeMission(executionBilal))!)).not.toBeNull();
  });
});

describe("4 · « Missions terrain » — les missions d'équipe de Mon espace, renommées sans rien déplacer", () => {
  it("l'onglet de Mon espace s'appelle « Missions terrain » ; adresse et module inchangés", async () => {
    const onglet = WORKSPACE_TABS.find((t) => t.href === "/mon-espace/missions");
    expect(onglet?.label).toBe("Missions terrain");
    expect(onglet?.module).toBe("WORKSPACE");
    const espace = (await navigationFor(amina)).find((n) => n.href === "/mon-espace");
    expect((espace?.tabs ?? []).map((t) => t.label)).toContain("Missions terrain");
    expect((espace?.tabs ?? []).map((t) => t.label)).not.toContain("Mes missions");
  });
});
