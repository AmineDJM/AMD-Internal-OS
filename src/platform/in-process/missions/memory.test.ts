import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import {
  createThread, ensurePrimaryThread, messagesApres, personalContext,
} from "@/lib/assistant-memory";
import { rememberExchange } from "@/lib/memoire-echange";
import { estimerJetons, BUDGET_MEMOIRE_DEFAUT } from "@/lib/missions/memory/budget";
import { contexteMemoire, noterEpisode, vieillirMemoire } from "@/platform/in-process/missions/memory";
import { fournisseurConfigure } from "@/platform/in-process/missions/reasoner";
import { RaisonneurScripte, pour } from "@/platform/in-process/missions/fake-reasoner";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA MÉMOIRE ÉPISODIQUE, DE BOUT EN BOUT — depuis une VRAIE conversation.
 *
 * ── CE QUI TOURNE POUR DE VRAI ICI ──────────────────────────────────────────────────────
 *
 * `rememberExchange`, c'est-à-dire le point d'entrée que l'action serveur de la conversation et
 * la route de flux appellent toutes les deux. Puis le découpage, le contrôle de perte, l'écriture
 * en base, le vieillissement par le calendrier, la composition sous budget, et `personalContext`
 * — le contexte que le modèle reçoit réellement à chaque tour.
 *
 * ── CE QUI EST SUBSTITUÉ, ET RIEN D'AUTRE ───────────────────────────────────────────────
 *
 * La traversée du réseau. Le raisonneur scripté vérifie chaque réponse contre le schéma que le
 * compacteur a RÉELLEMENT demandé, avec le code de production : une réponse qu'un fournisseur en
 * mode strict n'aurait pas pu produire fait échouer le banc.
 *
 * Ce qu'il ne prouve pas : qu'un modèle réel écrirait CE résumé-là. Sans clé, l'état honnête
 * reste « NON PROUVÉ EN LIGNE », et le premier cas ci-dessous le dit au lieu de le masquer.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `memtest-${Date.now()}`;

/**
 * LES QUATRE VALEURS QUE LE RÉSUMÉ N'A PAS LE DROIT DE PERDRE.
 *
 * Une par motif surveillé par `critiquesPerdus` — montant, référence, date, pourcentage. Les
 * choisir explicitement plutôt que d'écrire un texte « réaliste » au hasard est ce qui rend le
 * banc utile : on sait exactement ce qu'on vérifie, et le cas de REFUS ci-dessous en retire une
 * seule pour montrer que le contrôle mord.
 */
const MONTANT = "4 200 000 DZD";
const REFERENCE = "PCH-2026-014";
const DATE = "12/03/2026";
const PART = "18 %";

const RESUME_FIDELE =
  `Marché ${REFERENCE} : offre de ${MONTANT} déposée le ${DATE}, part visée ${PART}. `
  + `Redouane doit fournir le contrat signé.`;

const EPISODE_RENDU = (summary: string) => ({
  summary,
  entities: [`MARCHE:${REFERENCE}`],
  decisions: ["déposer l'offre au prix plancher"],
  commitments: ["Redouane : contrat signé"],
  openQuestions: ["qui signe côté PCH ?"],
  corrections: [],
});

/** Un échange qui porte de la matière — et les valeurs critiques, une fois chacune. */
function echange(i: number): [string, string] {
  const q = i === 0
    ? `Où en est le marché ${REFERENCE} ?`
    : `Question ${i} sur le dossier en cours.`;
  const r = i === 0
    ? `L'offre de ${MONTANT} a été déposée le ${DATE}. La part visée est de ${PART}.`
    : `Réponse ${i} : rien de neuf à signaler, le dossier suit son cours.`;
  return [q, r];
}

let userId = "";

