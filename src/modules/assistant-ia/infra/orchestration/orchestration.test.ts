import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => undefined }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", async (original) => ({ ...(await original<typeof import("@/lib/session")>()), requireUser: async () => ACTEUR, getCurrentUser: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { remplacerLecteurInterrupteurIaPourTests } from "@/lib/ai-settings";
import { ClientVoixTempsReel } from "@/platform/ia/voix/client-temps-reel";
import { ATTENTE_BLOQUANTE } from "@/platform/ia/conversation/orchestrateur";
import { remplacerModelesPourTests } from "../generer";
import { modeleFactice } from "../testing/modele-factice";
import { effacerJournalDe } from "../testing/journal";
import { ETAT, nouvelleConversation } from "../fil/service";
import { enregistrerSessionVoix, suivreTravailVocal, traiterEnonceVocal } from "../voix/oral";
import { deposerEcrit, orchestrationDuFil } from "./ecrit";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ORCHESTRATEUR DE CONVERSATION, DE BOUT EN BOUT (lot O1, décision 0046) — contre la vraie base, le vrai fil, le
 * vrai serveur de la voix ; le modèle est le faux modèle (déterministe), tenu par une PORTE pour que le travail dure
 * le temps de la conversation.
 *
 *   • À L'ORAL — le transport GPT-Live est simulé d'après sa documentation : fragments de transcription d'entrée et de
 *     sortie (`session.input_transcript.delta`, `session.output_transcript.delta`, horodatés sur la ligne de temps de la
 *     session), `session.delegation.created` ; ce que le client renvoie part par `session.commentary.append`. Pas
 *     d'événement de détection de parole ni de fin de réponse : GPT-Live n'en a pas — le client les lit sur les fragments.
 *   • À L'ÉCRIT — les messages passent par l'action réelle (`deposerEcrit`) et l'état est celui que lit l'écran.
 *
 * MESURE, sur chaque scénario : 0 annonce qui coupe une question en attente ; 0 « j'attends » bloquant.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__iaorch_${Date.now().toString(36)}_`;
let sa: CurrentUser;
const cleAvant = process.env.OPENAI_API_KEY;
const reponse = (message: string) => ({ texte: JSON.stringify({ message, components: [] }) });

async function compte(nom: string): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${nom} ${TAG}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
  await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ALL" } }).catch(() => {});
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

/**
 * LE FAUX MODÈLE À PORTE : un tour dont le message contient `retenu` attend que la porte s'ouvre — le travail long. La
 * réponse dit ce que le modèle a VU (PDF, trimestre) : le banc vérifie que le résultat dit tient compte des réponses.
 */
function modeleAPorte(retenu: RegExp) {
  let ouvrir!: () => void;
  const porte = new Promise<void>((r) => { ouvrir = r; });
  const base = modeleFactice([(prompt) => {
    if (/clients à Oran/.test(prompt) && !/rapport/.test(prompt.split("clients à Oran")[1] ?? "")) return reponse("Tu as 42 clients à Oran.");
    const vu = [/PDF/.test(prompt) ? "en PDF" : "en tableau", /trimestre/i.test(prompt) ? "sur le trimestre" : ""].filter(Boolean).join(" ");
    return reponse(`Voici le rapport des ventes par wilaya, ${vu}.`);
  }]).modele as unknown as Record<string, (o: { prompt: unknown }) => Promise<unknown>>;
  const tenir = async (o: { prompt: unknown }) => { if (retenu.test(JSON.stringify(o.prompt)) && !/Précision|précision/.test(JSON.stringify(o.prompt))) await porte; };
  const modele = { ...base, doStream: async (o: { prompt: unknown }) => { await tenir(o); return base.doStream(o); }, doGenerate: async (o: { prompt: unknown }) => { await tenir(o); return base.doGenerate(o); } };
  return { modele, ouvrir };
}

async function jusqua<T>(f: () => Promise<T | null | undefined | false>, quoi: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const v = await f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`jamais : ${quoi}`);
}

