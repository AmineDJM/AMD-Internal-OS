import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => undefined }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { remplacerModelesPourTests } from "@/lib/agent/generer";
import { modeleFactice } from "@/lib/agent/testing/modele-factice";
import { deposerMessage, ETAT, lireFil, nouvelleConversation, reprendreLesFils, traiterFil } from "@/lib/agent/fil/service";

/**
 * LE FIL GARDÉ DE L'ASSISTANT IA — rien ne s'efface en quittant l'écran ; deux messages d'affilée
 * sont traités l'un après l'autre, le second voit le premier ; la personne absente est notifiée ;
 * un tour interrompu (redémarrage) est repris ; un droit retiré se dit.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__iafil_${Date.now().toString(36)}_`;
let assistante: CurrentUser;
let sansAcces: CurrentUser;

async function compte(nom: string, ouvrir: boolean): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role: "DIRECTION_ASSISTANT" } });
  if (ouvrir) await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

const reponse = (message: string) => ({ texte: JSON.stringify({ message, components: [] }) });

suite("Assistant IA — le fil gardé, joué en arrière-plan", () => {
  beforeAll(async () => {
    assistante = await compte("assistante", true);
    sansAcces = await compte("sans", false);
  });
  afterEach(() => remplacerModelesPourTests(null));
  afterAll(async () => {
    const ids = [assistante?.id, sansAcces?.id].filter(Boolean) as string[];
    await prisma.assistantIaFil.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("deux messages d'affilée : aucun n'est annulé, ils sont répondus dans l'ordre, le second voit le premier", async () => {
    const faux = modeleFactice([reponse("Réponse au premier."), reponse("Réponse au second.")]);
    remplacerModelesPourTests([faux.modele as never]);
    const a = await deposerMessage(assistante.id, "Premier : liste mes demandes en cours.", []);
    const b = await deposerMessage(assistante.id, "Second : et celles de la semaine dernière ?", []);
    expect(a.ok && b.ok).toBe(true);
    await traiterFil(assistante.id);

    const { tours, enCours } = await lireFil(assistante.id);
    expect(enCours).toBe(false);
    expect(tours.map((t) => [t.role, t.etat, t.contenu])).toEqual([
      ["user", ETAT.TRAITE, "Premier : liste mes demandes en cours."],
      ["assistant", ETAT.TERMINE, "Réponse au premier."],
      ["user", ETAT.TRAITE, "Second : et celles de la semaine dernière ?"],
      ["assistant", ETAT.TERMINE, "Réponse au second."],
    ]);
    // Le second tour a reçu le premier échange en contexte.
    const second = JSON.stringify(faux.promptsRecus[1]);
    expect(second).toContain("Premier : liste mes demandes en cours.");
    expect(second).toContain("Réponse au premier.");
  });

  it("quitter l'écran n'efface rien : le fil se relit tel quel", async () => {
    const { tours } = await lireFil(assistante.id);
    expect(tours.filter((t) => t.role === "user")).toHaveLength(2);
  });

  it("la personne ailleurs est NOTIFIÉE quand la réponse est prête ; présente, elle ne l'est pas", async () => {
    remplacerModelesPourTests([modeleFactice([reponse("Voici le rapport demandé.")]).modele as never]);
    await deposerMessage(assistante.id, "Prépare un rapport des congrès.", []);
    await prisma.assistantIaFil.update({ where: { userId: assistante.id }, data: { consulteLe: new Date(Date.now() - 60_000) } });
    await traiterFil(assistante.id);
    const notes = await prisma.notification.findMany({ where: { userId: assistante.id } });
    expect(notes.map((n) => n.title)).toEqual([expect.stringMatching(/Assistant IA : réponse prête/)]);
    expect(notes[0].link).toBe("/assistant");

    remplacerModelesPourTests([modeleFactice([reponse("Encore là.")]).modele as never]);
    await deposerMessage(assistante.id, "Merci.", []); // déposer = être sur l'écran
    await traiterFil(assistante.id);
    expect(await prisma.notification.count({ where: { userId: assistante.id } })).toBe(1);
  });

  it("un tour interrompu (redémarrage) est repris par le balayage", async () => {
    const r = await deposerMessage(assistante.id, "Résume mes validations.", []);
    if (!r.ok) throw new Error(r.erreur);
    const fil = await prisma.assistantIaFil.findUniqueOrThrow({ where: { userId: assistante.id } });
    // État laissé par un serveur tombé en plein tour : message EN_COURS, réponse partielle, prise périmée.
    await prisma.assistantIaTour.update({ where: { id: r.tour.id }, data: { etat: ETAT.COURS, createdAt: new Date(Date.now() - 60_000) } });
    await prisma.assistantIaTour.create({ data: { filId: fil.id, userId: assistante.id, role: "assistant", contenu: "Je regarde vos valid", etat: ETAT.COURS, repondA: r.tour.id } });
    await prisma.assistantIaFil.update({ where: { id: fil.id }, data: { traitementLe: new Date(Date.now() - 11 * 60_000) } });

    remplacerModelesPourTests([modeleFactice([reponse("Trois validations attendent.")]).modele as never]);
    expect((await reprendreLesFils(new Date(), 5, true)).relances).toBeGreaterThanOrEqual(1);
    const { tours } = await lireFil(assistante.id);
    const fin = tours.filter((t) => t.repondA === r.tour.id);
    expect(fin.map((t) => t.etat).sort()).toEqual([ETAT.ECHEC, ETAT.TERMINE]);
    expect(fin.find((t) => t.etat === ETAT.TERMINE)?.contenu).toBe("Trois validations attendent.");
  });

  it("« Nouvelle conversation » : rien n'est supprimé, mais le contexte repart de zéro", async () => {
    expect(await nouvelleConversation(assistante.id)).toEqual({ ok: true });
    expect((await lireFil(assistante.id)).tours).toHaveLength(0);
    const faux = modeleFactice([reponse("Bonjour.")]);
    remplacerModelesPourTests([faux.modele as never]);
    await deposerMessage(assistante.id, "Bonjour", []);
    await traiterFil(assistante.id);
    expect(JSON.stringify(faux.promptsRecus[0])).not.toContain("Premier : liste mes demandes en cours.");
    expect(await prisma.assistantIaTour.count({ where: { userId: assistante.id, contenu: "Premier : liste mes demandes en cours." } })).toBe(1);
  });

  it("un assistant non ouvert : le tour échoue et le DIT, sans appeler le modèle", async () => {
    const faux = modeleFactice([reponse("ne doit pas être appelé")]);
    remplacerModelesPourTests([faux.modele as never]);
    await deposerMessage(sansAcces.id, "Bonjour", []);
    await traiterFil(sansAcces.id);
    const { tours } = await lireFil(sansAcces.id);
    expect(tours.map((t) => t.etat)).toEqual([ETAT.ECHEC, ETAT.ECHEC]);
    expect(faux.promptsRecus).toHaveLength(0);
  });
});