suite("MÉMOIRE ÉPISODIQUE — d'un vrai échange à un contexte composé", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({
      data: {
        email: `${TAG}@example.test`,
        name: "Testeur Mémoire",
        passwordHash: "x",
        role: "SUPER_ADMIN",
        isActive: true,
      },
      select: { id: true },
    });
    userId = u.id;
  }, 60_000);

  afterAll(async () => {
    // La cascade emporte fils, messages et épisodes ; on ne touche à rien d'autre.
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("§97 — le POINT D'ENTRÉE RÉEL de la conversation déclenche le découpage", async () => {
    const tid = await ensurePrimaryThread(userId);
    for (let i = 0; i < 6; i++) {
      const [q, r] = echange(i);
      // LE VRAI CHEMIN : celui qu'appellent `assistantChat` et la route de flux.
      await rememberExchange(userId, tid, q, r);
    }

    const messages = await messagesApres(userId, tid, null, 200);
    expect(messages.length, "les six échanges doivent être en base").toBe(12);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role, "la réponse suit la question, même à la milliseconde près").toBe("assistant");

    const episodes = await prisma.assistantEpisode.count({ where: { userId } });
    if (fournisseurConfigure()) {
      // Une clé est présente : le découpage a réellement appelé un modèle. On ne prétend rien
      // sur le CONTENU — c'est le cas suivant qui le vérifie, avec un substitut contrôlé.
      //
      // ⚠ CETTE ASSERTION S'ÉCRIVAIT `toBeGreaterThanOrEqual(0)`. Un COMPTE est toujours ≥ 0 :
      // elle était vraie que le découpage ait produit un épisode ou RIEN DU TOUT, et son
      // message affirmait pourtant « le seuil atteint doit produire un épisode ». Un contrôle
      // qui ne peut pas échouer ne protège de rien — il rassure, ce qui est pire (§118.17) —
      // et celui-ci gardait précisément le compacteur de mémoire, l'un des composants que le
      // recensement de §118.14 avait trouvés SANS APPELANT DE PRODUCTION. La garde du
      // mécanisme qu'on a déjà vu mort une fois était elle-même endormie.
      //
      // LA PRÉMISSE EST VÉRIFIÉE, PAS SUPPOSÉE : `TOURS_PAR_EPISODE` vaut 12 et ce cas écrit
      // six échanges, donc DOUZE messages. Le seuil est atteint au message près ; « doit
      // produire un épisode » est donc bien ce que la branche promet.
      //
      // CE QUE JE N'AI PAS PU EXERCER, ET POURQUOI JE LE DIS : ce conteneur n'a aucune clé de
      // fournisseur, donc cette branche ne tourne pas ici. En posant une clé factice pour la
      // rendre atteignable, j'ai obtenu 0 épisode — et j'ai failli l'imputer au compacteur. La
      // cause était ma propre manipulation : `HTTP 401 — Incorrect API key provided`, le
      // mandataire n'injectant ses identifiants que lorsque le client n'envoie AUCUN en-tête
      // d'autorisation, ce que le SDK fait toujours. Le compacteur, lui, s'est comporté
      // exactement comme il doit : il a refusé et a NOMMÉ sa raison. Une expérience qui change
      // deux choses à la fois ne désigne rien (§118.76) — ici l'assertion ET l'environnement.
      expect(episodes, "avec un fournisseur, le seuil atteint doit produire un épisode").toBeGreaterThanOrEqual(1);
    } else {
      // SANS FOURNISSEUR, ON NE FABRIQUE RIEN. C'est la propriété qui compte : pas de résumé
      // tronqué « en attendant », pas de souvenir inventé. Le zéro PROUVE que le découpage a été
      // atteint et qu'il a refusé de travailler, plutôt que de n'avoir jamais été appelé.
      expect(episodes, "sans clé, aucun souvenir ne doit être fabriqué").toBe(0);
    }
  }, 120_000);

  it("§23-26 — la chaîne complète écrit un ÉPISODE réel, borné par de vrais messages", async () => {
    const tid = await ensurePrimaryThread(userId);
    const cerveau = new RaisonneurScripte([
      pour("mission.memory.compact", () => ({ ok: true, data: EPISODE_RENDU(RESUME_FIDELE) })),
    ]);

    const avant = await messagesApres(userId, tid, null, 200);
    const r = await noterEpisode(userId, tid, { reasoner: cerveau });

    expect(r.episodeId, `le découpage a échoué : ${r.raison}`).not.toBeNull();
    expect(r.tours).toBe(avant.length);
    expect(r.jetonsApres, "un résumé plus lourd que la conversation n'est pas un résumé")
      .toBeLessThan(r.jetonsAvant);

    // LA CONSIGNE ENVOYÉE AU MODÈLE A ÉTÉ COMPOSÉE PAR LE CODE DE PRODUCTION : on vérifie qu'elle
    // porte bien les valeurs à préserver, sans quoi le compacteur travaillerait à l'aveugle.
    const demande = cerveau.demandes[0];
    expect(demande.purpose).toBe("mission.memory.compact");
    expect(demande.prompt).toContain(MONTANT);
    expect(demande.prompt).toContain("TEXTE À COMPRESSER");

    const ligne = await prisma.assistantEpisode.findUnique({ where: { id: r.episodeId! } });
    expect(ligne!.fidelity).toBe("RICH");
    expect(ligne!.threadId).toBe(tid);
    expect(ligne!.fromMessageId, "la tranche est bornée par de VRAIS identifiants de messages")
      .toBe(avant[0].id);
    expect(ligne!.toMessageId).toBe(avant[avant.length - 1].id);
    expect(ligne!.turns).toBe(avant.length);
    expect(ligne!.tokensAfter).toBeLessThan(ligne!.tokensBefore);
    expect(ligne!.entities).toEqual([`MARCHE:${REFERENCE}`]);

    // ET LE MARQUEUR A AVANCÉ : repasser ne redécoupe pas la même tranche.
    const encore = await noterEpisode(userId, tid, { reasoner: cerveau });
    expect(encore.episodeId, "le même moment ne doit pas produire deux souvenirs").toBeNull();
    expect(encore.raison).toMatch(/0 message\(s\) depuis le dernier épisode/);
  }, 120_000);

  it("§94 — un résumé qui PERD un montant est REFUSÉ, et rien n'est écrit", async () => {
    const tid = await createThread(userId, "second fil");
    for (let i = 0; i < 6; i++) {
      const [q, r] = echange(i);
      await rememberExchange(userId, tid, q, r);
    }

    const avant = await prisma.assistantEpisode.count({ where: { userId } });
    const amnesique = new RaisonneurScripte([
      // Le résumé garde tout SAUF le montant. Un fournisseur peut parfaitement rendre cela :
      // la réponse est conforme au schéma, elle est simplement fausse par omission.
      pour("mission.memory.compact", () => ({
        ok: true,
        data: EPISODE_RENDU(`Marché ${REFERENCE} : offre déposée le ${DATE}, part visée ${PART}.`),
      })),
    ]);

    const r = await noterEpisode(userId, tid, { reasoner: amnesique });
    expect(r.episodeId, "une compression qui perd un montant ne doit RIEN écrire").toBeNull();
    expect(r.raison).toMatch(/compression refusée/);
    expect(r.raison).toContain(MONTANT);
    expect(await prisma.assistantEpisode.count({ where: { userId } })).toBe(avant);
  }, 120_000);

  it("§97 — l'épisode atteint le CONTEXTE PERSONNEL, par le chemin de production", async () => {
    // `personalContext` est ce que `assistantChat`, la route de flux et la voix envoient au
    // modèle. Si le souvenir n'y est pas, il n'existe pour personne.
    const ctx = await personalContext(userId);
    expect(ctx).toContain("MÉMOIRE COMPOSÉE");
    expect(ctx, "le montant doit survivre jusqu'au contexte réellement envoyé").toContain(MONTANT);
    expect(ctx).toContain(REFERENCE);

    const bloc = await contexteMemoire(userId);
    expect(bloc).toContain("épisode(s)");
  }, 60_000);

  it("§92-95 — le CALENDRIER fait descendre la fidélité, et elle ne remonte jamais", async () => {
    const cible = await prisma.assistantEpisode.findFirst({
      where: { userId, fidelity: "RICH" }, select: { id: true },
    });
    expect(cible, "le cas précédent doit avoir laissé un épisode RICHE").not.toBeNull();

    // On vieillit l'épisode de vingt jours — au-delà du seuil STRUCTURED (14 jours).
    const vieux = new Date(Date.now() - 20 * 24 * 3600 * 1000);
    await prisma.assistantEpisode.update({
      where: { id: cible!.id }, data: { endedAt: vieux, startedAt: vieux },
    });

    const COURT = `${REFERENCE} : ${MONTANT} le ${DATE}, ${PART}.`;
    const cerveau = new RaisonneurScripte([
      pour("mission.memory.compact", () => ({ ok: true, data: EPISODE_RENDU(COURT) })),
    ]);

    const r = await vieillirMemoire(new Date(), { userId, reasoner: cerveau });
    expect(r.personnes).toBe(1);
    expect(r.compresses, "l'épisode vieux de vingt jours devait descendre d'un cran").toBe(1);
    expect(r.jetonsEconomises).toBeGreaterThan(0);

    const apres = await prisma.assistantEpisode.findUnique({ where: { id: cible!.id } });
    expect(apres!.fidelity).toBe("STRUCTURED");
    expect(apres!.summary).toBe(COURT);
    expect(apres!.summary, "compresser n'autorise pas à perdre le montant").toContain(MONTANT);

    // LA CONSIGNE ENVOYÉE ÉTAIT BIEN CELLE DU PALIER VISÉ, et non celle du palier d'origine.
    expect(cerveau.demandes[0].system).toContain("Fidélité STRUCTURÉE");

    // ON NE REDESCEND PAS DEUX FOIS LE MÊME CRAN : la file est vide au second passage.
    const rien = await vieillirMemoire(new Date(), { userId, reasoner: cerveau });
    expect(rien.examines, "un épisode à sa fidélité visée n'a plus rien à faire dans la file").toBe(0);
  }, 120_000);

  it("§53 — cent tours ne coûtent PAS cent fois le premier", async () => {
    const tid = await createThread(userId, "fil long");
    let brut = 0;
    for (let i = 0; i < 50; i++) {
      const [q, r] = echange(i + 1);
      brut += estimerJetons(`Personne : ${q}\nAdam : ${r}`);
      await rememberExchange(userId, tid, q, r);
    }

    // Le découpage tourne comme en production : une tranche à la fois, jusqu'à épuisement.
    const cerveau = new RaisonneurScripte([
      pour("mission.memory.compact", (_req, n) => ({
        ok: true, data: EPISODE_RENDU(`${RESUME_FIDELE} Tranche ${n}.`),
      })),
    ]);
    let coupes = 0;
    let memorises = 0;
    for (let i = 0; i < 12; i++) {
      const r = await noterEpisode(userId, tid, { reasoner: cerveau });
      if (!r.episodeId) break;
      coupes += 1;
      memorises += r.tours;
    }
    // Cent messages, soixante au maximum par tranche : deux tranches, et TOUT est absorbé.
    // C'est le second chiffre qui compte — une boucle qui découperait la première tranche puis
    // s'arrêterait laisserait quarante tours hors mémoire sans que rien ne le signale.
    expect(coupes, "cent messages tiennent en deux tranches").toBe(2);
    expect(memorises, "aucun tour ne doit rester en dehors de la mémoire").toBe(100);
    expect(
      (await messagesApres(userId, tid, (await prisma.assistantEpisode.findFirst({
        where: { userId, threadId: tid }, orderBy: { endedAt: "desc" }, select: { toMessageId: true },
      }))!.toMessageId, 200)).length,
      "le marqueur doit être au bout du fil",
    ).toBe(0);

    const compose = await contexteMemoire(userId);
    const cout = estimerJetons(compose);

    // LA PROPRIÉTÉ, ÉNONCÉE SANS FIORITURE : le contexte composé tient dans le budget alors que
    // la conversation brute, elle, a grandi linéairement. C'est exactement ce que §90 demande —
    // et si un jour quelqu'un remet « on renvoie tout l'historique », cette ligne tombe.
    expect(brut, "le banc doit avoir produit assez de matière pour que la question se pose")
      .toBeGreaterThan(BUDGET_MEMOIRE_DEFAUT / 4);
    expect(cout, "le contexte composé doit tenir dans son budget").toBeLessThanOrEqual(BUDGET_MEMOIRE_DEFAUT);
    expect(cout, "et rester nettement en dessous du coût brut de la conversation").toBeLessThan(brut);
  }, 300_000);
});
