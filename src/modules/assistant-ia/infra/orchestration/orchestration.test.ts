import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => undefined }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", async (original) => ({ ...(await original<typeof import("@/lib/session")>()), requireUser: async () => ACTEUR, getCurrentUser: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
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
 * réponse dit ce que le modèle a VU (PDF, trimestre) : le banc vérifie que le résultat dit tient compte des réponses. Il
 * sert aussi le CLASSIFIEUR rapide (O1) et la MISE EN FORME d'une réponse écrite — chacun reconnu à sa consigne.
 */
function modeleAPorte(retenu: RegExp) {
  let ouvrir!: () => void;
  const porte = new Promise<void>((r) => { ouvrir = r; });
  const appels = { classement: 0, miseEnForme: 0 };
  const base = modeleFactice([(prompt) => {
    if (prompt.includes("Tu classes UN énoncé")) {
      appels.classement += 1;
      const enonce = prompt.slice(prompt.lastIndexOf("enonce"));
      const json = /clients à Oran/.test(enonce) ? '{"nature":"autre_demande","impact":null,"forme":null,"consigne":"clients à Oran"}'
        : /c'est long/i.test(enonce) ? '{"nature":"conversation","impact":null,"forme":null,"consigne":"c\'est long"}'
          : '{"nature":"precision","impact":"majeur","forme":null,"consigne":"Seulement les grossistes."}';
      return { texte: json };
    }
    if (prompt.includes("Tu remets en forme")) {
      appels.miseEnForme += 1;
      return { texte: "En bref : le rapport des ventes par wilaya." };
    }
    // La DERNIÈRE demande du prompt décide (l'historique peut contenir l'autre).
    if (/clients à Oran/.test(prompt) && !/rapport/.test(prompt.slice(prompt.lastIndexOf("clients à Oran")))) return reponse("Tu as 42 clients à Oran.");
    const vu = [/Format de rendu voulu : PDF/.test(prompt) ? "en PDF" : "en tableau", /trimestre/i.test(prompt) ? "sur le trimestre" : "", /grossistes/.test(prompt) ? "pour les grossistes" : ""].filter(Boolean).join(" ");
    return reponse(`Voici le rapport des ventes par wilaya, ${vu}.`);
  }]).modele as unknown as Record<string, (o: { prompt: unknown }) => Promise<unknown>>;
  const tenir = async (o: { prompt: unknown }) => {
    const p = JSON.stringify(o.prompt);
    if (retenu.test(p) && !/Précision|précision|Tu classes UN énoncé|Tu remets en forme|Mise en forme du résultat/.test(p)) await porte;
  };
  const modele = { ...base, doStream: async (o: { prompt: unknown }) => { await tenir(o); return base.doStream(o); }, doGenerate: async (o: { prompt: unknown }) => { await tenir(o); return base.doGenerate(o); } };
  return { modele, ouvrir, appels };
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
  let consigne = "";
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
      const e = JSON.parse(brut) as { type: string; content?: string; event_id?: string };
      // F2 (TR-VX-02) : la CONSIGNE au modèle vocal part en contexte silencieux (`thinking`, « silence_… »), jamais en
      // parole ; ce banc lit ce que la voix REÇOIT — la consigne en attente, puis la parole qu'elle accompagne.
      if (e.type === "session.thinking.append" && e.event_id?.startsWith("silence_")) { consigne = `${consigne} ${String(e.content)}`.trim(); return; }
      if (e.type !== "session.commentary.append") return;
      // LA MESURE : au moment où ça part, une question de l'assistant attendait-elle sa réponse ?
      dits.push({ contenu: [consigne, String(e.content)].filter(Boolean).join(" "), questionEnAttente: c.orchestre.question != null, accuse: c.orchestre.accuse != null });
      consigne = "";
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
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("ORAL — un long travail : la conversation continue UTILEMENT (plus de deux précisions) ; mineure portée, majeure RÉINJECTÉE, le résultat dit tient compte de tout", async () => {
    const m = modeleAPorte(/rapport des ventes/);
    remplacerModelesPourTests([m.modele as never]);
    const S = `live_${TAG}o1`;
    await enregistrerSessionVoix(sa.id, S, await conversationNeuve());
    const a = appel(S);

    await a.personne("Prépare-moi un rapport des ventes par wilaya", "d1");
    // L'accusé, collé à LA question utile dérivée de la demande (pas « la période, le but, le périmètre » au hasard).
    expect(a.dits[0].contenu).toMatch(/[Jj]e regarde.*Excel ou PDF \?/s);
    await a.voix("Je regarde et je te préviens. Tu préfères un rendu Excel ou PDF ?");
    const w1 = a.c.travail!.id;

    // « En PDF » — MINEURE (la forme) : gardée, AUCUNE relance ; la conversation enchaîne sur l'élément suivant.
    await a.personne("En PDF", "d2");
    expect(a.dits[1].contenu).toMatch(/Noté, PDF.*rendu ainsi.*Sur quelle période/s);
    await a.voix("Noté. Et sur quelle période : ce mois-ci, le trimestre ou l'année ?");
    // « le trimestre » — MAJEURE (le périmètre) : gardée, elle partira dans le raisonnement du travail.
    await a.personne("le trimestre", "d3");
    expect(a.dits[2].contenu).toMatch(/Noté, Le trimestre.*le travail en tient compte.*grandes lignes ou le détail/s);
    expect(a.c.travail!.id).toBe(w1);
    await a.voix("Noté. Tu veux les grandes lignes ou le détail complet ?");

    // Le travail finit PENDANT que la question attend : rien n'est dit par-dessus.
    m.ouvrir();
    const t1 = (await prisma.assistantIaVoixTravail.findUniqueOrThrow({ where: { id: w1 } })).tourId;
    await jusqua(() => prisma.assistantIaTour.findFirst({ where: { repondA: t1, role: "assistant", etat: ETAT.TERMINE } }), "premier résultat");
    a.avancer(3_000);
    await a.c.suivreMaintenant();
    expect(a.dits).toHaveLength(3);
    // La majeure attendait sa fin : RELANCE CIBLÉE (une seule, qui porte aussi les mineures) — le premier résultat,
    // dépassé, ne sera pas dit.
    expect(a.c.travail!.id).not.toBe(w1);
    expect(await prisma.assistantIaTour.count({ where: { filId: (await prisma.assistantIaTour.findUniqueOrThrow({ where: { id: t1 } })).filId, role: "user", contenu: { contains: "Période voulue : Le trimestre." } } })).toBe(1);
    expect(a.c.orchestrer()).toEqual({ type: "rien", raison: "question en attente" });

    await a.personne("les grandes lignes", "d4");
    expect(a.dits[3].contenu).toMatch(/Noté, Les grandes lignes/);
    await a.voix("Noté. Tu veux que j'ajoute la comparaison avec la même période l'an dernier ?");
    await a.personne("non", "d5");
    await a.voix("D'accord. Je signale aussi les points de vigilance — retards, ruptures, écarts ?");
    await a.personne("non merci", "d6");
    await a.voix("D'accord. Quand ce sera prêt, je l'envoie à quelqu'un, ou c'est pour toi ?");
    await a.personne("c'est pour moi", "d7");
    // Cinq éléments utiles enchaînés — pas de plafond à deux.
    expect(a.dits.filter((d) => /pose cette question/.test(d.contenu)).length).toBeGreaterThanOrEqual(5);

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

  it("ORAL — une précision MINEURE sans relance : « fais-le plus court » ; une phrase ambiguë, tranchée par le classifieur ; une conversation, sans rien lancer", async () => {
    const m = modeleAPorte(/rapport détaillé/);
    remplacerModelesPourTests([m.modele as never]);
    const S = `live_${TAG}o3`;
    const conv = await conversationNeuve();
    await enregistrerSessionVoix(sa.id, S, conv);
    const a = appel(S);
    await a.personne("Fais un rapport détaillé des ventes par wilaya en Excel ce mois-ci, comparé à l'an dernier, avec les risques, et envoie-le à Amel", "d1");
    await a.voix("Je regarde et je te préviens dès que c'est prêt.");
    const w1 = a.c.travail!.id;
    // Déterministe, sans modèle : une consigne de forme.
    await a.personne("fais-le plus court", "d2");
    expect(a.dits.at(-1)!.contenu).toMatch(/rendu ainsi/);
    expect(m.appels.classement).toBe(0);
    // Ambiguë : le classifieur tranche — c'est de la conversation ; rien n'est lancé.
    await a.personne("c'est long là, non ?", "d3");
    expect(m.appels.classement).toBe(1);
    expect(a.dits.at(-1)!.contenu).toMatch(/conversation pendant que le travail tourne/);
    expect(a.c.suivis.size).toBe(1);
    // Le classement est imputé à la personne et journalisé (K8).
    expect(await prisma.modelCallLog.count({ where: { userId: sa.id } })).toBeGreaterThan(0);

    m.ouvrir();
    const fin = await jusqua(async () => {
      a.avancer(7_000);
      await a.c.suivreMaintenant();
      return a.dits.find((d) => /Voici le rapport/.test(d.contenu));
    }, "résultat dit");
    // Le résultat est dit TEL QUEL, mis en forme comme demandé — aucune relance n'a eu lieu.
    expect(fin.contenu).toMatch(/plus court/);
    expect(a.c.travail?.id ?? w1).toBe(w1);
    expect(await prisma.assistantIaTour.count({ where: { filId: conv, role: "user", contenu: { contains: "précision" } } })).toBe(0);
    expect(coupures(a.dits)).toBe(0);
    expect(attentes(a.dits)).toBe(0);
  });

  it("ORAL — deux travaux : une AUTRE demande (le classifieur la reconnaît) part en parallèle ; chaque résultat est dit à son tour, jamais deux collés", async () => {
    const m = modeleAPorte(/rapport détaillé/);
    remplacerModelesPourTests([m.modele as never]);
    const S = `live_${TAG}o2`;
    await enregistrerSessionVoix(sa.id, S, await conversationNeuve());
    const a = appel(S);
    await a.personne("Fais un rapport détaillé des ventes par wilaya en Excel ce mois-ci, comparé à l'an dernier, avec les risques, et envoie-le à Amel", "d1");
    // Tout est dit dans la demande : aucune question — la voix ne meuble pas, elle reste disponible.
    expect(a.dits[0].contenu).toMatch(/restes disponible/);
    await a.voix("Je regarde et je te préviens dès que c'est prêt.");
    const w1 = a.c.travail!.id;

    await a.personne("Combien de clients à Oran ?", "d2");
    expect(m.appels.classement).toBe(1);
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
    expect(coupures(a.dits)).toBe(0);
    expect(attentes(a.dits)).toBe(0);
  });

  it("ÉCRIT — pendant un travail long : les questions de l'agenda dans le fil, une autre demande en parallèle, une mineure gardée, une majeure réinjectée", async () => {
    const m = modeleAPorte(/rapport des ventes/);
    remplacerModelesPourTests([m.modele as never]);
    const fil = { id: await conversationNeuve() };
    const d1 = await deposerEcrit(sa.id, "Prépare-moi un rapport des ventes par wilaya", [], fil.id);
    expect(d1.ok && d1.voie).toBe("suite");
    const r1 = await jusqua(() => prisma.assistantIaTour.findFirst({ where: { repondA: d1.ok ? d1.tour.id : "", role: "assistant", etat: ETAT.COURS } }), "travail en cours");
    // Une réponse rapide n'a pas de question : l'agenda ne s'ouvre qu'au-delà du seuil (réglage, 4 s par défaut).
    expect((await orchestrationDuFil(sa.id, fil.id)).question).toBeNull();
    await prisma.assistantIaTour.update({ where: { id: r1.id }, data: { createdAt: new Date(Date.now() - 10_000) } });
    const o1 = await orchestrationDuFil(sa.id, fil.id);
    expect(o1.question).toMatchObject({ texte: "Tu préfères un rendu Excel ou PDF ?", choix: ["Excel", "PDF", "Peu importe"] });
    expect(o1.avancement?.reponseId).toBe(r1.id);

    // Une AUTRE demande (le classifieur la reconnaît) : elle n'attend pas derrière le travail long — la question reste.
    const d2 = await deposerEcrit(sa.id, "Combien de clients à Oran ?", [], fil.id);
    expect(d2.ok && d2.voie).toBe("parallele");
    await jusqua(() => prisma.assistantIaTour.findFirst({ where: { repondA: d2.ok ? d2.tour.id : "", role: "assistant", etat: ETAT.TERMINE, contenu: { contains: "42 clients" } } }), "réponse parallèle");
    expect((await prisma.assistantIaTour.findUniqueOrThrow({ where: { id: r1.id } })).etat).toBe(ETAT.COURS);

    // « PDF » (le choix touché) — mineure, gardée ; l'agenda se renouvelle : la question suivante est posée.
    const d3 = await deposerEcrit(sa.id, "PDF", [], fil.id);
    expect(d3.ok && d3.voie).toBe("precision");
    expect((await orchestrationDuFil(sa.id, fil.id)).question?.texte).toMatch(/Sur quelle période/);
    // « le trimestre » — majeure, gardée jusqu'à la fin du travail.
    const d4 = await deposerEcrit(sa.id, "le trimestre", [], fil.id);
    expect(d4.ok && d4.voie).toBe("precision");

    // Le travail finit : UNE relance ciblée porte la majeure ET la mineure ; la réponse d'avant est « version d'avant ».
    m.ouvrir();
    await jusqua(() => prisma.assistantIaTour.findFirst({ where: { id: r1.id, etat: ETAT.TERMINE } }), "premier résultat");
    const o2 = await orchestrationDuFil(sa.id, fil.id);
    expect(o2.ajustes).toEqual([{ reponseId: r1.id, valeur: "Le trimestre" }]);
    await jusqua(() => prisma.assistantIaTour.findFirst({ where: { filId: fil.id, role: "assistant", etat: ETAT.TERMINE, contenu: { contains: "en PDF sur le trimestre" } } }), "réponse ajustée");
    expect(await prisma.assistantIaTour.count({ where: { filId: fil.id, role: "user", contenu: { startsWith: "[Précision du travail en cours]" } } })).toBe(1);
    expect(await prisma.assistantIaTour.count({ where: { filId: fil.id, role: "user", contenu: { startsWith: "[Mise en forme du résultat]" } } })).toBe(0);
    // Les messages de la personne sont dans le fil, tels qu'écrits.
    expect(await prisma.assistantIaTour.count({ where: { filId: fil.id, role: "user", contenu: { in: ["PDF", "le trimestre"] } } })).toBe(2);
  });

  it("ÉCRIT — une précision MINEURE sur un résultat prêt : pas de relance, la réponse est remise en forme ; le résultat TENU pendant la question", async () => {
    const m = modeleAPorte(/rapport des ventes/);
    remplacerModelesPourTests([m.modele as never]);
    const fil = { id: await conversationNeuve() };
    const d1 = await deposerEcrit(sa.id, "Prépare-moi un rapport des ventes par wilaya", [], fil.id);
    const r1 = await jusqua(() => prisma.assistantIaTour.findFirst({ where: { repondA: d1.ok ? d1.tour.id : "", role: "assistant", etat: ETAT.COURS } }), "travail en cours");
    await prisma.assistantIaTour.update({ where: { id: r1.id }, data: { createdAt: new Date(Date.now() - 10_000) } });
    expect((await orchestrationDuFil(sa.id, fil.id)).question?.texte).toMatch(/Excel ou PDF/);
    m.ouvrir();
    await jusqua(() => prisma.assistantIaTour.findFirst({ where: { id: r1.id, etat: ETAT.TERMINE } }), "résultat");
    // Le travail a fini pendant que SA question attend : la réponse est TENUE (« affichée après ta réponse »).
    expect((await orchestrationDuFil(sa.id, fil.id)).tenus).toEqual([r1.id]);
    // « fais-le plus court » : ni relance ni tour d'agent — la réponse est remise en forme par le modèle rapide.
    const d2 = await deposerEcrit(sa.id, "fais-le plus court", [], fil.id);
    expect(d2.ok && d2.voie).toBe("precision");
    expect(m.appels.miseEnForme).toBe(1);
    expect(await prisma.assistantIaTour.findFirst({ where: { filId: fil.id, role: "assistant", repondA: d1.ok ? d1.tour.id : "", contenu: { startsWith: "_Mise en forme demandée" } } })).toBeTruthy();
    expect(await prisma.assistantIaTour.count({ where: { filId: fil.id, role: "user", contenu: { startsWith: "[" } } })).toBe(0);
    expect((await orchestrationDuFil(sa.id, fil.id)).ajustes).toEqual([]);
  });
});
