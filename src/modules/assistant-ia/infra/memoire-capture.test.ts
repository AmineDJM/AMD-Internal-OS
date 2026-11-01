import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => undefined }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { compileContext } from "./contexte";
import { annulerSouvenir, effacerMemoire, listerMemoire, reglerMemoireAuto, souvenirsParIds, toutEffacerMemoire } from "./memoire";
import { capturerApresTour, remplacerExtracteurPourTests, type Extracteur } from "./memoire-capture";
import { remplacerModelesPourTests } from "./generer";
import { modeleFactice } from "./testing/modele-factice";
import { deposerMessage, lireFil, nouvelleConversation, traiterFil } from "./fil/service";
import { effacerJournalDe } from "./testing/journal";

/**
 * M1 (décision 0045) — LA SUPER MÉMOIRE, sur la vraie base : capture automatique (faits personnels gardés, faits d'autrui
 * refusés, mise à jour avec historique), privée = rien, annulation, réglage, RBAC, et le rappel dans une NOUVELLE
 * conversation (« tu te souviens de mon voyage ? »).
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__memauto_${Date.now().toString(36)}_`;
let moi: CurrentUser;
let autre: CurrentUser;
let admin: CurrentUser;

async function compte(nom: string, role = "DIRECTION_ASSISTANT"): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role: role as never } });
  await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

/** Un extracteur qui rend ce qu'on lui dit, et compte ses appels (le vrai : modèle rapide). */
function extracteur(sortie: unknown[]): Extracteur & { appels: string[] } {
  const appels: string[] = [];
  const f = (async (_c: string, entree: string) => { appels.push(entree); return { ok: true as const, texte: JSON.stringify({ souvenirs: sortie }) }; }) as Extracteur & { appels: string[] };
  f.appels = appels;
  return f;
}

