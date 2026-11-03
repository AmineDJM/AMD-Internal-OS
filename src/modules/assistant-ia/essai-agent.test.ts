import "@/lib/async-local-storage-global";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => undefined }));

import { prisma } from "@/lib/prisma";
import { getCurrentUser, identiteDonneesDe } from "@/lib/session";
import { getAccess } from "@/lib/rbac";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { remplacerLecteurInterrupteurIaPourTests } from "@/lib/ai-settings";
import { avecIdentiteDonnees, contexteDonnees, estSysteme } from "@/platform/donnees/contexte";
import { remplacerModelesPourTests } from "./infra/generer";
import { remplacerReglagesPourTests } from "./infra/consommation";
import { modeleFactice, type EtapeScenario } from "./infra/testing/modele-factice";
import { effacerJournalDe } from "./infra/testing/journal";
import { deposerMessage, nouvelleConversation, traiterFil } from "./infra/fil/service";
import { jouerTour } from "./infra/fil/tour";
import { essayerAgentDe } from "./infra/essai/service";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « ESSAYER L'AGENT DE… » DIT EXACTEMENT CE QUE LA PERSONNE AURA — ni plus, ni moins (Direction, 03/11/2026).
 *
 * La demande : « que la personne n'ait pas accès en production à des données que je n'ai pas vues à l'essai ». D'où :
 *
 *   • PARITÉ — le même message joué par son vrai chemin (dépôt, fil, tour) et par l'essai : le modèle reçoit le MÊME
 *     prompt (sa consigne, son profil, ses droits, le résultat de ses outils) et les MÊMES outils, au mot près ;
 *   • AUTRUI — la paie d'une autre personne, refusée à l'essai exactement comme en production — alors que le Super Admin
 *     qui lance l'essai, lui, la verrait (témoin) : l'essai n'emprunte jamais ses droits ;
 *   • IDENTITÉ — pendant le tour, `getCurrentUser` et la garde des données jugent la personne, même dans le corps d'une
 *     action du Super Admin ;
 *   • RIEN NE RESTE — sa conversation, ses cartes, sa consommation, ses notifications : intactes ; l'essai est à l'audit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__essaiagent_${Date.now().toString(36)}_`;
const reponse = (message: string) => ({ texte: JSON.stringify({ message, components: [] }) });
const chiffres = (s: string) => s.replace(/[\s  ]/g, "");
/** Ce qui change d'un tour à l'autre sans rien dire des droits : identifiants, horodatages (dont celui de Mastra, en ms), heures. */
const stable = (v: unknown) => JSON.stringify(v)
  .replace(/\bc[a-z0-9]{20,30}\b/g, "<id>")
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<t>")
  .replace(/\b\d{1,2}[:h]\d{2}\b/g, "<h>")
  .replace(/\b1\d{12}\b/g, "<ms>");
/** Le premier écart entre deux prompts, avec son voisinage — vide s'ils sont identiques. */
const ecart = (a: string, b: string): string => {
  if (a === b) return "";
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `à ${i} — essai : « ${a.slice(Math.max(0, i - 120), i + 200)} » / vrai : « ${b.slice(Math.max(0, i - 120), i + 200)} »`;
};

suite("Essayer l'agent d'une personne — exactement son agent", () => {
  let amine: CurrentUser;
  let radia: CurrentUser;
  let assia: CurrentUser;
  const cleAvant = process.env.OPENAI_API_KEY;

  const compte = async (role: string, nom: string, assistantIa: boolean): Promise<CurrentUser> => {
    const u = await prisma.user.create({ data: { name: `${nom} ${TAG}`, email: `${TAG}${nom.toLowerCase()}@t.dz`, passwordHash: "x", role: role as never } });
    if (assistantIa) await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
    const access = await getAccess(u.id, u.role);
    return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
  };

  /** Le VRAI chemin de la personne : son écran dépose le message dans une conversation, le fil le joue. */
  const parSonEcran = async (u: CurrentUser, texte: string) => {
    const c = await nouvelleConversation(u.id);
    if (!c.ok) throw new Error(c.erreur);
    const d = await deposerMessage(u.id, texte, [], null, c.conversation);
    if (!d.ok) throw new Error(d.erreur);
    await traiterFil(u.id, c.conversation);
    return c.conversation;
  };
  const essai = (texte: string, scenario: EtapeScenario[]) => {
    const f = modeleFactice(scenario);
    remplacerModelesPourTests([f.modele as never]);
    return { f, issue: essayerAgentDe(amine, radia.id, texte, []) };
  };

  beforeAll(async () => {
    process.env.OPENAI_API_KEY = "cle-de-banc";
    remplacerLecteurInterrupteurIaPourTests(async () => false);
    remplacerReglagesPourTests({ valeursSensibles: "EN_CLAIR" });
    amine = await compte("SUPER_ADMIN", "Amine", true);
    radia = await compte("COORDINATOR", "Radia", true);
    assia = await compte("MEDICAL_DELEGATE", "Assia", false);
    await prisma.employee.create({ data: { fullName: `Radia ${TAG}KEBIR`, userId: radia.id, position: "Assistante de direction", baseSalary: 105180, grossSalary: 180673, netToPay: 110000 } });
    await prisma.employee.create({ data: { fullName: `Assia ${TAG}ABDELAZIZ`, userId: assia.id, position: "Pharmacienne", baseSalary: 350000, netToPay: 400000, iban: "DZ5900400174401234567890" } });
  });
  afterEach(() => remplacerModelesPourTests(null));
  afterAll(async () => {
    if (cleAvant === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = cleAvant;
    remplacerLecteurInterrupteurIaPourTests(null);
    remplacerReglagesPourTests(null);
    const ids = [amine, radia, assia].filter(Boolean).map((u) => u.id);
    await prisma.accesDonneeSensible.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await effacerJournalDe(ids);
    await prisma.assistantIaFil.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.modelCallLog.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { contains: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("PARITÉ — son vrai chemin et l'essai : le modèle reçoit le même prompt et les mêmes outils, au mot près", async () => {
    const scenario: EtapeScenario[] = [{ appel: { outil: "lire_paie", entree: { nom: "moi" } } }, reponse("Votre net est de 110 000 DZD.")];
    const vrai = modeleFactice(scenario);
    remplacerModelesPourTests([vrai.modele as never]);
    await parSonEcran(radia, "Quel est mon salaire ?");
    const { f, issue } = essai("Quel est mon salaire ?", scenario);
    const r = await issue;
    expect(r.ok, r.ok ? "" : r.erreur).toBe(true);
    expect(f.promptsRecus.length).toBe(vrai.promptsRecus.length);
    expect(ecart(stable(f.promptsRecus), stable(vrai.promptsRecus)), "l'essai n'a pas envoyé au modèle ce que son vrai tour envoie").toBe("");
    expect(f.outilsRecus).toEqual(vrai.outilsRecus);
    // Ce que son écran aurait montré : la réponse du tour, rendue par la lecture même de son fil.
    if (r.ok) expect(r.tours.at(-1)).toMatchObject({ role: "assistant", etat: "TERMINE", contenu: "Votre net est de 110 000 DZD." });
    expect(chiffres(JSON.stringify(f.promptsRecus))).toContain("110000");
  });

  it("AUTRUI — la paie d'Assia est refusée à l'essai comme en production ; le Super Admin qui essaie, lui, la verrait (témoin)", async () => {
    const scenario: EtapeScenario[] = [{ appel: { outil: "lire_paie", entree: { nom: `Assia ${TAG}ABDELAZIZ` } } }, reponse("Je ne peux pas.")];
    const vrai = modeleFactice(scenario);
    remplacerModelesPourTests([vrai.modele as never]);
    await parSonEcran(radia, `Quel est le salaire d'Assia ${TAG}ABDELAZIZ ?`);
    const { f, issue } = essai(`Quel est le salaire d'Assia ${TAG}ABDELAZIZ ?`, scenario);
    expect((await issue).ok).toBe(true);
    expect(chiffres(JSON.stringify(f.promptsRecus)), "l'essai a laissé passer la paie d'autrui").not.toMatch(/400000|350000|DZ5900400174401234567890/);
    expect(ecart(stable(f.promptsRecus), stable(vrai.promptsRecus))).toBe("");
    // TÉMOIN : la même question, posée par le Super Admin lui-même — sa paie à elle lui est ouverte. L'essai n'emprunte pas ses droits.
    const sa = modeleFactice(scenario);
    remplacerModelesPourTests([sa.modele as never]);
    expect((await jouerTour(amine, { texte: `Quel est le salaire d'Assia ${TAG}ABDELAZIZ ?`, pieces: [], historique: [] })).ok).toBe(true);
    expect(chiffres(JSON.stringify(sa.promptsRecus))).toMatch(/400000/);
  });

  it("IDENTITÉ — pendant le tour, la session et la garde des données jugent la personne, même dans le corps d'une action du Super Admin", async () => {
    let vu: { session: string | null; garde: string | null } = { session: null, garde: null };
    const sonde = modeleFactice([reponse("ok")]);
    // Le modèle répond DEPUIS le tour : c'est là que la session et la garde sont lues, comme par un outil.
    const lire = async () => {
      const c = contexteDonnees();
      vu = { session: (await getCurrentUser())?.id ?? null, garde: c && !estSysteme(c) ? c.userId : null };
    };
    const generer = sonde.modele.doGenerate.bind(sonde.modele);
    sonde.modele.doGenerate = async (options: Parameters<typeof generer>[0]) => { await lire(); return generer(options); };
    const flux = sonde.modele.doStream.bind(sonde.modele);
    sonde.modele.doStream = async (options: Parameters<typeof flux>[0]) => { await lire(); return flux(options); };
    remplacerModelesPourTests([sonde.modele as never]);
    // Le corps d'une action du Super Admin : la garde y juge LUI (sa requête).
    const r = await avecIdentiteDonnees(identiteDonneesDe(amine), () => essayerAgentDe(amine, radia.id, "Bonjour", []));
    expect(r.ok, r.ok ? "" : r.erreur).toBe(true);
    expect(vu).toEqual({ session: radia.id, garde: radia.id });
  });

  it("RIEN NE RESTE chez la personne — conversation, cartes, consommation, notifications ; l'essai est à l'audit, au nom du Super Admin", async () => {
    const compter = async () => Promise.all([
      prisma.assistantIaFil.count({ where: { userId: radia.id } }),
      prisma.assistantIaTour.count({ where: { userId: radia.id } }),
      prisma.assistantActionIntent.count({ where: { userId: radia.id } }),
      prisma.modelCallLog.count({ where: { userId: radia.id } }),
      prisma.notification.count({ where: { userId: radia.id } }),
    ]);
    const avant = await compter();
    const { issue } = essai("Prépare une tâche pour relancer le fournisseur demain.", [reponse("C'est noté.")]);
    const r = await issue;
    expect(r.ok, r.ok ? "" : r.erreur).toBe(true);
    expect(await compter()).toEqual(avant);
    const audit = await prisma.auditLog.findFirst({ where: { actorId: amine.id, summary: { contains: "Essai de l'agent de" } }, orderBy: { createdAt: "desc" }, select: { summary: true } });
    expect(audit?.summary).toContain(radia.name);
    expect(audit?.summary).toContain("rien enregistré chez la personne");
  });

  it("L'HISTORIQUE DE L'ESSAI — le tour suivant relit les échanges précédents comme un fil ordinaire", async () => {
    const f = modeleFactice([reponse("Le second.")]);
    remplacerModelesPourTests([f.modele as never]);
    const r = await essayerAgentDe(amine, radia.id, "Et ensuite ?", [{ question: "Premier message de l'essai", reponse: "Première réponse de l'agent" }]);
    expect(r.ok, r.ok ? "" : r.erreur).toBe(true);
    const recu = JSON.stringify(f.promptsRecus);
    expect(recu).toContain("Premier message de l'essai");
    expect(recu).toContain("Première réponse de l'agent");
  });

  it("LA PORTE — réservé au Super Admin, jamais en « Vue exacte » ; une personne sans assistant reçoit SON refus", async () => {
    expect(await essayerAgentDe(radia, assia.id, "Bonjour", [])).toEqual({ ok: false, erreur: "Réservé au Super Admin, hors « Vue exacte »." });
    expect((await essayerAgentDe({ ...amine, visualise: { id: radia.id, name: radia.name } }, radia.id, "Bonjour", [])).ok).toBe(false);
    expect((await essayerAgentDe(amine, "inexistant", "Bonjour", [])).ok).toBe(false);
    const f = modeleFactice([reponse("ne doit pas répondre")]);
    remplacerModelesPourTests([f.modele as never]);
    const r = await essayerAgentDe(amine, assia.id, "Bonjour", []);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tours.at(-1)).toMatchObject({ role: "assistant", etat: "ECHEC" });
    expect(f.promptsRecus, "l'assistant fermé à la personne ne s'est pas ouvert à l'essai").toHaveLength(0);
  });
});
