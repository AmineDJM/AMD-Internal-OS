import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => undefined }));
// L'action métier relit la session de la requête : hors requête (banc), c'est la personne du scénario.
let ACTEUR: unknown = null;
vi.mock("@/lib/session", async (original) => ({ ...(await original<typeof import("@/lib/session")>()), requireUser: async () => ACTEUR, getCurrentUser: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { remplacerLecteurInterrupteurIaPourTests } from "@/lib/ai-settings";
import { outilsV1, type PropositionPreparee } from "../outils-v1";
import { remplacerModelesPourTests } from "../generer";
import { modeleFactice } from "../testing/modele-factice";
import { effacerJournalDe } from "../testing/journal";
import { ETAT, filDe, traiterFil } from "../fil/service";
import { enregistrerSessionVoix, fermerSessionVoix, reprisesOrales, resumeCarteDit, suivreTravailVocal, traiterEnonceVocal, type SuiviOral } from "./oral";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA VOIX ENTIÈREMENT ORALE, CONTRE LA VRAIE BASE (lot K9, décision 0038) — scénarios oraux scriptés : les énoncés
 * sont ce que la transcription d'entrée de la session aurait rendu (le crédit du fournisseur est épuisé ; le flux
 * d'événements du navigateur est rejoué par `platform/ia/voix/voix.test.ts`).
 *
 *   • une carte se conclut à l'oral : champ demandé et rempli par la voix (une référence résolue par NOM, sous les droits),
 *     résumé DIT, puis « ok fais-le » → la tâche est créée par la même porte que le bouton ; « annule » la défait ;
 *   • garde-fous SERVEUR : session étrangère, résumé pas encore dit, énoncé non affirmatif, intention modifiée depuis
 *     le résumé → rien n'est exécuté ;
 *   • la délégation asynchrone : une précision dite pendant le travail est TRANSMISE (ajoutée au message s'il attend,
 *     relance ciblée qui repart du résultat s'il est en cours) ; le résultat dépassé n'est pas dit ; après la session,
 *     le résultat est dit à l'ouverture suivante.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__iaoral_${Date.now().toString(36)}_`;
let sa: CurrentUser;
let samia: CurrentUser;
let autre: CurrentUser;
const cleAvant = process.env.OPENAI_API_KEY;
const S = `live_${TAG}sa`;
const reponse = (message: string) => ({ texte: JSON.stringify({ message, components: [] }) });

async function compte(nom: string, role: "SUPER_ADMIN" | "VIEWER"): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${nom} ${TAG}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role } });
  await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ALL" } }).catch(() => {});
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

/** Une carte « créer une tâche » préparée par l'outil réel, déposée dans le fil comme le ferait un tour. */
async function carteTache(entree: Record<string, unknown>): Promise<string> {
  const props: PropositionPreparee[] = [];
  const o = outilsV1(sa, props, [], [], null, undefined, { capacites: true }).find((t) => t.def.name === "task__createTask")!;
  await o.run(entree, sa);
  const p = props[0]!;
  const fil = await filDe(sa.id);
  const q = await prisma.assistantIaTour.create({ data: { filId: fil.id, userId: sa.id, role: "user", contenu: "[Conversation vocale] crée la tâche", etat: ETAT.TRAITE } });
  await prisma.assistantIaTour.create({
    data: {
      filId: fil.id, userId: sa.id, role: "assistant", contenu: "Je prépare la tâche.", etat: ETAT.TERMINE, repondA: q.id,
      intent: { id: p.intentId, kind: p.proposition.kind, title: p.proposition.title, fields: p.proposition.fields, formulaire: p.proposition.formulaire, status: "PROPOSED" } as never,
    },
  });
  await prisma.assistantIaVoixTravail.create({ data: { userId: sa.id, session: S, conversation: fil.id, tourId: q.id } });
  return p.intentId;
}

async function suivreJusquAuBout(u: CurrentUser, session: string, travail: string): Promise<SuiviOral> {
  for (let i = 0; i < 200; i++) {
    const s = await suivreTravailVocal(u, session, travail);
    if (s.etat !== "en_cours") return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("travail jamais terminé");
}

suite("Assistant IA — la voix entièrement orale (K9)", () => {
  beforeAll(async () => {
    process.env.OPENAI_API_KEY = "cle-de-banc";
    remplacerLecteurInterrupteurIaPourTests(async () => false);
    sa = await compte("Admin", "SUPER_ADMIN");
    ACTEUR = sa;
    samia = await compte("Samia", "VIEWER");
    autre = await compte("Autre", "SUPER_ADMIN");
    await enregistrerSessionVoix(sa.id, S, null);
    await enregistrerSessionVoix(autre.id, `live_${TAG}autre`, null);
  });
  afterEach(() => remplacerModelesPourTests(null));
  afterAll(async () => {
    if (cleAvant === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = cleAvant;
    remplacerLecteurInterrupteurIaPourTests(null);
    const ids = [sa?.id, samia?.id, autre?.id].filter(Boolean) as string[];
    await effacerJournalDe(ids);
    await prisma.task.deleteMany({ where: { title: { contains: TAG } } }).catch(() => {});
    await prisma.assistantIaVoixCarte.deleteMany({ where: { userId: { in: ids } } });
    await prisma.assistantIaVoixTravail.deleteMany({ where: { userId: { in: ids } } });
    await prisma.assistantIaVoixSession.deleteMany({ where: { userId: { in: ids } } });
    await prisma.assistantGesteJournal.deleteMany({ where: { principalId: { in: ids } } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.assistantIaFil.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("la carte de bout en bout à l'oral : résumé, champ dit (référence par NOM), « vas-y » après le résumé dit → exécutée ; « annule » la défait", async () => {
    const intentId = await carteTache({ title: `Stand ${TAG}` });
    const w = await prisma.assistantIaVoixTravail.findFirstOrThrow({ where: { userId: sa.id, session: S }, orderBy: { creeLe: "desc" } });
    const pret = await suivreTravailVocal(sa, S, w.id);
    expect(pret.etat).toBe("pret");
    const p = pret as Extract<SuiviOral, { etat: "pret" }>;
    expect(p.pourVoix).toContain("Carte préparée");
    expect(p.pourVoix).toContain(`Stand ${TAG}`);
    expect(p.resumeDe?.intentId).toBe(intentId);

    // Le responsable (facultatif, mais utile) — la voix le propose ; on simule la demande d'UN champ par la voix.
    await prisma.assistantIaVoixCarte.update({ where: { intentId }, data: { champ: "assignedToId" } });
    const choisi = await traiterEnonceVocal(sa, { session: S, demande: `Samia ${TAG}` });
    expect(choisi.pourVoix).toContain("C'est noté");
    expect(choisi.pourVoix).toContain("Samia");
    const corrigee = await prisma.assistantActionIntent.findUniqueOrThrow({ where: { id: intentId }, select: { payload: true } });
    expect((corrigee.payload as { entree: Record<string, unknown> }).entree.assignedToId).toBe(samia.id);

    // GARDE-FOU : le résumé n'a pas encore été DIT → « vas-y » n'exécute rien.
    const tot = await traiterEnonceVocal(sa, { session: S, demande: "vas-y" });
    expect(tot.pourVoix).toContain("pas encore été dit");
    expect(await prisma.task.count({ where: { title: { contains: TAG } } })).toBe(0);

    // GARDE-FOU : une autre personne (sa propre session) ne peut signaler le résumé ni confirmer.
    const vc = await prisma.assistantIaVoixCarte.findUniqueOrThrow({ where: { intentId } });
    expect(await resumeCarteDit(autre, `live_${TAG}autre`, intentId, vc.empreinte)).toBe(false);
    expect(await resumeCarteDit(autre, S, intentId, vc.empreinte)).toBe(false);
    const etranger = await traiterEnonceVocal(autre, { session: S, demande: "ok fais-le" });
    expect(etranger.pourVoix).toContain("n'est plus reconnue");
    expect(await prisma.task.count({ where: { title: { contains: TAG } } })).toBe(0);

    // Le résumé est dit (accusé du fournisseur) ; un énoncé NON affirmatif n'exécute rien.
    expect(await resumeCarteDit(sa, S, intentId, vc.empreinte)).toBe(true);
    const flou = await traiterEnonceVocal(sa, { session: S, demande: "oui mais attends" });
    expect(flou.etatCarte).toBeUndefined();
    expect(await prisma.task.count({ where: { title: { contains: TAG } } })).toBe(0);

    // « ok fais-le » : exécutée par la même porte que le bouton.
    const fait = await traiterEnonceVocal(sa, { session: S, demande: "ok fais-le" });
    expect(fait.etatCarte, fait.pourVoix).toEqual({ intentId, status: "EXECUTED" });
    expect(fait.pourVoix).toContain("C'est fait");
    expect(fait.pourVoix).toContain("annule");
    const t = await prisma.task.findFirstOrThrow({ where: { title: { contains: TAG } }, select: { assignedToId: true, id: true } });
    expect(t.assignedToId).toBe(samia.id);
    expect((await prisma.assistantActionIntent.findUniqueOrThrow({ where: { id: intentId } })).status).toBe("EXECUTED");

    // « annule » : la dernière action de l'assistant est défaite (journal des effets J7).
    const annule = await traiterEnonceVocal(sa, { session: S, demande: "annule" });
    expect(annule.pourVoix).toContain("Annulation");
    expect(await prisma.task.count({ where: { id: t.id } })).toBe(0);
  });

  it("garde-fou : l'intention a changé depuis le résumé → rien n'est fait, la voix relit la carte", async () => {
    const intentId = await carteTache({ title: `Relance ${TAG}` });
    const w = await prisma.assistantIaVoixTravail.findFirstOrThrow({ where: { userId: sa.id, session: S }, orderBy: { creeLe: "desc" } });
    await suivreTravailVocal(sa, S, w.id);
    const vc = await prisma.assistantIaVoixCarte.findUniqueOrThrow({ where: { intentId } });
    expect(await resumeCarteDit(sa, S, intentId, vc.empreinte)).toBe(true);
    // Une autre fenêtre corrige la carte après le résumé.
    const i = await prisma.assistantActionIntent.findUniqueOrThrow({ where: { id: intentId } });
    await prisma.assistantActionIntent.update({ where: { id: intentId }, data: { payload: { ...(i.payload as object), entree: { title: `Relance modifiée ${TAG}` } } as never } });
    const r = await traiterEnonceVocal(sa, { session: S, demande: "go" });
    expect(r.pourVoix).toContain("La carte a changé depuis son résumé");
    expect(r.etatCarte).toBeUndefined();
    expect(await prisma.task.count({ where: { title: { contains: `Relance` } , AND: { title: { contains: TAG } } } })).toBe(0);
    // Refusée à l'oral : abandonnée, jamais exécutée.
    await resumeCarteDit(sa, S, intentId, (await prisma.assistantIaVoixCarte.findUniqueOrThrow({ where: { intentId } })).empreinte);
    const non = await traiterEnonceVocal(sa, { session: S, demande: "non laisse tomber" });
    expect(non.etatCarte).toEqual({ intentId, status: "CANCELLED" });
  });

  it("l'attente vivante : la précision dite pendant le travail est TRANSMISE ; seul le résultat à jour est dit", async () => {
    const fil = await filDe(sa.id);
    // Le fil est tenu (un autre passage joue) : la demande attend.
    await prisma.assistantIaFil.update({ where: { id: fil.id }, data: { traitementLe: new Date() } });
    const lance = await traiterEnonceVocal(sa, { session: S, demande: "le chiffre d'affaires des ventes", delegationId: "d1" });
    expect(lance.travail).toBeTruthy();
    // 1) Pas encore commencé : la précision s'AJOUTE au message (un seul tour).
    const p1 = await traiterEnonceVocal(sa, { session: S, demande: "pour le troisième trimestre", delegationId: "d2", enCours: lance.travail });
    expect(p1.travail).toBe(lance.travail);
    const w1 = await prisma.assistantIaVoixTravail.findUniqueOrThrow({ where: { id: lance.travail! } });
    const t1 = await prisma.assistantIaTour.findUniqueOrThrow({ where: { id: w1.tourId } });
    expect(t1.contenu).toContain("pour le troisième trimestre");
    expect(w1.delegationId).toBe("d2");
    // 2) En cours : RELANCE CIBLÉE — un message de précision qui repart du résultat, l'ancien travail est remplacé.
    await prisma.assistantIaTour.update({ where: { id: w1.tourId }, data: { etat: ETAT.COURS } });
    const p2 = await traiterEnonceVocal(sa, { session: S, demande: "seulement Oran", delegationId: "d3", enCours: lance.travail });
    expect(p2.travail).not.toBe(lance.travail);
    expect(p2.pourVoix).toContain("transmise au travail en cours");
    expect(await suivreTravailVocal(sa, S, lance.travail)).toEqual({ etat: "remplace", par: p2.travail });
    // Le premier tour aboutit (son résultat est dépassé) ; le fil se libère et joue la précision, avec ce résultat en historique.
    await prisma.assistantIaTour.update({ where: { id: w1.tourId }, data: { etat: ETAT.TRAITE } });
    await prisma.assistantIaTour.create({ data: { filId: fil.id, userId: sa.id, role: "assistant", contenu: "Le CA du T3 est de 12 millions, dont Oran 3,1 millions.", etat: ETAT.TERMINE, repondA: w1.tourId } });
    await prisma.assistantIaFil.update({ where: { id: fil.id }, data: { traitementLe: null } });
    let vuHistorique = false;
    let vuConsigne = false;
    remplacerModelesPourTests([modeleFactice([(prompt) => {
      // Le faux modèle sert aussi le titre de la conversation : on cumule ce que le tour principal a reçu.
      vuHistorique ||= prompt.includes("dont Oran 3,1 millions");
      vuConsigne ||= prompt.includes("RÉPONSE POUR L'OREILLE");
      return reponse("À Oran, le chiffre d'affaires du troisième trimestre est d'environ 3,1 millions de dinars. Je te détaille par produit ?");
    }]).modele as never]);
    await traiterFil(sa.id, fil.id);
    const fin = await suivreJusquAuBout(sa, S, p2.travail!);
    expect(fin).toMatchObject({ etat: "pret", pourVoix: expect.stringContaining("À Oran") });
    expect(vuHistorique).toBe(true);
    expect(vuConsigne).toBe(true);
  });

  it("au-delà de la session : le résultat est dit à l'ouverture suivante (une fois)", async () => {
    remplacerModelesPourTests([modeleFactice([reponse("Ton rendez-vous de jeudi est confirmé.")]).modele as never]);
    const S2 = `live_${TAG}sa2`;
    await enregistrerSessionVoix(sa.id, S2, null);
    const r = await traiterEnonceVocal(sa, { session: S2, demande: "est-ce que jeudi est confirmé ?" });
    await fermerSessionVoix(sa.id, S2);
    // Le travail se termine après la fin de la session : plus personne ne le suit.
    const w = await prisma.assistantIaVoixTravail.findUniqueOrThrow({ where: { id: r.travail! } });
    for (let i = 0; i < 200; i++) {
      const rep = await prisma.assistantIaTour.findFirst({ where: { repondA: w.tourId, role: "assistant", etat: ETAT.TERMINE } });
      if (rep) break;
      await new Promise((x) => setTimeout(x, 50));
    }
    expect(await suivreTravailVocal(sa, S2, r.travail)).toEqual({ etat: "inconnu" });
    const S3 = `live_${TAG}sa3`;
    await enregistrerSessionVoix(sa.id, S3, null);
    const dits = await reprisesOrales(sa, S3);
    expect(dits.some((d) => d.includes("Ton rendez-vous de jeudi est confirmé."))).toBe(true);
    expect(await reprisesOrales(sa, S3)).toEqual([]);
  });

  it("les commandes : stop et plus court reviennent au navigateur ; une mission absente se dit", async () => {
    expect(await traiterEnonceVocal(sa, { session: S, demande: "stop" })).toMatchObject({ commande: "stop" });
    expect(await traiterEnonceVocal(sa, { session: S, demande: "plus court" })).toMatchObject({ commande: "plus_court" });
    expect((await traiterEnonceVocal(sa, { session: S, demande: "reprends la mission" })).pourVoix).toContain("Aucune mission à reprendre");
  });
});