/** Le client GPT-Live du navigateur, branché sur le VRAI serveur de la voix ; le canal d'événements est capturé. */
function appel(session: string) {
  let horloge = 0;
  const dits: { contenu: string; questionEnAttente: boolean; accuse: boolean }[] = [];
  const c = new ClientVoixTempsReel({
    ouvrir: async () => ({ sdp: "" }),
    deleguer: (demande, delegationId, ctx) => traiterEnonceVocal(sa, { session, demande, delegationId, enCours: ctx?.enCours ?? null, parole: ctx?.parole ?? demande, question: ctx?.question ?? null }),
    suivre: (t, s) => suivreTravailVocal(sa, s, t),
    silenceTranscriptionMs: 0, suiviMs: 0, orchestreMs: 0, maintenant: () => horloge,
  });
  c.session = session;
  (c as unknown as { dc: unknown }).dc = {
    readyState: "open", close: () => {},
    send: (brut: string) => {
      const e = JSON.parse(brut) as { type: string; content?: string };
      if (e.type !== "session.commentary.append") return;
      // LA MESURE : au moment où ça part, une question de l'assistant attendait-elle sa réponse ?
      dits.push({ contenu: String(e.content), questionEnAttente: c.orchestre.question != null, accuse: c.orchestre.accuse != null });
    },
  };
  let t = 0;
  const ev = (o: Record<string, unknown>) => c.recevoir(JSON.stringify(o));
  return {
    c, dits,
    avancer: (ms: number) => { horloge += ms; },
    /** La personne parle, puis GPT-Live délègue (sa phrase est finie). */
    personne: async (texte: string, delegation: string) => {
      horloge += 1_000;
      await ev({ type: "session.input_transcript.delta", delta: texte, start_ms: t, end_ms: (t += 900) });
      horloge += 300;
      await ev({ type: "session.delegation.created", delegation: { id: delegation, target: "client" } });
    },
    /** La voix dit ce qu'on lui a donné (sa transcription de sortie) — une question finit par « ? ». */
    voix: async (texte: string) => {
      horloge += 200;
      await ev({ type: "session.output_transcript.delta", delta: texte, start_ms: (t += 200), end_ms: (t += 2_000) });
      horloge += 2_500;
    },
  };
}

/** Chaque scénario dans SA conversation : un travail retenu ailleurs ne tient pas sa file. */
async function conversationNeuve(): Promise<string> {
  const r = await nouvelleConversation(sa.id);
  if (!r.ok) throw new Error(r.erreur);
  return r.conversation;
}

const coupures = (d: { contenu: string; questionEnAttente: boolean; accuse: boolean }[]) => d.filter((x) => x.questionEnAttente && !x.accuse && /résultat|Résultat/.test(x.contenu)).length;
const attentes = (d: { contenu: string }[]) => d.filter((x) => ATTENTE_BLOQUANTE.test(x.contenu)).length;

