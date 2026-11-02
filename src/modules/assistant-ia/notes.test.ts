import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « MES NOTES » SUR UNE VRAIE BASE (décision 0026) — par les OUTILS que l'assistant appelle, par les actions de
 * l'écran, et par un vrai tour au faux modèle :
 *   • PRIVÉ : ni un collègue ni le Super Admin ne lit les notes d'une personne — ni par les outils, ni par les
 *     actions (en « Vue exacte » non plus) ;
 *   • L'IA N'ÉCRIT RIEN : chaque geste n'est qu'une proposition ; refusée, rien n'est écrit ; acceptée, la page change
 *     (l'état d'avant en version) ; annulée, elle revient ;
 *   • un montant d'une ligne de paie part au modèle en repère ⟦Sn⟧ ;
 *   • l'enregistrement automatique ne s'écrase pas (verrou de version), la corbeille rend une ligne supprimée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => undefined }));
const session = vi.hoisted(() => ({ user: null as CurrentUser | null }));
vi.mock("@/lib/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/session")>()),
  requireUser: async () => { if (!session.user) throw new Error("non connecté"); return session.user; },
}));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import type { UserRole } from "@prisma/client";
import { outilsNotes } from "./infra/notes/outils";
import { ecrirePage, lireCorbeille, lirePage, listerPages, listerVersions, restaurerLigne } from "./infra/notes/pages";
import { accepter, annuler, refuser, toutAccepter } from "./infra/notes/propositions";
import { CoffretDuTour } from "./domaine/filtre-confidentialite";
import { etatMesNotes, enregistrerMaPage, accepterPropositionNote } from "./actions-notes";
import { remplacerModelesPourTests } from "./infra/generer";
import { remplacerReglagesPourTests } from "./infra/consommation";
import { modeleFactice } from "./infra/testing/modele-factice";
import { effacerJournalDe } from "./infra/testing/journal";
import { jouerTour } from "./infra/fil/tour";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__notes__${Date.now().toString(36)}_`;
const users: CurrentUser[] = [];
let assia: CurrentUser;
let karim: CurrentUser;
let admin: CurrentUser;

async function personne(nom: string, role: UserRole): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role } });
  if (role !== "SUPER_ADMIN") await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
  const access = await getAccess(u.id, u.role);
  const c = { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
  users.push(c);
  return c;
}

const outil = (u: CurrentUser, nom: string, o: Parameters<typeof outilsNotes>[1] = {}) => {
  const t = outilsNotes(u, o).find((x) => x.def.name === nom);
  if (!t) throw new Error(nom);
  return (e: Record<string, unknown>) => t.run(e, u).then((s) => JSON.parse(s) as Record<string, unknown>);
};
const enAttente = (u: CurrentUser) => prisma.assistantIaNoteProposition.findMany({ where: { userId: u.id, etat: "PROPOSEE" }, orderBy: { createdAt: "asc" } });

suite("Mes notes — privé, rien d'écrit sans acceptation (vraie base)", () => {
  let pageId = "";

  beforeAll(async () => {
    assia = await personne("assia", "DIRECTION_ASSISTANT");
    karim = await personne("karim", "SALES_USER");
    admin = await personne("admin", "SUPER_ADMIN");
    const [p] = await listerPages(assia.id);
    pageId = p.id;
    const page = (await lirePage(assia.id, pageId))!;
    const e = await ecrirePage(assia.id, pageId, page.version, [
      { id: "titre001", type: "titre", texte: "Cette semaine", niveau: 0 },
      { id: "ligne001", type: "tache", texte: "Valider le budget du congrès d'Oran", fait: false, niveau: 0 },
      { id: "ligne002", type: "tache", texte: "Prime de Karim : 40 000 DA à confirmer", fait: false, niveau: 0 },
      { id: "titre002", type: "titre", texte: "Idées", niveau: 0 },
      { id: "ligne003", type: "puce", texte: "Kakémonos pour le symposium", niveau: 0 },
    ]);
    expect(e.ok).toBe(true);
  });
  afterEach(() => { remplacerModelesPourTests(null); remplacerReglagesPourTests(null); session.user = null; });
  afterAll(async () => {
    const ids = users.map((u) => u.id);
    await effacerJournalDe(ids);
    await prisma.assistantIaNoteProposition.deleteMany({ where: { userId: { in: ids } } });
    await prisma.assistantIaNoteVersion.deleteMany({ where: { userId: { in: ids } } });
    await prisma.assistantIaNoteCorbeille.deleteMany({ where: { userId: { in: ids } } });
    await prisma.assistantIaNotePage.deleteMany({ where: { userId: { in: ids } } });
    await prisma.assistantIaFil.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  });

  it("une page « Mes notes » par défaut ; lire_notes rend les lignes avec leurs références", async () => {
    const r = await outil(assia, "lire_notes")({});
    expect(r.notes).toContain("# Cette semaine  ⟨titre001⟩");
    expect(r.notes).toContain("[ ] Valider le budget du congrès d'Oran  ⟨ligne001⟩");
    expect((r.pages as { page: string }[])[0].page).toBe("Mes notes");
  });

  it("PRIVÉ : un collègue, et le Super Admin, ne lisent que LEURS notes (vides) — jamais celles d'Assia", async () => {
    for (const u of [karim, admin]) {
      const r = await outil(u, "lire_notes")({});
      expect(JSON.stringify(r)).not.toContain("congrès d'Oran");
      // Aucun paramètre ne désigne un autre compte : même la page d'Assia par sa référence reste introuvable.
      const parRef = await outil(u, "lire_notes")({ page: pageId });
      expect(parRef.statut).toBe("INTROUVABLE");
      expect(await lirePage(u.id, pageId)).toBeNull();
    }
  });

  it("PRIVÉ : en « Vue exacte » (le Super Admin visualise l'OS comme Assia), outils et actions refusent", async () => {
    const vue = { ...assia, impersonatedBy: { id: admin.id, name: "Admin" } } as CurrentUser;
    expect((await outil(vue, "lire_notes")({})).statut).toBe("REFUS");
    expect((await outil(vue, "ajouter_note")({ texte: "x" })).statut).toBe("REFUS");
    session.user = vue;
    expect(await etatMesNotes()).toMatchObject({ ok: false });
    expect(await enregistrerMaPage(pageId, 1, "[]")).toMatchObject({ ok: false });
    session.user = { ...assia, visualise: { id: assia.id, name: "Assia" } } as CurrentUser;
    expect(await etatMesNotes()).toMatchObject({ ok: false });
    // Le Super Admin, en son nom, n'atteint que SES notes : la page d'Assia n'est pas dans son état.
    session.user = admin;
    const etat = await etatMesNotes(pageId);
    expect(etat.ok).toBe(true);
    expect(etat.page?.id).not.toBe(pageId);
    expect(JSON.stringify(etat)).not.toContain("congrès d'Oran");
  });

  it("un montant d'une ligne de paie part au modèle en REPÈRE ⟦Sn⟧ — la personne, titulaire, le revoit", async () => {
    const coffret = new CoffretDuTour();
    const r = await outil(assia, "lire_notes", { coffret })({});
    expect(r.notes).not.toContain("40 000");
    expect(r.notes).toMatch(/Prime de Karim : ⟦S\d+⟧ à confirmer/);
    expect(coffret.entree(1)).toMatchObject({ valeur: "40 000 DA", titulaireUserId: assia.id });
    // Sans coffret (une routine) : masqué.
    const sans = await outil(assia, "lire_notes")({});
    expect(sans.notes).toContain("[confidentiel]");
  });

  it("L'IA N'ÉCRIT RIEN : « ajoute X » est une PROPOSITION — la page est intacte tant que la personne n'a pas accepté", async () => {
    const avant = (await lirePage(assia.id, pageId))!;
    const r = await outil(assia, "ajouter_note")({ texte: "Relancer l'imprimeur pour le congrès d'Oran", sous: "Cette semaine" });
    expect(r.statut).toBe("PROPOSEE");
    expect(String(r.proposition)).toContain("sous « Cette semaine »");
    const apres = (await lirePage(assia.id, pageId))!;
    expect(apres.version).toBe(avant.version);
    expect(apres.blocs).toEqual(avant.blocs);
    expect(await enAttente(assia)).toHaveLength(1);
  });

  it("REFUSER : rien n'est écrit", async () => {
    const [p] = await enAttente(assia);
    const avant = (await lirePage(assia.id, pageId))!;
    expect((await refuser(assia.id, p.id)).ok).toBe(true);
    expect((await lirePage(assia.id, pageId))!.blocs).toEqual(avant.blocs);
    // Un collègue ne peut ni accepter ni refuser la proposition d'Assia.
    expect((await accepter(karim.id, p.id)).ok).toBe(false);
  });

  it("ACCEPTER : la ligne arrive sous son titre, l'état d'avant est gardé en version ; ANNULER la retire", async () => {
    await outil(assia, "ajouter_note")({ texte: "Relancer l'imprimeur", sous: "Cette semaine" });
    const [p] = await enAttente(assia);
    // Un autre compte n'accepte pas à sa place (ni par l'action) :
    session.user = karim;
    expect(await accepterPropositionNote(p.id)).toMatchObject({ ok: false });
    session.user = assia;
    expect(await accepterPropositionNote(p.id)).toMatchObject({ ok: true });
    const page = (await lirePage(assia.id, pageId))!;
    expect(page.blocs.map((b) => b.texte).slice(0, 4)).toEqual(["Cette semaine", "Valider le budget du congrès d'Oran", "Prime de Karim : 40 000 DA à confirmer", "Relancer l'imprimeur"]);
    expect(page.blocs[3].type).toBe("tache");
    expect((await listerVersions(assia.id, pageId)).some((v) => v.auteur === "IA")).toBe(true);
    expect((await annuler(assia.id, p.id)).ok).toBe(true);
    expect((await lirePage(assia.id, pageId))!.blocs.map((b) => b.texte)).not.toContain("Relancer l'imprimeur");
    // Une ligne de l'assistant annulée ne va pas à la corbeille.
    expect((await lireCorbeille(assia.id)).lignes.map((l) => l.texte)).not.toContain("Relancer l'imprimeur");
  });

  it("une désignation ambiguë revient avec ses candidates ; jamais devinée", async () => {
    const r = await outil(assia, "cocher_note")({ ligne: "on" });
    expect(r.statut).toBe("AMBIGU");
    expect((r.candidats as unknown[]).length).toBeGreaterThan(1);
    expect(await enAttente(assia)).toHaveLength(0);
  });

  it("TOUT ACCEPTER : une page proposée puis une ligne dedans — la dépendance passe d'abord", async () => {
    expect((await outil(assia, "creer_page")({ titre: "Congrès d'Oran" })).statut).toBe("PROPOSEE");
    const r = await outil(assia, "ajouter_note")({ page: "Congrès d'Oran", texte: "[] Réserver la salle" });
    expect(r.statut).toBe("PROPOSEE");
    const [, ligne] = await enAttente(assia);
    expect(ligne.dependDe).toHaveLength(1);
    const t = await toutAccepter(assia.id);
    expect(t.echecs).toEqual([]);
    const pages = await listerPages(assia.id);
    const oran = pages.find((p) => p.titre === "Congrès d'Oran")!;
    expect((await lirePage(assia.id, oran.id))!.blocs).toMatchObject([{ type: "tache", texte: "Réserver la salle", fait: false }]);
  });

  it("refuser une page proposée refuse aussi les lignes qui s'y appuient", async () => {
    await outil(assia, "creer_page")({ titre: "Idées 2027" });
    await outil(assia, "ajouter_note")({ page: "Idées 2027", texte: "Webinaire" });
    const [page] = await enAttente(assia);
    expect((await refuser(assia.id, page.id)).refusees).toHaveLength(2);
    expect((await listerPages(assia.id)).map((p) => p.titre)).not.toContain("Idées 2027");
  });

  it("l'enregistrement automatique ne s'écrase pas (version) ; une ligne supprimée revient de la corbeille", async () => {
    const p = (await lirePage(assia.id, pageId))!;
    const sans = p.blocs.filter((b) => b.id !== "ligne003");
    const e = await ecrirePage(assia.id, pageId, p.version, sans);
    expect(e.ok).toBe(true);
    const conflit = await ecrirePage(assia.id, pageId, p.version, p.blocs);
    expect(conflit).toMatchObject({ ok: false });
    const corbeille = await lireCorbeille(assia.id);
    const ligne = corbeille.lignes.find((l) => l.texte === "Kakémonos pour le symposium")!;
    expect(ligne.joursRestants).toBe(30);
    expect((await restaurerLigne(assia.id, ligne.id)).ok).toBe(true);
    expect((await lirePage(assia.id, pageId))!.blocs.map((b) => b.texte)).toContain("Kakémonos pour le symposium");
  });

  it("UN VRAI TOUR au faux modèle : « ajoute X » → proposition sur la carte du tour, page intacte ; le modèle n'a pas lu les notes pour un bonjour", async () => {
    remplacerReglagesPourTests({ retirerCartesCaduques: false } as never);
    const f = modeleFactice([
      { appel: { outil: "ajouter_note", entree: { texte: "Appeler l'agence de voyage", sous: "Cette semaine" } } },
      { texte: JSON.stringify({ message: "Je vous propose d'ajouter « Appeler l'agence de voyage » sous « Cette semaine ».", components: [] }) },
    ]);
    remplacerModelesPourTests([f.modele as never]);
    const avant = (await lirePage(assia.id, pageId))!;
    const r = await jouerTour(assia, { texte: "Ajoute « appeler l'agence de voyage » à ma liste de la semaine", pieces: [], historique: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.notesProposees).toHaveLength(1);
    expect((await lirePage(assia.id, pageId))!.blocs).toEqual(avant.blocs);
    // lire_notes et ajouter_note font partie des outils PRÉSÉLECTIONNÉS par cette demande…
    expect(f.outilsRecus[0]).toEqual(expect.arrayContaining(["ajouter_note"]));

    const b = modeleFactice([{ texte: JSON.stringify({ message: "Bonjour !", components: [] }) }]);
    remplacerModelesPourTests([b.modele as never]);
    await jouerTour(assia, { texte: "Bonjour, quel temps fait-il à Alger ?", pieces: [], historique: [] });
    // … mais pas d'une question qui ne s'y rapporte pas.
    expect(b.outilsRecus[0]).not.toContain("lire_notes");
  });
});
