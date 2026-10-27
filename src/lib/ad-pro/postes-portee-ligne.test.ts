import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import {
  addAdProItem, updateAdProItem, submitAdProItem, deleteAdProItem,
  ajouterVoyageur, modifierVoyageur, retirerVoyageur, demanderReservation,
} from "@/lib/actions/ad-pro-item-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

// Un suffixe PAR RUN : un banc à étiquette fixe ne survit pas à un run interrompu (§118.136).
const TAG = "__posteportee__";
const RUN = `${TAG}${Date.now().toString(36)}`;
const DEBUT = new Date(Date.now() - 1_000);

/** Les droits viennent de la VRAIE matrice de rôles : un droit posé à la main prouverait une porte
 *  qu'aucun rôle réel ne franchit (§118.104). */
async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

const fd = (champs: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  return f;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES GESTES SUR LES POSTES LISENT LA PORTÉE DE LA FICHE (§118.175).
 *
 * Un congrès a une portée « ses lignes » : un délégué n'y voit que SES demandes, et la liste, la
 * fiche et la porte des pièces l'appliquent (§118.153). Les gestes sur les POSTES ne lisaient que
 * le droit du module : un identifiant forgé faisait modifier, soumettre ou retirer les postes du
 * congrès d'un collègue — et, par les gestes de ce lot, y inscrire des voyageurs et ouvrir un sujet
 * de réservation à son nom. Une porte gardée à côté d'une porte ouverte (§118.71).
 *
 * Trois moitiés, et chacune a son cas : le collègue est refusé et RIEN n'est écrit ; l'auteur agit
 * sur ses postes (sans quoi une garde qui refuse tout passerait pour armée, §118.17) ; et le
 * sponsoring, qui n'a PAS de portée de ligne, ne change pas (sans quoi une garde qui exigerait
 * d'être le demandeur passerait aussi).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Postes Ad & Pro — un geste sur un poste exige de VOIR sa demande", () => {
  const u: Record<string, string> = {};
  let congres = "", brouillon = "", poste = "", voyageur = "", sponsoring = "", posteSponsoring = "";

  beforeAll(async () => {
    await nettoyer();
    const mk = async (k: string, role: SessionUser["role"]) => {
      u[k] = (await prisma.user.create({ data: { name: `${RUN} ${k}`, email: `${RUN}${k}@t.dz`, role, passwordHash: "x" } })).id;
    };
    await mk("kamA", "MEDICAL_DELEGATE");
    await mk("kamB", "MEDICAL_DELEGATE");
    await mk("ns", "NATIONAL_SALES");

    // PRÉVALIDÉ (27/10/2026) : sans quoi aucun poste ne s'y ajoute, et le refus ne dirait plus rien de la portée.
    congres = (await prisma.congressNational.create({ data: { name: `${RUN} Journées d'Oran`, requesterId: u.kamA, requestStatus: "APPROVED" } })).id;
    // Le même auteur, une demande encore dans le circuit.
    brouillon = (await prisma.congressNational.create({ data: { name: `${RUN} Journées de Tlemcen`, requesterId: u.kamA } })).id;
    poste = (await prisma.adProItem.create({
      data: { congressNationalId: congres, kind: "TICKETING", label: `${RUN} Billets Oran`, amountEstimated: 50_000, createdById: u.kamA, updatedById: u.kamA },
    })).id;
    voyageur = (await prisma.adProVoyageur.create({
      data: { itemId: poste, nom: "Dr Kaci", position: 1, createdById: u.kamA, updatedById: u.kamA },
    })).id;
    // Un sponsoring déposé par QUELQU'UN D'AUTRE que celui qui agira dessus.
    sponsoring = (await prisma.sponsoringRequest.create({
      data: { reference: `${RUN}-SP`, institution: `${RUN} Association`, type: "Congrès", requesterId: u.kamA },
    })).id;
    posteSponsoring = (await prisma.adProItem.create({
      data: { sponsoringId: sponsoring, kind: "PRINTING", label: `${RUN} Affiches`, amountEstimated: 40_000, createdById: u.kamA, updatedById: u.kamA },
    })).id;
  }, 60_000);

  afterAll(nettoyer);

  async function nettoyer() {
    const ids = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((x) => x.id);
    // Un sujet de réservation n'existe ici que si la garde a CÉDÉ (un sabotage) : ses notifications
    // sont alors parties aux assistantes de la base partagée. Retirées par leur lien, BORNÉES à ce
    // run — par le seul lien, Postgres parcourt toute la table (§118.175).
    const sujets = (await prisma.dossier.findMany({ where: { createdById: { in: ids } }, select: { id: true } })).map((d) => d.id);
    for (const s of sujets) await prisma.notification.deleteMany({ where: { link: { contains: s }, createdAt: { gte: DEBUT } } }).catch(() => undefined);
    await prisma.dossier.deleteMany({ where: { id: { in: sujets } } }).catch(() => undefined);
    await prisma.congressNational.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.sponsoringRequest.deleteMany({ where: { reference: { startsWith: TAG } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  it("PRÉMISSES : le refus ne peut venir QUE de la portée de ligne", async () => {
    // Sans elles, un refus pourrait venir d'un droit de module absent — et le cas resterait vert le
    // jour où la porte se rouvrirait, sans plus rien garder (§118.104).
    const kamB = await acteur(u.kamB, "MEDICAL_DELEGATE");
    expect(userCan(kamB, "CONGRESS_NATIONAL", "CREATE") || userCan(kamB, "CONGRESS_NATIONAL", "UPDATE")).toBe(true);
    expect(kamB.access.modules.get("CONGRESS_NATIONAL")?.scope).toBe("ASSIGNED");
    expect(await canAccessEntity(kamB, "CONGRESS_NATIONAL", congres, "VIEW")).toBe(false);
    const kamA = await acteur(u.kamA, "MEDICAL_DELEGATE");
    expect(await canAccessEntity(kamA, "CONGRESS_NATIONAL", congres, "VIEW")).toBe(true);
    // Le sponsoring n'a pas de portée de ligne : le National Sales le voit sans en être l'auteur.
    const ns = await acteur(u.ns, "NATIONAL_SALES");
    expect(userCan(ns, "SPONSORING", "UPDATE")).toBe(true);
    expect(await canAccessEntity(ns, "SPONSORING", sponsoring, "VIEW")).toBe(true);
  });

  it("un AUTRE délégué n'agit sur aucun poste du congrès d'un collègue — et RIEN n'est écrit", async () => {
    ACTOR = await acteur(u.kamB, "MEDICAL_DELEGATE");
    const avant = await prisma.adProItem.findUniqueOrThrow({ where: { id: poste }, select: { label: true, status: true, reservationDossierId: true, updatedAt: true } });

    const refus: [string, { ok: boolean; error?: string }, string][] = [
      ["ajouter un poste", await addAdProItem(undefined, fd({ parent: "CONGRESS_NATIONAL", parentId: congres, label: "Forgé", kind: "OTHER" })), "Opération introuvable."],
      ["modifier le poste", await updateAdProItem(undefined, fd({ id: poste, label: "Forgé" })), "Poste introuvable."],
      ["soumettre le poste", await submitAdProItem(undefined, fd({ id: poste })), "Poste introuvable."],
      ["retirer le poste", await deleteAdProItem(undefined, fd({ id: poste })), "Poste introuvable."],
      ["ajouter un voyageur", await ajouterVoyageur(undefined, fd({ itemId: poste, nom: "Forgé" })), "Poste introuvable."],
      ["modifier un voyageur", await modifierVoyageur(undefined, fd({ id: voyageur, nom: "Forgé" })), "Voyageur introuvable."],
      ["retirer un voyageur", await retirerVoyageur(fd({ id: voyageur })), "Voyageur introuvable."],
      ["demander la réservation", await demanderReservation(fd({ id: poste })), "Poste introuvable."],
    ];
    // La MÊME phrase que l'absence : un refus « non autorisé » confirmerait que le poste existe.
    for (const [geste, r, phrase] of refus) {
      expect(r.ok, `${geste} doit être refusé`).toBe(false);
      expect(r.error, geste).toBe(phrase);
    }

    const apres = await prisma.adProItem.findUniqueOrThrow({ where: { id: poste }, select: { label: true, status: true, reservationDossierId: true, updatedAt: true } });
    expect(apres).toEqual(avant);
    expect(await prisma.adProItem.count({ where: { congressNationalId: congres } })).toBe(1);
    expect((await prisma.adProVoyageur.findMany({ where: { itemId: poste }, select: { nom: true } })).map((v) => v.nom)).toEqual(["Dr Kaci"]);
    expect(await prisma.dossier.count({ where: { createdById: u.kamB } })).toBe(0);
  }, 60_000);

  it("l'AUTEUR agit sur SES postes — la garde ne refuse pas tout le monde", async () => {
    ACTOR = await acteur(u.kamA, "MEDICAL_DELEGATE");
    const ajout = await ajouterVoyageur(undefined, fd({ itemId: poste, nom: "Dr Ferhat" }));
    expect(ajout.ok, ajout.error).toBe(true);
    const modif = await updateAdProItem(undefined, fd({ id: poste, label: `${RUN} Billets Oran (aller-retour)` }));
    expect(modif.ok, modif.error).toBe(true);
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: poste } })).label).toBe(`${RUN} Billets Oran (aller-retour)`);
    const nouveau = await addAdProItem(undefined, fd({ parent: "CONGRESS_NATIONAL", parentId: congres, label: `${RUN} Hôtel`, kind: "ACCOMMODATION" }));
    expect(nouveau.ok, nouveau.error).toBe(true);
  }, 60_000);

  it("l'AUTEUR non plus n'ajoute aucun poste AVANT la prévalidation de sa demande (27/10/2026) — et le refus le dit", async () => {
    ACTOR = await acteur(u.kamA, "MEDICAL_DELEGATE");
    const r = await addAdProItem(undefined, fd({ parent: "CONGRESS_NATIONAL", parentId: brouillon, label: `${RUN} Hôtel`, kind: "ACCOMMODATION" }));
    expect(r.ok).toBe(false);
    // Pas « introuvable » : il voit sa demande ; c'est la prévalidation qui manque.
    expect(r.error).toMatch(/^Les postes s'ajoutent après la prévalidation de la Direction Marketing/);
    expect(await prisma.adProItem.count({ where: { congressNationalId: brouillon } })).toBe(0);
  }, 60_000);

  it("le SPONSORING n'a pas de portée de ligne : celui qui a le module agit sur le poste d'un autre, comme avant", async () => {
    ACTOR = await acteur(u.ns, "NATIONAL_SALES");
    const r = await updateAdProItem(undefined, fd({ id: posteSponsoring, label: `${RUN} Affiches et kakémonos` }));
    expect(r.ok, r.error).toBe(true);
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: posteSponsoring } })).label).toBe(`${RUN} Affiches et kakémonos`);
  }, 60_000);
});