suite("Assistant IA — l'orchestrateur de conversation (O1), de bout en bout", () => {
  beforeAll(async () => {
    process.env.OPENAI_API_KEY = "cle-de-banc";
    remplacerLecteurInterrupteurIaPourTests(async () => false);
    sa = await compte("Direction");
    ACTEUR = sa;
  });
  afterEach(() => remplacerModelesPourTests(null));
  afterAll(async () => {
    if (cleAvant === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = cleAvant;
    remplacerLecteurInterrupteurIaPourTests(null);
    const ids = [sa?.id].filter(Boolean) as string[];
    await effacerJournalDe(ids);
    await prisma.assistantIaAgenda.deleteMany({ where: { userId: { in: ids } } });
    await prisma.assistantIaVoixTravail.deleteMany({ where: { userId: { in: ids } } });
    await prisma.assistantIaVoixSession.deleteMany({ where: { userId: { in: ids } } });
    await prisma.assistantIaFil.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("ORAL — « Excel ou PDF ? » : le résultat arrivé pendant la question est TENU ; la réponse le change ; le résultat dit en tient compte", async () => {
    const m = modeleAPorte(/rapport des ventes/);
    remplacerModelesPourTests([m.modele as never]);
    const S = `live_${TAG}o1`;
    await enregistrerSessionVoix(sa.id, S, await conversationNeuve());
    const a = appel(S);

    await a.personne("Prépare-moi un rapport des ventes par wilaya", "d1");
    // L'accusé, collé à LA question utile dérivée de la demande (pas « la période, le but, le périmètre » au hasard).
    expect(a.dits[0].contenu).toMatch(/tu regardes.*Excel ou PDF \?/s);
    await a.voix("Je regarde et je te préviens. Tu préfères un rendu Excel ou PDF ?");

    // Le travail finit PENDANT que la question attend : rien n'est dit par-dessus.
    m.ouvrir();
    const w1 = a.c.travail!.id;
    const t1 = (await prisma.assistantIaVoixTravail.findUniqueOrThrow({ where: { id: w1 } })).tourId;
    await jusqua(() => prisma.assistantIaTour.findFirst({ where: { repondA: t1, role: "assistant", etat: ETAT.TERMINE } }), "premier résultat");
    a.avancer(3_000);
    await a.c.suivreMaintenant();
    expect(a.dits).toHaveLength(1);
    expect(a.c.orchestre.annonces).toHaveLength(1);
    expect(a.c.orchestrer()).toEqual({ type: "rien", raison: "question en attente" });

    // « En PDF » : noté ; le résultat tenu (en tableau) est CADUC — il n'est pas dit ; la question suivante enchaîne.
    await a.personne("En PDF", "d2");
    const apres = a.dits[1].contenu;
    expect(apres).toMatch(/Noté, PDF/);
    expect(apres).toMatch(/Sur quelle période/);
    expect(apres).not.toMatch(/en tableau/);
    expect(a.c.travail!.id).not.toBe(w1);
    await a.voix("Noté, PDF. Et sur quelle période : ce mois-ci, le trimestre ou l'année ?");

    await a.personne("le trimestre", "d3");
    expect(a.dits[2].contenu).toMatch(/Noté, Le trimestre/);
    expect(a.dits[2].contenu).toMatch(/je l'envoie à quelqu'un/);
    await a.voix("Noté. Quand ce sera prêt, je l'envoie à quelqu'un, ou c'est pour toi ?");
    await a.personne("c'est pour moi", "d4");
    expect(a.dits[3].contenu).toMatch(/Noté/);

    // Le résultat DIT : celui qui tient compte des deux réponses — dit de lui-même, au premier silence.
    const final = await jusqua(async () => {
      a.avancer(7_000);
      await a.c.suivreMaintenant();
      return a.dits.find((d) => /Voici le rapport/.test(d.contenu));
    }, "résultat ajusté dit");
    expect(final.contenu).toMatch(/en PDF sur le trimestre/);
    expect(a.dits.some((d) => /en tableau/.test(d.contenu))).toBe(false);
    expect(coupures(a.dits)).toBe(0);
    expect(attentes(a.dits)).toBe(0);
  });

  it("ORAL — deux travaux : une AUTRE demande pendant le travail part en parallèle ; chaque résultat est dit à son tour, jamais deux collés", async () => {
    const m = modeleAPorte(/rapport détaillé/);
    remplacerModelesPourTests([m.modele as never]);
    const S = `live_${TAG}o2`;
    await enregistrerSessionVoix(sa.id, S, await conversationNeuve());
    const a = appel(S);
    await a.personne("Fais un rapport détaillé des ventes par wilaya en Excel ce mois-ci et envoie-le à Amel", "d1");
    // Tout est dit dans la demande : aucune question — la voix ne meuble pas, elle reste disponible.
    expect(a.dits[0].contenu).toMatch(/restes disponible/);
    await a.voix("Je regarde et je te préviens dès que c'est prêt.");
    const w1 = a.c.travail!.id;

    await a.personne("Combien de clients à Oran ?", "d2");
    expect(a.dits[1].contenu).toMatch(/en parallèle/);
    expect(a.c.suivis.size).toBe(2);
    await a.voix("Je regarde aussi.");
    // Le deuxième finit d'abord (voie parallèle : il n'attend pas le premier, toujours retenu).
    const w2 = a.c.travail!.id;
    const t2 = (await prisma.assistantIaVoixTravail.findUniqueOrThrow({ where: { id: w2 } })).tourId;
    await jusqua(() => prisma.assistantIaTour.findFirst({ where: { repondA: t2, role: "assistant", etat: ETAT.TERMINE } }), "deuxième résultat");
    expect((await prisma.assistantIaTour.findUniqueOrThrow({ where: { id: (await prisma.assistantIaVoixTravail.findUniqueOrThrow({ where: { id: w1 } })).tourId } })).etat).toBe(ETAT.COURS);
    a.avancer(3_000);
    await a.c.suivreMaintenant();
    expect(a.dits.at(-1)!.contenu).toMatch(/42 clients à Oran/);
    await a.voix("Tu as 42 clients à Oran.");

    m.ouvrir();
    const fin = await jusqua(async () => {
      a.avancer(7_000);
      await a.c.suivreMaintenant();
      return a.dits.find((d) => /Voici le rapport/.test(d.contenu));
    }, "premier résultat dit");
    expect(fin.contenu).not.toMatch(/42 clients/);
    expect(a.dits.filter((d) => /Voici le rapport|42 clients/.test(d.contenu)).every((d) => !(/Voici le rapport/.test(d.contenu) && /42 clients/.test(d.contenu)))).toBe(true);
    expect(coupures(a.dits)).toBe(0);
    expect(attentes(a.dits)).toBe(0);
  });

  it("ÉCRIT — pendant un travail long : la question de l'agenda dans le fil, une autre demande en parallèle, le résultat TENU jusqu'à la réponse, qui l'ajuste", async () => {
    const m = modeleAPorte(/rapport des ventes/);
    remplacerModelesPourTests([m.modele as never]);
    const fil = { id: await conversationNeuve() };
    const d1 = await deposerEcrit(sa.id, "Prépare-moi un rapport des ventes par wilaya", [], fil.id);
    expect(d1.ok && d1.voie).toBe("suite");
    const r1 = await jusqua(() => prisma.assistantIaTour.findFirst({ where: { repondA: d1.ok ? d1.tour.id : "", role: "assistant", etat: ETAT.COURS } }), "travail en cours");
    // Une réponse rapide n'a pas de question : l'agenda ne s'ouvre qu'au-delà de 4 s.
    expect((await orchestrationDuFil(sa.id, fil.id)).question).toBeNull();
    await prisma.assistantIaTour.update({ where: { id: r1.id }, data: { createdAt: new Date(Date.now() - 10_000) } });
    const o1 = await orchestrationDuFil(sa.id, fil.id);
    expect(o1.question).toMatchObject({ texte: "Tu préfères un rendu Excel ou PDF ?", choix: ["Excel", "PDF", "Peu importe"] });
    expect(o1.avancement?.reponseId).toBe(r1.id);

    // Une AUTRE demande : elle n'attend pas derrière le travail long (voie parallèle) — la question reste posée.
    const d2 = await deposerEcrit(sa.id, "Combien de clients à Oran ?", [], fil.id);
    expect(d2.ok && d2.voie).toBe("parallele");
    await jusqua(() => prisma.assistantIaTour.findFirst({ where: { repondA: d2.ok ? d2.tour.id : "", role: "assistant", etat: ETAT.TERMINE, contenu: { contains: "42 clients" } } }), "réponse parallèle");
    expect((await prisma.assistantIaTour.findUniqueOrThrow({ where: { id: r1.id } })).etat).toBe(ETAT.COURS);
    expect((await orchestrationDuFil(sa.id, fil.id)).question?.texte).toMatch(/Excel ou PDF/);

    // Le travail finit pendant que SA question attend : la réponse est TENUE (« affichée après ta réponse »).
    m.ouvrir();
    await jusqua(() => prisma.assistantIaTour.findFirst({ where: { id: r1.id, etat: ETAT.TERMINE } }), "premier résultat");
    expect((await orchestrationDuFil(sa.id, fil.id)).tenus).toEqual([r1.id]);

    // « PDF » (le choix touché) : la question est levée, la réponse d'avant est « version d'avant », l'ajustée suit.
    const d3 = await deposerEcrit(sa.id, "PDF", [], fil.id);
    expect(d3.ok && d3.voie).toBe("reponse");
    const o3 = await orchestrationDuFil(sa.id, fil.id);
    expect(o3.tenus).toEqual([]);
    expect(o3.ajustes).toEqual([{ reponseId: r1.id, valeur: "PDF" }]);
    await jusqua(() => prisma.assistantIaTour.findFirst({ where: { filId: fil.id, role: "assistant", etat: ETAT.TERMINE, contenu: { contains: "en PDF" } } }), "réponse ajustée");
    // Le message de la personne est dans le fil, tel qu'écrit ; la précision transmise aussi.
    expect(await prisma.assistantIaTour.count({ where: { filId: fil.id, role: "user", contenu: "PDF" } })).toBe(1);
    expect(await prisma.assistantIaTour.count({ where: { filId: fil.id, role: "user", contenu: { startsWith: "[Précision du travail en cours] Format de rendu voulu : PDF." } } })).toBe(1);
  });
});