suite("Assistant IA — la mémoire automatique (M1)", () => {
  beforeAll(async () => {
    moi = await compte("moi");
    autre = await compte("autre");
    admin = await compte("admin", "SUPER_ADMIN");
  });
  afterEach(async () => {
    remplacerModelesPourTests(null);
    remplacerExtracteurPourTests(null);
    await prisma.assistantMemoryItem.deleteMany({ where: { userId: { in: [moi.id, autre.id, admin.id] } } });
    await prisma.assistantIaPreference.deleteMany({ where: { userId: { in: [moi.id, autre.id, admin.id] } } });
  });
  afterAll(async () => {
    const ids = [moi?.id, autre?.id, admin?.id].filter(Boolean) as string[];
    await effacerJournalDe(ids);
    await prisma.assistantIaFil.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("retient d'office les faits personnels dits par la personne — et refuse ceux d'autrui lus dans l'ERP", async () => {
    const e = extracteur([
      { sorte: "VOYAGES", contenu: "Part à Lyon le 12 novembre avec sa fille Lina", sujet: "voyage:lyon" },
      { sorte: "FAMILLE", contenu: "Sa fille s'appelle Lina", sujet: "famille:fille" },
      // La réponse a cité le salaire d'un collègue : jamais retenu.
      { sorte: "PERSONNES_CITEES", contenu: "Le salaire de Karim est de 180 000 DZD", sujet: "personne:karim" },
      // Un nom que la personne n'a pas dit (lu dans la réponse) : refusé.
      { sorte: "PERSONNES_CITEES", contenu: "Travaille avec Karim Benali", sujet: "personne:karim" },
    ]);
    const b = await capturerApresTour({
      userId: moi.id, nom: moi.name, message: "Je pars à Lyon le 12 avec ma fille Lina, et je travaille avec Karim.",
      conversation: null, deps: { extraire: e },
    });
    expect(e.appels).toHaveLength(1);
    // L'extracteur ne lit que la personne : la réponse (données de l'ERP) n'y part pas.
    expect(e.appels[0]).not.toMatch(/ASSISTANT/);
    expect(b.retenus.map((r) => r.contenu)).toEqual(["Part à Lyon le 12 novembre avec sa fille Lina", "Sa fille s'appelle Lina"]);
    expect(b.refuses).toHaveLength(2);
    const liste = await listerMemoire(moi.id);
    expect(liste.map((x) => x.origine)).toEqual(["auto", "auto"]);
  });

  it("aucun appel si l'échange ne porte aucun fait durable (filtre déterministe)", async () => {
    const e = extracteur([{ sorte: "PROJETS", contenu: "x" }]);
    const b = await capturerApresTour({ userId: moi.id, message: "Montre-moi les demandes en cours.", conversation: null, deps: { extraire: e } });
    expect(b).toMatchObject({ motif: "filtre", appel: false });
    expect(e.appels).toHaveLength(0);
  });

  it("un fait qui change REMPLACE l'ancien (historique gardé) ; annuler fait revenir l'ancien", async () => {
    await capturerApresTour({ userId: moi.id, message: "Je pars à Lyon le 12.", conversation: null, deps: { extraire: extracteur([{ sorte: "VOYAGES", contenu: "Part à Lyon le 12 novembre", sujet: "voyage:lyon" }]) } });
    const e = extracteur([{ sorte: "VOYAGES", contenu: "Part à Lyon le 14 novembre", sujet: "voyage:lyon", remplace: "m1" }]);
    const b = await capturerApresTour({ userId: moi.id, message: "Finalement je pars à Lyon le 14.", conversation: null, deps: { extraire: e } });
    expect(e.appels[0]).toContain("m1. Part à Lyon le 12 novembre");
    expect(b.retenus).toMatchObject([{ geste: "remplace", contenu: "Part à Lyon le 14 novembre" }]);
    const liste = await listerMemoire(moi.id);
    expect(liste.map((x) => x.contenu)).toEqual(["Part à Lyon le 14 novembre"]);
    expect(liste[0].versionsAnterieures).toBe(1);
    expect(await prisma.assistantMemoryItem.count({ where: { userId: moi.id, active: false, remplaceLe: { not: null } } })).toBe(1);

    expect((await annulerSouvenir(moi.id, b.retenus[0].id)).ok).toBe(true);
    expect((await listerMemoire(moi.id)).map((x) => x.contenu)).toEqual(["Part à Lyon le 12 novembre"]);
    expect((await souvenirsParIds(moi.id, [b.retenus[0].id])).size).toBe(0);
  });

  it("conversation privée : rien n'est retenu, rien n'est appelé ; réglage coupé : non plus", async () => {
    const e = extracteur([{ sorte: "FAMILLE", contenu: "Sa fille s'appelle Lina" }]);
    expect((await capturerApresTour({ userId: moi.id, message: "Ma fille s'appelle Lina.", conversation: null, prive: true, deps: { extraire: e } })).motif).toBe("prive");
    await reglerMemoireAuto(moi.id, false);
    expect((await capturerApresTour({ userId: moi.id, message: "Ma fille s'appelle Lina.", conversation: null, deps: { extraire: e } })).motif).toBe("reglage");
    expect(e.appels).toHaveLength(0);
    expect(await listerMemoire(moi.id)).toEqual([]);
  });

  it("mémoire automatique coupée : la carte « Retenir » (proposer_memoire) revient, avec sa consigne", async () => {
    await reglerMemoireAuto(moi.id, false);
    const faux = modeleFactice([{ texte: JSON.stringify({ message: "Noté.", components: [] }) }]);
    remplacerModelesPourTests([faux.modele as never]);
    await nouvelleConversation(moi.id);
    await deposerMessage(moi.id, "Retiens que je préfère les tableaux.", []);
    await traiterFil(moi.id);
    expect(faux.outilsRecus[0]).toContain("proposer_memoire");
    expect(JSON.stringify(faux.promptsRecus[0])).toContain("MÉMOIRE À LA CARTE");
  });

  it("RBAC : personne ne lit, n'annule ni n'efface la mémoire d'un autre — Super Admin compris", async () => {
    await capturerApresTour({ userId: autre.id, message: "Ma femme s'appelle Sarah.", conversation: null, deps: { extraire: extracteur([{ sorte: "FAMILLE", contenu: "Sa femme s'appelle Sarah" }]) } });
    const [s] = await listerMemoire(autre.id);
    for (const u of [moi, admin]) {
      expect(await listerMemoire(u.id)).toEqual([]);
      expect((await souvenirsParIds(u.id, [s.id])).size).toBe(0);
      await annulerSouvenir(u.id, s.id);
      expect(await effacerMemoire(u.id, s.id)).toBe(false);
      expect(await toutEffacerMemoire(u.id)).toBe(0);
      const ctx = await compileContext({ user: u, question: "qui est Sarah ?" });
      expect(ctx.systemPrompt).not.toContain("Sarah");
    }
    expect((await listerMemoire(autre.id)).map((x) => x.contenu)).toEqual(["Sa femme s'appelle Sarah"]);
  });

  it("LE FIL : « je pars à Lyon le 12 avec ma fille Lina » est retenu (ligne « Retenu : … ») ; une NOUVELLE conversation s'en souvient", async () => {
    remplacerExtracteurPourTests(extracteur([{ sorte: "VOYAGES", contenu: "Part à Lyon le 12 novembre avec sa fille Lina", sujet: "voyage:lyon" }]));
    const faux = modeleFactice([
      { texte: JSON.stringify({ message: "Bon voyage à Lyon !", components: [] }) },
      { texte: JSON.stringify({ message: "Oui : Lyon, le 12 novembre, avec Lina.", components: [] }) },
    ]);
    remplacerModelesPourTests([faux.modele as never]);
    await nouvelleConversation(moi.id);
    const a = await deposerMessage(moi.id, "Je pars à Lyon le 12 avec ma fille Lina.", []);
    expect(a.ok).toBe(true);
    await traiterFil(moi.id);
    const { tours, enCours } = await lireFil(moi.id);
    expect(enCours).toBe(false);
    const r = tours.find((t) => t.role === "assistant")!;
    expect(r.memoireEtat).toBe("FAIT");
    expect((r.memoiresRetenues as { contenu: string }[])[0].contenu).toBe("Part à Lyon le 12 novembre avec sa fille Lina");
    const [souvenir] = await listerMemoire(moi.id);
    expect(souvenir.conversation?.id).toBe(r.filId);

    // Une NOUVELLE conversation : le contexte du tour porte le souvenir, trouvé par « voyage ».
    await nouvelleConversation(moi.id);
    await deposerMessage(moi.id, "Tu te souviens de mon voyage ?", []);
    await traiterFil(moi.id);
    const tour = faux.promptsRecus.map((p) => JSON.stringify(p)).filter((p) => p.includes("Tu te souviens de mon voyage")).at(0) ?? "";
    expect(tour).toContain("### MÉMOIRE DE L'INTERLOCUTEUR");
    expect(tour).toContain("Part à Lyon le 12 novembre avec sa fille Lina");
  });
});
