import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let ACTEUR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR, getUser: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { executerAction, resoudreFonction, echecDeclare } from "./executer";
import { CONTRATS_ACTIONS } from "./contrat.genere";
import { interdictionGenerique } from "./generique";
import { isRetiredModule } from "@/lib/modules-retired";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__exegen__";

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CHEMIN GÉNÉRIQUE, DE BOUT EN BOUT — et la question de §118.14 posée au parc entier.
 *
 * « Ce composant peut-il être déclenché et produire un effet utile ? » Un test qui vérifierait
 * `executerAction` sur une action fabriquée répondrait non. On part donc du contrat DÉRIVÉ,
 * on appelle l'action RÉELLE de l'écran, et on constate EN BASE.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("AIGUILLAGE — chaque action décrite existe VRAIMENT dans son module", () => {
  it("les 715 se résolvent — le contrôle d'appelant que le compilateur ne fait pas ici", async () => {
    // §118.49 : un test qui vérifie le corps d'une fonction sans vérifier son appelant ne teste
    // rien. Ici l'artefact PRÉTEND que 715 fonctions existent ; on les résout toutes.
    const perdues: string[] = [];
    for (const c of CONTRATS_ACTIONS) {
      if (!(await resoudreFonction(c.fichier, c.fonction))) perdues.push(c.id);
    }
    expect(
      perdues,
      `Actions décrites mais introuvables dans leur module → \`npm run actions:contrat\` :\n${perdues.join("\n")}`,
    ).toEqual([]);
  }, 120_000);
});

