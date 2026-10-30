import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => undefined }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { remplacerModelesPourTests } from "../generer";
import { modeleFactice } from "../testing/modele-factice";
import { effacerJournalDe } from "../testing/journal";
import { deposerMessage, lireFil, nouvelleConversation, traiterFil } from "../fil/service";
import {
  archiverConversation, epinglerConversation, listerConversations, purgerConversationsPrivees, rechercherConversations,
  reglerPrive, renommerConversation, supprimerConversation,
} from "./service";
import { ajouterDocuments, creerDossier, modifierDossier, sectionDossierDuTour } from "./dossiers";
import { outilConversationsPassees } from "./outil";

/**
 * ADVENTUM IA — LES CONVERSATIONS (décision 0027), sur la vraie base et au faux modèle : plusieurs conversations,
 * titre proposé, privée verrouillée après le premier message, mémoire ni lue ni écrite en privée, suppression à
 * 30 jours, dossiers (consignes et documents appliqués, droits relus), recherche, migration (le fil existant conservé).
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__aia_conv_${Date.now().toString(36)}_`;
let moi: CurrentUser;
let collegue: CurrentUser;

async function compte(nom: string): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role: "DIRECTION_ASSISTANT" } });
  await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

const reponse = (message: string) => ({ texte: JSON.stringify({ message, components: [] }) });
const SOUVENIR = "Mon comité de direction a lieu le jeudi à 10 h";

suite("Adventum IA — conversations multiples, privées, dossiers (vraie base)", () => {
  beforeAll(async () => {
    moi = await compte("moi");
    collegue = await compte("collegue");
    await prisma.assistantMemoryItem.create({ data: { userId: moi.id, type: "WORKING_STYLE", content: SOUVENIR } });
  }, 60_000);
  afterEach(() => remplacerModelesPourTests(null));
  afterAll(async () => {
    const ids = [moi?.id, collegue?.id].filter(Boolean) as string[];
    await effacerJournalDe(ids);
    await prisma.assistantIaFil.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.assistantIaDossier.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("plusieurs conversations : chacune son fil, titre provisoire puis titre proposé par le modèle rapide", async () => {
    // Réponse de la conversation, puis le titre (modèle rapide).
    remplacerModelesPourTests([modeleFactice([reponse("Il reste 1 240 000 DZD."), { texte: "« Budget congrès d'Oran »." }]).modele as never]);
    const a = await deposerMessage(moi.id, "Combien il reste sur l'enveloppe du congrès d'Oran ?", []);
    if (!a.ok) throw new Error(a.erreur);
    expect((await prisma.assistantIaFil.findUniqueOrThrow({ where: { id: a.conversation } })).titre).toBe("Combien il reste sur l'enveloppe du…");
    await traiterFil(moi.id, a.conversation);
    const fil = await prisma.assistantIaFil.findUniqueOrThrow({ where: { id: a.conversation } });
    expect([fil.titre, fil.titreSource]).toEqual(["Budget congrès d'Oran", "auto"]);

    // Une deuxième conversation : son fil ne voit pas le premier.
    const n = await nouvelleConversation(moi.id);
    if (!n.ok) throw new Error(n.erreur);
    const faux = modeleFactice([reponse("Déposé le 12/10."), { texte: "Dossier daclatasvir" }]);
    remplacerModelesPourTests([faux.modele as never]);
    const b = await deposerMessage(moi.id, "Où en est le dossier daclatasvir ?", [], null, n.conversation);
    if (!b.ok) throw new Error(b.erreur);
    await traiterFil(moi.id, n.conversation);
    expect(JSON.stringify(faux.promptsRecus[0])).not.toContain("congrès d'Oran");
    expect((await lireFil(moi.id, 80, a.conversation)).tours).toHaveLength(2);
    expect((await lireFil(moi.id, 80, n.conversation)).tours).toHaveLength(2);

    const liste = await listerConversations(moi.id);
    expect(liste.map((c) => c.titre)).toEqual(["Dossier daclatasvir", "Budget congrès d'Oran"]);
  }, 60_000);

  it("renommer (le modèle ne l'écrase plus), épingler, archiver, rechercher (titres ET contenu), supprimer", async () => {
    const [c] = await listerConversations(moi.id);
    expect(await renommerConversation(moi.id, c.id, "  « Daclatasvir — ANPP »  ")).toEqual({ ok: true });
    expect(await epinglerConversation(moi.id, c.id, true)).toEqual({ ok: true });
    let liste = await listerConversations(moi.id);
    expect(liste.find((x) => x.id === c.id)).toMatchObject({ titre: "Daclatasvir — ANPP", epingle: true });

    expect((await rechercherConversations(moi.id, "anpp")).map((x) => x.id)).toContain(c.id);
    const parContenu = await rechercherConversations(moi.id, "1 240 000");
    expect(parContenu[0]).toMatchObject({ titre: "Budget congrès d'Oran" });
    expect(parContenu[0].extrait).toContain("1 240 000");
    // Jamais les conversations d'un collègue.
    expect(await rechercherConversations(collegue.id, "Oran")).toEqual([]);
    expect(await renommerConversation(collegue.id, c.id, "piraté")).toEqual({ ok: false, erreur: "Conversation introuvable." });

    expect(await archiverConversation(moi.id, c.id, true)).toEqual({ ok: true });
    liste = await listerConversations(moi.id);
    expect(liste.map((x) => x.id)).not.toContain(c.id);
    expect((await listerConversations(moi.id, { archivees: true })).map((x) => x.id)).toContain(c.id);

    expect(await supprimerConversation(collegue.id, c.id)).toEqual({ ok: false, erreur: "Conversation introuvable." });
    expect(await supprimerConversation(moi.id, c.id)).toEqual({ ok: true });
    expect(await prisma.assistantIaTour.count({ where: { filId: c.id } })).toBe(0);
  });

  it("PRIVÉE : choisie à la création, verrouillée dès le premier message ; ni mémoire lue, ni « Retenir », ni conversations passées", async () => {
    const n = await nouvelleConversation(moi.id);
    if (!n.ok) throw new Error(n.erreur);
    // Avant le premier message : réglable dans les deux sens.
    expect(await reglerPrive(moi.id, n.conversation, true)).toEqual({ ok: true });
    expect(await reglerPrive(moi.id, n.conversation, false)).toEqual({ ok: true });
    expect(await reglerPrive(moi.id, n.conversation, true)).toEqual({ ok: true });

    const faux = modeleFactice([reponse("Bien noté pour cette fois."), { texte: "Question confidentielle" }]);
    remplacerModelesPourTests([faux.modele as never]);
    const d = await deposerMessage(moi.id, "Retiens que je préfère les tableaux. Quand a lieu mon comité ?", [], null, n.conversation);
    if (!d.ok) throw new Error(d.erreur);
    await traiterFil(moi.id, n.conversation);

    const envoye = JSON.stringify(faux.promptsRecus[0]);
    expect(envoye).not.toContain(SOUVENIR);
    expect(envoye).toContain("CONVERSATION PRIVÉE");
    expect(faux.outilsRecus[0]).not.toContain("proposer_memoire");
    expect(faux.outilsRecus[0]).not.toContain("chercher_conversations");

    // Commencée : elle ne peut plus cesser d'être privée — ni l'inverse pour une conversation ordinaire.
    expect((await reglerPrive(moi.id, n.conversation, false)).ok).toBe(false);
    expect((await prisma.assistantIaFil.findUniqueOrThrow({ where: { id: n.conversation } })).prive).toBe(true);
    const [ordinaire] = await listerConversations(moi.id).then((l) => l.filter((c) => !c.prive));
    expect(await reglerPrive(moi.id, ordinaire.id, true)).toMatchObject({ ok: false, erreur: expect.stringMatching(/ne peut plus devenir privée/) });

    // Une conversation ORDINAIRE, elle, lit la mémoire commune et peut proposer d'en retenir.
    const faux2 = modeleFactice([reponse("Jeudi à 10 h."), { texte: "Comité" }]);
    remplacerModelesPourTests([faux2.modele as never]);
    const o = await nouvelleConversation(moi.id);
    if (!o.ok) throw new Error(o.erreur);
    await deposerMessage(moi.id, "Quand a lieu mon comité de direction ?", [], null, o.conversation);
    await traiterFil(moi.id, o.conversation);
    expect(JSON.stringify(faux2.promptsRecus[0])).toContain(SOUVENIR);
    expect(faux2.outilsRecus[0]).toContain("proposer_memoire");
  }, 60_000);

  it("la mémoire des conversations passées : les siennes seulement, jamais une privée ni celle en cours", async () => {
    const outil = outilConversationsPassees(moi, null);
    const r = JSON.parse(await outil.run({ recherche: "comité" }, moi)) as { statut: string; extraits?: { titre: string; extrait: string }[] };
    expect(r.statut).toBe("OK");
    expect(r.extraits!.some((e) => /Comité/.test(e.titre))).toBe(true);
    // Le message de la conversation privée (« Retiens que je préfère les tableaux ») n'y est jamais.
    expect(JSON.stringify(r)).not.toContain("tableaux");
    expect(JSON.parse(await outilConversationsPassees(collegue, null).run({ recherche: "comité" }, collegue)).statut).toBe("AUCUN_RESULTAT");
  });

  it("une conversation privée est supprimée 30 jours après sa création — pas avant, et jamais une ordinaire", async () => {
    const vieille = await prisma.assistantIaFil.create({ data: { userId: moi.id, prive: true, titre: "Vieille", createdAt: new Date(Date.now() - 31 * 86_400_000) } });
    const recente = await prisma.assistantIaFil.create({ data: { userId: moi.id, prive: true, titre: "Récente", createdAt: new Date(Date.now() - 29 * 86_400_000) } });
    const ordinaire = await prisma.assistantIaFil.create({ data: { userId: moi.id, titre: "Ancienne ordinaire", createdAt: new Date(Date.now() - 90 * 86_400_000) } });
    await purgerConversationsPrivees();
    const restantes = (await prisma.assistantIaFil.findMany({ where: { id: { in: [vieille.id, recente.id, ordinaire.id] } } })).map((f) => f.titre);
    expect(restantes.sort()).toEqual(["Ancienne ordinaire", "Récente"]);
  });

  it("DOSSIER : ses consignes et ses documents (ouvrables) s'appliquent à chaque tour ; un document hors droits n'entre pas", async () => {
    const d = await creerDossier(moi.id, "Congrès");
    if (!d.ok) throw new Error(d.erreur);
    await modifierDossier(moi.id, d.dossier.id, { consignes: "Réponds toujours en tableau, montants en DZD." });
    const mien = await prisma.driveNode.create({ data: { name: `${TAG}programme-oran.pdf`, type: "FILE", ownerId: moi.id, createdById: moi.id, mimeType: "application/pdf", size: 10 } });
    const sien = await prisma.driveNode.create({ data: { name: `${TAG}salaires.xlsx`, type: "FILE", ownerId: collegue.id, createdById: collegue.id, mimeType: "application/pdf", size: 10 } });
    const ajout = await ajouterDocuments(moi, d.dossier.id, [mien.id, sien.id]);
    expect(ajout).toMatchObject({ ok: true, refuses: 1, documents: [{ id: mien.id, nom: `${TAG}programme-oran.pdf` }] });
    // Un collègue ne range rien dans MON dossier.
    expect((await ajouterDocuments(collegue, d.dossier.id, [sien.id])).ok).toBe(false);

    const n = await nouvelleConversation(moi.id, { dossierId: d.dossier.id });
    if (!n.ok) throw new Error(n.erreur);
    const faux = modeleFactice([reponse("| Poste | Montant |"), { texte: "Congrès Oran" }]);
    remplacerModelesPourTests([faux.modele as never]);
    await deposerMessage(moi.id, "Fais le point sur le congrès", [], null, n.conversation);
    await traiterFil(moi.id, n.conversation);
    const envoye = JSON.stringify(faux.promptsRecus[0]);
    expect(envoye).toContain("DOSSIER « Congrès »");
    expect(envoye).toContain("Réponds toujours en tableau");
    expect(envoye).toContain(mien.id);
    expect(envoye).not.toContain(sien.id);

    // Les droits sont RELUS à chaque tour : le document parti à la corbeille n'est plus nommé.
    await prisma.driveNode.update({ where: { id: mien.id }, data: { isTrashed: true } });
    expect(await sectionDossierDuTour(moi, d.dossier.id)).not.toContain(mien.id);
    // Le dossier d'un autre ne donne rien.
    expect(await sectionDossierDuTour(collegue, d.dossier.id)).toBeNull();
  }, 60_000);

  it("MIGRATION : rejouée, elle conserve le fil existant (ses tours), lui donne un titre, et lève l'unicité", async () => {
    const ancien = await prisma.assistantIaFil.create({ data: { userId: collegue.id } });
    await prisma.assistantIaTour.create({ data: { filId: ancien.id, userId: collegue.id, role: "user", etat: "TRAITE", contenu: "Bonjour" } });
    await prisma.assistantIaFil.update({ where: { id: ancien.id }, data: { titre: null } });
    const sql = fs.readFileSync(path.join(process.cwd(), "prisma/migrations/20270210100000_adventum_ia_conversations/migration.sql"), "utf8");
    for (const instruction of instructions(sql)) await prisma.$executeRawUnsafe(instruction);
    const apres = await prisma.assistantIaFil.findUniqueOrThrow({ where: { id: ancien.id }, include: { tours: true } });
    expect(apres.titre).toBe("Ma conversation");
    expect(apres.tours.map((t) => t.contenu)).toEqual(["Bonjour"]);
    // Deux conversations pour la même personne : l'unicité est bien levée.
    await expect(prisma.assistantIaFil.create({ data: { userId: collegue.id } })).resolves.toBeTruthy();
  });
});

/** Découpe un script SQL en instructions, sans couper un bloc `DO $$ … $$`. */
function instructions(sql: string): string[] {
  const sansCommentaires = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const out: string[] = [];
  let courant = "";
  let dansBloc = false;
  for (const ligne of sansCommentaires.split("\n")) {
    courant += `${ligne}\n`;
    if ((ligne.match(/\$\$/g) ?? []).length % 2 === 1) dansBloc = !dansBloc;
    if (!dansBloc && ligne.trim().endsWith(";")) { if (courant.trim()) out.push(courant.trim()); courant = ""; }
  }
  return out;
}
