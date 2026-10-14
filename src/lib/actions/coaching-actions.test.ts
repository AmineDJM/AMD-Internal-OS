import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import {
  creerFicheCoaching, enregistrerGrilleCoaching, finaliserFicheCoaching, modifierFicheCoaching, supprimerFicheCoaching,
} from "./coaching-actions";
import { collaborateursCoachables, grilleCourante, lecteurCoaching } from "@/lib/coaching/serveur";
import { chargerFicheVisible, listerFichesVisibles } from "@/lib/coaching/fiches";
import { peutLireFiche } from "@/lib/coaching/acces";
import { cleProvisoire, type GrilleCoaching, type Points } from "@/lib/coaching/grille";
import { GET as exporterFiche } from "@/app/api/medical/coaching/[id]/export/route";
import { visibleTabs } from "@/lib/nav-tabs";
import { MEDICAL_TABS } from "@/lib/labels";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__coach__";

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role as SessionUser["role"]);
  return { id, name: u.name, email: u.email, role: u.role as SessionUser["role"], secondaryRole: u.secondaryRole as SessionUser["role"] | null, access, mustChangePassword: false } as CurrentUser;
}

const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

const complet = (g: GrilleCoaching, n: Points): Record<string, Points> => Object.fromEntries(g.axes.map((a) => [a.cle, n]));

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FICHE DE COACHING DE BOUT EN BOUT (§118.157) — par les VRAIES actions, avec des acteurs
 * SANS vue globale (§118.104) : un banc joué par le Super Admin ne verrait jamais une fiche lui
 * échapper.
 *
 *   do    Directeur des Opérations — administre la grille, n'a que la LECTURE du module
 *   ns    National Sales, superviseur de la BU X        kam1, kam3   KAM de la BU X
 *   ns2   National Sales, superviseur de la BU Y        kam2         KAM de la BU Y
 *   fin   un compte sans la Promotion médicale
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Fiche de coaching — grille, fiches, droits, export", () => {
  const ids: Record<string, string> = {};
  let grilleAvant = "";
  const fiches: string[] = [];
  let G: GrilleCoaching;

  beforeAll(async () => {
    await nettoyer();
    const faire = (nom: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, role: role as never, passwordHash: "x" } });
    const [d, n, n2, k1, k2, k3, f] = await Promise.all([
      faire("do", "OPERATIONS_DIRECTOR"), faire("ns", "NATIONAL_SALES"), faire("ns2", "NATIONAL_SALES"),
      faire("kam1", "MEDICAL_DELEGATE"), faire("kam2", "MEDICAL_DELEGATE"), faire("kam3", "MEDICAL_DELEGATE"),
      faire("fin", "FINANCE_BUDGET_MANAGER"),
    ]);
    Object.assign(ids, { do: d.id, ns: n.id, ns2: n2.id, kam1: k1.id, kam2: k2.id, kam3: k3.id, fin: f.id });
    const [buX, buY] = await Promise.all([
      prisma.businessUnit.create({ data: { name: `${TAG} BU X`, supervisorId: n.id } }),
      prisma.businessUnit.create({ data: { name: `${TAG} BU Y`, supervisorId: n2.id } }),
    ]);
    await prisma.salesRepProfile.createMany({
      data: [
        { repId: k1.id, businessUnitId: buX.id, region: "Centre" },
        { repId: k3.id, businessUnitId: buX.id },
        { repId: k2.id, businessUnitId: buY.id },
      ],
    });
    await prisma.salesSector.create({ data: { name: `${TAG} Alger-Est`, businessUnitId: buX.id, reps: { create: [{ repId: k1.id }] } } });
    const courante = await grilleCourante();
    G = courante.grille;
    grilleAvant = JSON.stringify(courante.grille);
  });

  afterAll(async () => {
    await nettoyer();
  });

  async function nettoyer() {
    const users = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } });
    const uids = users.map((u) => u.id);
    if (uids.length) {
      await prisma.coachingSheet.deleteMany({ where: { OR: [{ collaboratorId: { in: uids } }, { createdById: { in: uids } }] } });
      // Les versions de grille PUBLIÉES par le banc disparaissent avec lui : la grille en vigueur
      // redevient celle d'avant, sans version « de restauration » qui encombrerait l'historique.
      await prisma.coachingGrid.deleteMany({ where: { createdById: { in: uids } } });
    }
    await prisma.salesSector.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.salesRepProfile.deleteMany({ where: { repId: { in: uids } } });
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.notification.deleteMany({ where: { userId: { in: uids } } });
    await prisma.user.deleteMany({ where: { id: { in: uids } } });
  }

  const creer = async (acteur: string, champs: Record<string, string>) => {
    ACTOR = await actorFor(ids[acteur]!);
    return creerFicheCoaching(form(champs));
  };

  it("PRÉMISSES : le directeur des opérations n'a que la LECTURE du module ; le compte des Finances ne l'a pas", async () => {
    const d = await actorFor(ids.do!);
    expect(userCan(d, "MEDICAL", "VIEW")).toBe(true);
    expect(userCan(d, "MEDICAL", "CREATE"), "ses droits de coaching viennent de la règle, pas du CRUD du module").toBe(false);
    expect(userCan(await actorFor(ids.fin!), "MEDICAL", "VIEW")).toBe(false);
    expect(userCan(await actorFor(ids.kam1!), "MEDICAL", "VIEW")).toBe(true);
  });

  it("l'onglet Coaching s'offre au directeur des opérations, au superviseur et au KAM — pas au compte des Finances", async () => {
    // Le directeur des opérations n'a que la LECTURE du module : un onglet qui exigerait un droit
    // d'écriture lui cacherait l'écran même qu'il administre (§118.50).
    const coaching = async (qui: string) =>
      (await visibleTabs(await actorFor(ids[qui]!), MEDICAL_TABS)).find((t) => t.href === "/medical/coaching")?.show ?? false;
    for (const qui of ["do", "ns", "kam1"]) expect(await coaching(qui), qui).toBe(true);
    expect(await coaching("fin")).toBe(false);
  });

  it("les collaborateurs coachables : l'équipe pour le superviseur, toute la force de vente pour le directeur des opérations", async () => {
    const ns = (await collaborateursCoachables(await lecteurCoaching(await actorFor(ids.ns!)))).map((c) => c.id);
    expect(new Set(ns)).toEqual(new Set([ids.kam1, ids.kam3]));
    const tout = (await collaborateursCoachables(await lecteurCoaching(await actorFor(ids.do!)))).map((c) => c.id);
    for (const k of ["kam1", "kam2", "kam3", "ns", "ns2"]) expect(tout, k).toContain(ids[k]);
    expect(tout).not.toContain(ids.fin);
    expect(tout).not.toContain(ids.do);
    const kam1 = (await collaborateursCoachables(await lecteurCoaching(await actorFor(ids.do!)))).find((c) => c.id === ids.kam1)!;
    expect(kam1.secteur, "le secteur se pré-remplit depuis la force de vente").toBe(`${TAG} Alger-Est — Centre — BU ${TAG} BU X`);
  });

  it("un KAM ne remplit pas de fiche ; un superviseur ne coache pas l'équipe d'un autre ; un compte sans le module est refusé", async () => {
    const jour = "2026-09-10";
    expect((await creer("kam1", { collaboratorId: ids.kam3!, visitDate: jour })).error).toMatch(/pas dans votre périmètre/);
    expect((await creer("ns", { collaboratorId: ids.kam2!, visitDate: jour })).error).toMatch(/pas dans votre périmètre/);
    expect((await creer("fin", { collaboratorId: ids.kam1!, visitDate: jour })).error).toMatch(/Promotion médicale ne vous est pas ouverte/);
    expect((await creer("ns", { collaboratorId: ids.ns!, visitDate: jour })).error).toMatch(/propre fiche/);
    expect((await creer("do", { collaboratorId: ids.fin!, visitDate: jour })).error, "hors force de vente terrain").toMatch(/pas dans votre périmètre/);
  });

  it("le superviseur crée un BROUILLON : ni le collaborateur, ni un pair, ni un autre superviseur ne le voient ; le directeur des opérations, si", async () => {
    const r = await creer("ns", {
      collaboratorId: ids.kam1!, visitDate: "2026-09-10", sector: "Alger-Est",
      scores: JSON.stringify({ [G.axes[0]!.cle]: 3 }), strengths: "Bonne préparation",
    });
    expect(r.ok, r.error).toBe(true);
    fiches.push(r.id!);
    const f = await prisma.coachingSheet.findUniqueOrThrow({ where: { id: r.id! } });
    expect(f).toMatchObject({ status: "DRAFT", managerId: ids.ns, createdById: ids.ns, collaboratorId: ids.kam1 });
    for (const qui of ["kam1", "kam3", "ns2"]) {
      expect(await chargerFicheVisible(await lecteurCoaching(await actorFor(ids[qui]!)), r.id!), qui).toBeNull();
    }
    expect(await chargerFicheVisible(await lecteurCoaching(await actorFor(ids.do!)), r.id!)).not.toBeNull();
    expect(await prisma.notification.count({ where: { userId: ids.kam1, link: `/medical/coaching/${r.id}` } }), "un brouillon ne prévient personne").toBe(0);
  });

  it("seul le directeur des opérations nomme un autre manager que soi", async () => {
    const refus = await creer("ns", { collaboratorId: ids.kam1!, managerId: ids.ns2!, visitDate: "2026-09-09" });
    expect(refus.error).toMatch(/seul le directeur des opérations/);
    const r = await creer("do", { collaboratorId: ids.kam3!, managerId: ids.ns!, visitDate: "2026-09-09" });
    expect(r.ok, r.error).toBe(true);
    fiches.push(r.id!);
    const f = await prisma.coachingSheet.findUniqueOrThrow({ where: { id: r.id! } });
    expect(f).toMatchObject({ managerId: ids.ns, createdById: ids.do });
    // Le manager désigné tient la fiche comme la sienne : il la lit et la modifie en brouillon.
    ACTOR = await actorFor(ids.ns!);
    expect((await modifierFicheCoaching(form({ id: r.id!, sector: "Centre" }))).ok).toBe(true);
  });

  it("une tournée future, une note hors barème, un axe inconnu : refusés, et nommés", async () => {
    const futur = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    expect((await creer("ns", { collaboratorId: ids.kam1!, visitDate: futur })).error).toMatch(/n'a pas encore eu lieu/);
    const r = await creer("ns", { collaboratorId: ids.kam1!, visitDate: "2026-09-08", scores: JSON.stringify({ [G.axes[0]!.cle]: 5, Z9: 2 }) });
    expect(r.error).toMatch(/hors barème/);
    expect(r.error).toMatch(/axe inconnu/);
    expect((await creer("ns", { collaboratorId: ids.kam1!, visitDate: "2026-02-31" })).error, "le refus montre ce qu'il a reçu").toMatch(/« 2026-02-31 » n'est pas un jour/);
    expect((await creer("ns", { collaboratorId: ids.kam1! })).error).toMatch(/Indiquez le jour de la tournée/);
  });

  it("finaliser : refusé tant qu'un axe manque (et les axes sont nommés) ; complet, la fiche est partagée et le collaborateur prévenu", async () => {
    const id = fiches[0]!;
    ACTOR = await actorFor(ids.ns!);
    const refus = await finaliserFicheCoaching(form({ id }));
    expect(refus.error).toMatch(/Pour finaliser, notez/);
    expect(refus.error).toContain(G.axes[1]!.titre);
    expect((await modifierFicheCoaching(form({ id, scores: JSON.stringify(complet(G, 3)) }))).ok).toBe(true);
    const r = await finaliserFicheCoaching(form({ id }));
    expect(r.ok, r.error).toBe(true);
    const f = await prisma.coachingSheet.findUniqueOrThrow({ where: { id } });
    expect(f).toMatchObject({ status: "FINALIZED", finalizedById: ids.ns });
    const notes = await prisma.notification.findMany({ where: { userId: ids.kam1, link: `/medical/coaching/${id}` } });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toContain(`${3 * G.axes.length} / ${4 * G.axes.length}`);
    // Désormais visible du collaborateur et de son superviseur — jamais d'un pair ni d'un autre superviseur.
    expect(await chargerFicheVisible(await lecteurCoaching(await actorFor(ids.kam1!)), id)).not.toBeNull();
    expect(await chargerFicheVisible(await lecteurCoaching(await actorFor(ids.kam3!)), id)).toBeNull();
    expect(await chargerFicheVisible(await lecteurCoaching(await actorFor(ids.ns2!)), id)).toBeNull();
  });

  it("deux finalisations simultanées ne préviennent le collaborateur qu'UNE fois", async () => {
    const r = await creer("ns", { collaboratorId: ids.kam3!, visitDate: "2026-09-07", scores: JSON.stringify(complet(G, 2)) });
    fiches.push(r.id!);
    ACTOR = await actorFor(ids.ns!);
    const [a, b] = await Promise.all([finaliserFicheCoaching(form({ id: r.id! })), finaliserFicheCoaching(form({ id: r.id! }))]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await prisma.notification.count({ where: { userId: ids.kam3, link: `/medical/coaching/${r.id}` } })).toBe(1);
  });

  it("finalisée, la fiche ne se modifie plus par son auteur ; le directeur des opérations la corrige, et le collaborateur en est prévenu", async () => {
    const id = fiches[0]!;
    ACTOR = await actorFor(ids.ns!);
    expect((await modifierFicheCoaching(form({ id, strengths: "Retouche" }))).error).toMatch(/seul le directeur des opérations/);
    ACTOR = await actorFor(ids.do!);
    const incomplet = { ...complet(G, 3) };
    delete incomplet[G.axes[0]!.cle];
    expect((await modifierFicheCoaching(form({ id, scores: JSON.stringify(incomplet) }))).error, "une fiche finalisée reste complète").toMatch(/reste complète/);
    const r = await modifierFicheCoaching(form({ id, scores: JSON.stringify({ ...complet(G, 3), [G.axes[0]!.cle]: 4 }) }));
    expect(r.ok, r.error).toBe(true);
    const n = await prisma.notification.findMany({ where: { userId: ids.kam1, link: `/medical/coaching/${id}` }, orderBy: { createdAt: "asc" } });
    expect(n).toHaveLength(2);
    expect(n[1]!.title).toMatch(/modifiée/);
    // Une clé ABSENTE garde sa valeur : le bilan écrit à la création n'a pas été effacé.
    expect((await prisma.coachingSheet.findUniqueOrThrow({ where: { id } })).strengths).toBe("Bonne préparation");
  });

  it("LA LISTE ≡ LA RÈGLE, sur la vraie base, pour chaque acteur", async () => {
    const lignes = await prisma.coachingSheet.findMany({ where: { id: { in: fiches } } });
    for (const qui of ["do", "ns", "ns2", "kam1", "kam2", "kam3"]) {
      const l = await lecteurCoaching(await actorFor(ids[qui]!));
      const liste = (await listerFichesVisibles(l)).fiches.map((f) => f.id).filter((id) => fiches.includes(id)).sort();
      const regle = lignes.filter((f) => peutLireFiche(l, f)).map((f) => f.id).sort();
      expect(liste, qui).toEqual(regle);
    }
    // PRÉMISSE : les acteurs voient réellement des choses différentes.
    const tailles = await Promise.all(["do", "kam1", "kam2"].map(async (qui) =>
      (await listerFichesVisibles(await lecteurCoaching(await actorFor(ids[qui]!)))).fiches.filter((f) => fiches.includes(f.id)).length));
    expect(tailles[0]).toBeGreaterThan(tailles[1]!);
    expect(tailles[2]).toBe(0);
  });

  it("le téléchargement suit la même porte que l'écran : 200 pour le collaborateur, 404 pour un pair", async () => {
    const id = fiches[0]!;
    const appeler = async (qui: string) => {
      ACTOR = await actorFor(ids[qui]!);
      return exporterFiche(new Request(`http://t/api/medical/coaching/${id}/export`), { params: { id } });
    };
    const ok = await appeler("kam1");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-disposition")).toMatch(/Fiche_coaching_coach_kam1_2026-09-10\.xlsx/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await ok.arrayBuffer());
    const ws = wb.getWorksheet("Fiche de coaching")!;
    let total: unknown = null;
    ws.eachRow((row) => row.eachCell((c) => {
      const v = c.value as { formula?: string; result?: unknown } | null;
      if (c.master.address === c.address && v && typeof v === "object" && v.formula?.includes("+")) total = v.result;
    }));
    expect(total).toBe(3 * G.axes.length + 1);
    expect((await appeler("kam3")).status).toBe(404);
    expect((await appeler("ns2")).status).toBe(404);
    expect((await appeler("fin")).status).toBe(403);
    expect((await appeler("do")).status).toBe(200);
  });

  it("LA GRILLE : seul le directeur des opérations la publie ; une nouvelle version ne touche pas les fiches déjà remplies", async () => {
    const modifiee: GrilleCoaching = structuredClone(G);
    modifiee.axes[0]!.titre = `${G.axes[0]!.titre} (révisé)`;
    const retiree = modifiee.axes.pop()!;
    // L'éditeur retire le dernier axe puis en ajoute un : il envoie une clé PROVISOIRE, que le
    // serveur remplace — le nouvel axe ne doit pas hériter des notes de celui qu'on a retiré.
    modifiee.axes.push({ cle: cleProvisoire(modifiee.axes.map((a) => a.cle)), titre: "Z. Suivi post-visite", criteres: ["Aucun suivi", "Suivi ponctuel", "Suivi planifié", "Suivi systématique et partagé"] });

    ACTOR = await actorFor(ids.ns!);
    expect((await enregistrerGrilleCoaching(form({ grille: JSON.stringify(modifiee) }))).error).toMatch(/administrée par le directeur des opérations/);

    ACTOR = await actorFor(ids.do!);
    const avant = await grilleCourante();
    const r = await enregistrerGrilleCoaching(form({ grille: JSON.stringify(modifiee), note: "Banc : axe de suivi" }));
    expect(r.ok, r.error).toBe(true);
    const apres = await grilleCourante();
    expect(apres.version).toBe(avant.version + 1);
    const nouvel = apres.grille.axes[apres.grille.axes.length - 1]!;
    expect(nouvel.titre).toBe("Z. Suivi post-visite");
    expect(nouvel.cle, "un axe neuf reçoit une clé qui n'a jamais servi").not.toBe(retiree.cle);
    expect(nouvel.cle, "la clé provisoire ne survit pas à la publication").not.toMatch(/^nouveau_/);
    expect(G.axes.map((a) => a.cle)).not.toContain(nouvel.cle);
    expect(apres.grille.axes[0]!.cle, "un axe reformulé garde sa clé").toBe(G.axes[0]!.cle);

    // Publier la même chose ne crée pas de version.
    const meme = await enregistrerGrilleCoaching(form({ grille: JSON.stringify(apres.grille) }));
    expect(meme.message).toMatch(/Aucune modification/);
    expect((await grilleCourante()).version).toBe(apres.version);

    // Les fiches déjà remplies gardent leur grille ; une fiche neuve prend la nouvelle.
    const ancienne = await prisma.coachingSheet.findUniqueOrThrow({ where: { id: fiches[0]! }, select: { gridId: true } });
    expect(ancienne.gridId).toBe(avant.id);
    const neuve = await creer("ns", { collaboratorId: ids.kam1!, visitDate: "2026-09-11" });
    fiches.push(neuve.id!);
    expect((await prisma.coachingSheet.findUniqueOrThrow({ where: { id: neuve.id! } })).gridId).toBe(apres.id);
    // Et une note posée sur la clé retirée est refusée pour la fiche neuve…
    ACTOR = await actorFor(ids.ns!);
    expect((await modifierFicheCoaching(form({ id: neuve.id!, scores: JSON.stringify({ [retiree.cle]: 2 }) }))).error).toMatch(/axe inconnu/);
    // … mais acceptée pour l'ancienne, notée sur SA grille (par l'administration, puisqu'elle est finalisée).
    ACTOR = await actorFor(ids.do!);
    expect((await modifierFicheCoaching(form({ id: fiches[0]!, scores: JSON.stringify({ ...complet(G, 3), [retiree.cle]: 2 }) }))).ok).toBe(true);
  });

  it("retirer : l'auteur son brouillon ; une fiche finalisée par l'administration seule, et le collaborateur en est prévenu", async () => {
    const brouillon = fiches[fiches.length - 1]!;
    ACTOR = await actorFor(ids.ns!);
    expect((await supprimerFicheCoaching(form({ id: fiches[0]! }))).error).toMatch(/directeur des opérations/);
    expect((await supprimerFicheCoaching(form({ id: brouillon }))).ok).toBe(true);
    ACTOR = await actorFor(ids.do!);
    expect((await supprimerFicheCoaching(form({ id: fiches[0]! }))).ok).toBe(true);
    const n = await prisma.notification.findFirst({ where: { userId: ids.kam1, title: { contains: "retirée" } } });
    expect(n?.body).toMatch(/a retiré la fiche/);
    expect(await prisma.coachingSheet.count({ where: { id: { in: [brouillon, fiches[0]!] } } })).toBe(0);
  });

  it("la grille d'avant le banc est restaurée par le nettoyage (état partagé de la base)", async () => {
    await nettoyer();
    expect(JSON.stringify((await grilleCourante()).grille)).toBe(grilleAvant);
  });
});