suite("EXÉCUTION GÉNÉRIQUE — l'action de l'écran, appelée par son contrat", () => {
  let pdgId = "", assistantId = "", demandeId = "";

  beforeAll(async () => {
    const [pdg, assistant] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}pdg`, email: `${TAG}pdg@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}ass`, email: `${TAG}ass@t.dz`, role: "VIEWER", passwordHash: "x" } }),
    ]);
    pdgId = pdg.id; assistantId = assistant.id;
  });

  afterAll(async () => {
    await prisma.administrativeRequest.deleteMany({ where: { title: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  });

  it("CRÉE réellement — contrat dérivé, zéro fiche écrite, et la ligne est EN BASE", async () => {
    ACTEUR = await acteur(pdgId, "SUPER_ADMIN");
    const r = await executerAction(ACTEUR, "admin-request-actions:createRequest", {
      title: `${TAG}Demande générique`, type: "PURCHASE", priority: "HIGH",
      description: "créée par le chemin générique",
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const ligne = await prisma.administrativeRequest.findFirst({ where: { title: `${TAG}Demande générique` } });
    expect(ligne, "aucune ligne en base : le succès annoncé serait un faux succès").not.toBeNull();
    expect(ligne!.type).toBe("PURCHASE");
    expect(ligne!.priority).toBe("HIGH");
    expect(ligne!.description).toBe("créée par le chemin générique");
    demandeId = ligne!.id;
  });

  it("MODIFIE réellement, par l'action de l'écran", async () => {
    ACTEUR = await acteur(pdgId, "SUPER_ADMIN");
    // « Commencer le traitement » : depuis 10/2026, plus aucun statut ne se pose à la main — l'assistante n'a
    // que deux gestes (Direction). Ce banc posait « En attente d'un tiers », étape retirée.
    const r = await executerAction(ACTEUR, "admin-request-actions:startRequestProcessing", { id: demandeId });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const ligne = await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: demandeId } });
    expect(ligne.status).toBe("IN_PROGRESS");
  });

  it("LA PORTE DE L'ACTION tient — l'exécuteur n'est pas une porte dérobée", async () => {
    // L'exécuteur ne vérifie AUCUN droit lui-même : c'est l'action qui refuse, comme au clic.
    // Et le refus remonte en ÉCHEC (`motif: "refusee"`), pas en succès : c'est §118.25 par le
    // VRAI point d'entrée, là où le test unitaire ci-dessus n'exerce que la lecture du retour.
    ACTEUR = await acteur(assistantId, "VIEWER");
    const r = await executerAction(ACTEUR, "admin-request-actions:updateRequestStatus", {
      id: demandeId, status: "DONE",
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.motif, JSON.stringify(r)).toBe("refusee");
    const ligne = await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: demandeId } });
    expect(ligne.status).toBe("IN_PROGRESS"); // rien n'a bougé
  });

  it("§118.25 — l'échec déclaré est lu sur les ÉCRITURES, et seulement sur elles", () => {
    // La première version de ce banc affirmait `r.ok === true` sur un appel ayant rendu
    // « Non autorisé. » sans rien créer : `ok` disait « l'appel a eu lieu », et l'échec dormait
    // dans `retour`. Le faux succès était dans le banc avant d'être dans le produit.
    const ecrivante = { ecrit: true } as Parameters<typeof echecDeclare>[0];
    expect(echecDeclare(ecrivante, { ok: false, error: "Non autorisé." })).toBe("Non autorisé.");
    expect(echecDeclare(ecrivante, { ok: false })).toMatch(/sans donner de motif/);
    expect(echecDeclare(ecrivante, { ok: true, id: "x" })).toBeNull();

    // LA RESTRICTION, et c'est la moitié de la règle : sur une LECTURE, `ok: false` peut être
    // une réponse légitime (« non conforme »), et refuser à tort est strictement pire que le
    // défaut qu'on corrige. Sans cette ligne, la restriction serait écrite et non tenue.
    const lisante = { ecrit: false } as Parameters<typeof echecDeclare>[0];
    expect(echecDeclare(lisante, { ok: false, error: "non conforme" })).toBeNull();

    // Et ce qu'on ne lit pas à coup sûr ne devient pas un échec (§118.16).
    expect(echecDeclare(ecrivante, "une chaîne")).toBeNull();
    expect(echecDeclare(ecrivante, undefined)).toBeNull();
  });

  it("AUTO-ESCALADE : refusée AVANT tout appel — le module n'est même pas chargé", async () => {
    ACTEUR = await acteur(pdgId, "SUPER_ADMIN");
    const avant = await prisma.user.findUniqueOrThrow({ where: { id: assistantId } });
    const r = await executerAction(ACTEUR, "admin-actions:updateUserRole", {
      userId: assistantId, role: "SUPER_ADMIN",
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.motif).toBe("interdite");
    expect(r.ok === false && r.message).toMatch(/écran d'administration/);
    // Le PDG a pourtant TOUS les droits : le refus n'est pas une question de permission, c'est
    // une propriété d'Adam. La ligne n'a pas bougé.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: assistantId } })).role).toBe(avant.role);
  });

  it("un champ INVENTÉ est refusé avant l'appel — jamais ignoré en silence", async () => {
    ACTEUR = await acteur(pdgId, "SUPER_ADMIN");
    const r = await executerAction(ACTEUR, "admin-request-actions:createRequest", {
      title: `${TAG}xx`, type: "PURCHASE", champInexistant: "42",
    });
    expect(r.ok === false && r.motif).toBe("entree");
    expect(await prisma.administrativeRequest.findFirst({ where: { title: `${TAG}xx` } })).toBeNull();
  });

  it("une valeur hors énum est refusée AVEC les valeurs admises", async () => {
    ACTEUR = await acteur(pdgId, "SUPER_ADMIN");
    const r = await executerAction(ACTEUR, "admin-request-actions:createRequest", {
      title: `${TAG}yy`, type: "ACHAT URGENT",
    });
    expect(r.ok === false && r.message).toContain("PURCHASE");
    expect(await prisma.administrativeRequest.findFirst({ where: { title: `${TAG}yy` } })).toBeNull();
  });

  it("une action INCONNUE le dit — pas de « je ne peux pas » vague", async () => {
    ACTEUR = await acteur(pdgId, "SUPER_ADMIN");
    const r = await executerAction(ACTEUR, "n-existe-pas:duTout", {});
    expect(r.ok === false && r.motif).toBe("inconnue");
  });

  it("UN MODULE RETIRÉ refuse tout le monde, Super Admin compris", () => {
    // Écrit d'abord comme une DETTE : `BUSINESS_DEVELOPMENT` est retiré du service (2026-09),
    // donc l'écran « BD › Projets » que le dirigeant avait demandé était inatteignable — code
    // mort poussé en production (§118.14, §118.50). Le dirigeant a tranché : rouvrir Projets,
    // et LUI SEUL. La preuve de la réouverture vit dans `bd-projets-maintenu.test.ts` ; ce
    // qui reste ici est la moitié qu'on aurait pu perdre en réparant — Market Intelligence
    // doit rester fermé, sans quoi l'empreinte réelle dépasserait la demande (§118.16).
    expect(isRetiredModule("BUSINESS_DEVELOPMENT")).toBe(true);
  });

  it("MESURE — combien d'actions le chemin générique ouvre réellement", () => {
    const lisibles = CONTRATS_ACTIONS.filter((c) => !c.illisible);
    const ouvertes = lisibles.filter((c) => !interdictionGenerique(c));
    console.info(
      `[CHEMIN_GENERIQUE] ${ouvertes.length} actions ouvertes sur ${CONTRATS_ACTIONS.length} — `
      + `${lisibles.length - ouvertes.length} refusées par conception, `
      + `${CONTRATS_ACTIONS.length - lisibles.length} non descriptibles`,
    );
    expect(ouvertes.length).toBeGreaterThan(500);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'APPEL POSITIONNEL, PAR LE VRAI POINT D'ENTRÉE.
 *
 * `enArguments` est vérifiée à part, sur des contrats fabriqués. Ça ne prouve RIEN sur la
 * production : ce qui compte est qu'`executerAction` CHOISISSE cette branche et appelle
 * réellement `f(a, b)`. Sans ce banc, la traduction pourrait être parfaite et l'exécuteur
 * continuer de passer un `FormData` au premier rang — l'action recevrait un objet là où elle
 * attend un identifiant, et `deleteDocument` supprimerait au hasard (§118.49).
 *
 * On part donc d'une action à ARGUMENTS réelle, on l'appelle, et on constate EN BASE.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("ARGUMENTS — l'exécuteur appelle positionnellement, et l'effet est en base", () => {
  let userId = "", notifId = "";

  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG}notif`, email: `${TAG}notif@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" },
    });
    userId = u.id;
    const n = await prisma.notification.create({
      data: { userId, title: `${TAG}à lire`, body: "corps", type: "GENERIC", isRead: false },
    });
    notifId = n.id;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { title: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  });

  it("`markNotificationRead(id)` — un seul argument, et la ligne CHANGE", async () => {
    ACTEUR = await acteur(userId, "SUPER_ADMIN");
    const contrat = CONTRATS_ACTIONS.find((c) => c.id === "notification-actions:markNotificationRead");
    expect(contrat?.appel, "cette action n'est plus à arguments — le banc ne prouve plus rien").toBe("arguments");
    expect(contrat?.illisible, "elle n'est plus descriptible").toBeNull();

    const r = await executerAction(ACTEUR, "notification-actions:markNotificationRead", { id: notifId });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const ligne = await prisma.notification.findUniqueOrThrow({ where: { id: notifId } });
    // SANS la branche positionnelle, l'action aurait reçu un `FormData` : `where: { id: {} }`,
    // aucune ligne touchée, et le retour aurait pu rester d'apparence normale.
    expect(ligne.isRead, "la notification n'a pas été marquée lue : l'appel n'est pas positionnel").toBe(true);
  });

  it("une entrée INCONNUE est refusée AVANT l'appel — jamais glissée dans un rang", async () => {
    ACTEUR = await acteur(userId, "SUPER_ADMIN");
    const r = await executerAction(ACTEUR, "notification-actions:markNotificationRead",
      { id: notifId, quoiQueCeSoit: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motif).toBe("entree");
  });

  it("les surfaces humaines sont refusées ICI aussi, pas seulement dans la garde", async () => {
    ACTEUR = await acteur(userId, "SUPER_ADMIN");
    const r = await executerAction(ACTEUR, "adam-settings-actions:setAdamOutboundPaused", { paused: false });
    expect(r.ok, "l'interrupteur de sortie d'Adam a été atteint par le chemin générique").toBe(false);
    if (!r.ok) expect(r.motif).toBe("interdite");
  });
});
