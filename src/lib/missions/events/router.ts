import { prisma } from "@/lib/prisma";
import type { MissionStatus } from "@prisma/client";
import { lireReponse } from "@/lib/missions/runtime/reponse";
import { journaliser } from "@/lib/missions/runtime/store";
import { Attente, FaitObserve, correspond, decomposer, echue, etatAttente, lireAttente, lireProgres } from "@/lib/missions/events/match";
import { ETATS_REPLANIFIABLES } from "@/lib/missions/runtime/replan";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE ROUTEUR D'ÉVÉNEMENTS — ce qui fait qu'une mission se réveille toute seule (§18).
 *
 * ── CE QU'IL N'EST PAS ───────────────────────────────────────────────────────────────────
 *
 * Ce n'est PAS un second registre d'événements. `BusinessEvent` existe, `recordEvent` en est la
 * seule porte, et il porte déjà `missionId`. En créer un deuxième donnerait deux histoires de
 * la même entreprise, dont l'une serait fausse (§17).
 *
 * Ce n'est PAS non plus un ordonnanceur. Il ne fait pas tourner de mission : il RÈGLE les
 * attentes qui viennent d'être satisfaites, et rend la liste des missions concernées. C'est
 * l'ordonnanceur déjà en place qui les fera avancer (§39).
 *
 * ── POURQUOI CETTE SÉPARATION EST NÉCESSAIRE, ET PAS SEULEMENT PROPRE ────────────────────
 *
 * `recordEvent` est appelé DEPUIS l'écriture métier — le dépôt d'un contrat, la réception d'un
 * mail. Si le réveil faisait tourner la mission sur place, le dépôt d'un contrat attendrait la
 * fin d'une mission de trente-trois envois avant de rendre la main.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface Reveil {
  missionId: string;
  stepKey: string;
}

/**
 * RÈGLE LES ATTENTES QUE CE FAIT SATISFAIT.
 *
 * ── LE CADRAGE PAR MISSION ───────────────────────────────────────────────────────────────
 *
 * Quand le fait porte un `missionId`, seules les étapes de CETTE mission sont candidates. Un
 * événement émis dans le cadre d'une mission ne doit pas en réveiller une autre qui attendait
 * quelque chose de ressemblant — le nom d'une personne suffirait à confondre deux dossiers.
 *
 * ── NE JAMAIS FAIRE TOMBER L'ÉMETTEUR ────────────────────────────────────────────────────
 *
 * Comme `recordEvent`, cette fonction avale ses erreurs. L'écriture métier qui a produit le
 * fait doit réussir même si aucune mission ne peut être réveillée : l'inverse ferait échouer un
 * dépôt de contrat à cause d'une mission mal formée.
 */
export async function reveillerMissions(fait: FaitObserve): Promise<Reveil[]> {
  try {
    const enAttente = await prisma.missionStep.findMany({
      where: {
        status: "WAITING",
        nodeType: "WAIT_EVENT",
        mission: {
          status: { notIn: ["COMPLETED", "CANCELLED"] },
          ...(fait.missionId ? { id: fait.missionId } : {}),
        },
      },
      select: { id: true, missionId: true, key: true, title: true, waitFor: true, result: true },
    });

    const reveils: Reveil[] = [];
    const maintenant = new Date();
    for (const step of enAttente) {
      const attente = lireAttente(step.waitFor);
      if (!attente) continue;
      const etat = etatAttente(attente, lireProgres(step.result), fait, maintenant);
      // Rien de neuf ET pas complète : on passe. Une progression persistée déjà COMPLÈTE sur une
      // étape encore WAITING (reprise après un crash entre l'écriture et la suite) se finalise :
      // le réveil est idempotent, jamais une attente figée avec toutes ses branches réglées.
      if (etat.nouvelles.length === 0 && !etat.complete) continue;

      if (!etat.complete) {
        /**
         * UNE BRANCHE SUR PLUSIEURS (« le contrat ET le devis ») : la PROGRESSION se persiste,
         * l'attente reste ouverte. La mémoire est en base — un redémarrage entre le contrat et
         * le devis ne redemande pas le contrat.
         */
        await prisma.missionStep.updateMany({
          where: { id: step.id, status: "WAITING" },
          data: { result: { attenteProgres: etat.reglees } as never },
        });
        await journaliser(step.missionId, "EVENT_PARTIAL",
          `« ${step.title} » : une des conditions attendues est arrivée (${fait.type}) — l'attente continue.`,
          { stepKey: step.key, event: fait.type, branchesReglees: etat.reglees });
        continue;
      }

      // LA MISE À JOUR EST CONDITIONNÉE À L'ÉTAT ATTENDU : deux faits qui arrivent en même
      // temps ne doivent pas régler deux fois la même attente, et c'est la base qui tranche.
      const r = await prisma.missionStep.updateMany({
        where: { id: step.id, status: "WAITING" },
        data: {
          status: "DONE",
          completedAt: maintenant,
          result: {
            reveillePar: fait.type,
            // La parole de la personne AVANT l'enveloppe : c'est elle qu'une étape aval doit lire.
            ...lireReponse(fait.payload),
            payload: (fait.payload ?? null) as never,
            attenteProgres: etat.reglees,
          } as never,
        },
      });
      if (r.count !== 1) continue;

      await journaliser(step.missionId, "EVENT_WAKE",
        `« ${step.title} » : l'événement attendu (${fait.type}) est arrivé.`,
        { stepKey: step.key, event: fait.type });
      reveils.push({ missionId: step.missionId, stepKey: step.key });
    }

    /**
     * ── UNE INFORMATION NEUVE ROUVRE LE DROIT DE REPLANIFIER (§118.42) ────────────────────
     *
     * `replanBloque` dit « le planificateur a buté deux fois sur le même refus ». Cette phrase
     * n'est vraie que TANT QUE rien n'a changé. Une réponse humaine qui arrive change tout : le
     * refus portait sur un plan écrit sans elle.
     *
     * C'est ici, et pas dans le balayage des échéances : le TEMPS QUI PASSE n'est pas une
     * information neuve. Une mission bloquée sur un refus de compilation ne se débloque pas
     * parce qu'on a attendu — elle se débloque parce que quelqu'un a répondu.
     *
     * On ne relance rien : c'est le battement qui conduit. On lui rend le droit de regarder
     * cette mission, qu'un blocage devenu périmé lui interdisait.
     */
    const reveillees = [...new Set(reveils.map((r) => r.missionId))];
    if (reveillees.length > 0) {
      await prisma.mission.updateMany({
        where: { id: { in: reveillees }, replanBloque: true },
        data: { replanBloque: false, replanRefus: null },
      }).catch(sansBloquer("router.reveillerMissions.mission"));
    }

    /**
     * ═══════════════════════════════════════════════════════════════════════════════════════
     * UN FAIT ADRESSÉ À UNE MISSION QUE PLUS AUCUNE ATTENTE NE CONSOMME NE DISPARAÎT PAS.
     *
     * ── LE DÉFAUT, MESURÉ SUR LE CAS ADVERSE « CONTRADICTION » (§90) ──────────────────────
     *
     * Khaled répond « prix de cession Nivolex : 84 500 DZD », l'attente se règle, la mission
     * avance. Puis Khaled se reprend : « Correction : c'est 91 000, pas 84 500. » Ce second
     * message n'a plus d'attente à régler — et cette fonction ne regarde QUE les étapes
     * `WAITING`. Elle a donc rendu `[]`, silencieusement. Vérifié en base après deux runs
     * live : le chiffre corrigé n'apparaît NULLE PART, ni dans une étape, ni dans le journal,
     * ni dans une notification. La mission a conclu sur un chiffre que son auteur avait
     * démenti — aucune étape en échec, aucun signal. C'est le faux succès parfait.
     *
     * ── CE QU'ON FAIT, ET CE QU'ON NE FAIT PAS ────────────────────────────────────────────
     *
     * On JOURNALISE. Pas de seconde table (§118.5) : `MissionEvent` EST le journal, et le
     * contrôle comme le compte rendu exécutif le relisent. On ne rejoue pas la mission, on ne
     * réécrit aucun résultat, on n'invente aucune décision — ce serait décider à la place d'un
     * humain sur la foi d'un message. Le fait devient VISIBLE, ce qu'il n'était pas.
     *
     * ── POURQUOI CE FILET NE PEUT PAS DEVENIR DU BRUIT ────────────────────────────────────
     *
     * Il ne se déclenche QUE si le fait NOMME cette mission (`fait.missionId`). Un événement
     * ERP quelconque, qui traverse toutes les missions ouvertes, n'écrit rien : il n'est adressé
     * à aucune. Seul ce qui visait déjà cette mission-là et n'a trouvé personne est consigné.
     */
    if (fait.missionId && reveils.length === 0) {
      const apercu = apercuDuFait(fait);
      await journaliser(fait.missionId, "EVENT_ORPHELIN",
        `Message reçu HORS ATTENTE (${fait.type})${apercu ? ` : ${apercu}` : ""} — aucune attente ouverte ne l'attendait. `
        + `Il n'a modifié aucune étape ; à relire avant de conclure.`,
        { event: fait.type, from: apercuExpediteur(fait), horsAttente: true });
    }
    return reveils;
  } catch (err) {
    console.error("[missions] réveil impossible", fait.type, err);
    return [];
  }
}

/** Le texte d'un fait, borné — assez pour qu'un humain reconnaisse le message, jamais le corps entier. */
function apercuDuFait(fait: FaitObserve): string {
  const p = (fait.payload ?? {}) as Record<string, unknown>;
  const bout = [p.subject, p.body, p.text].find((x) => typeof x === "string" && x.trim() !== "");
  const t = typeof bout === "string" ? bout.replace(/\s+/g, " ").trim() : "";
  return t.length > 220 ? `${t.slice(0, 220)}…` : t;
}

function apercuExpediteur(fait: FaitObserve): string | null {
  const p = (fait.payload ?? {}) as Record<string, unknown>;
  const q = [p.from, p.fromName, p.fromEmail].find((x) => typeof x === "string" && x.trim() !== "");
  return typeof q === "string" ? q.slice(0, 120) : null;
}

/**
 * RÈGLE LES ATTENTES QUE LE TEMPS SATISFAIT — le WAIT_FOR_TIME du runtime (§temps).
 *
 * « Analyse aujourd'hui, reviens demain 10 h » n'est PAS un `setTimeout` : l'échéance vit dans
 * `waitFor.until`, en base, et ce balayage — appelé par le battement, l'horloge EN PARAMÈTRE —
 * la découvre après n'importe quel redémarrage. L'écriture est conditionnée à `WAITING` :
 * deux battements concurrents (ou un battement rejoué) ne règlent l'attente qu'UNE fois.
 */
export async function reveillerAttentesTemporelles(
  maintenant = new Date(),
  /** BANC SEULEMENT (J2) : borne le réveil à ces missions — la suite partage une base, et une horloge simulée en avance réveillerait les attentes des voisins. */
  seulement?: readonly string[],
): Promise<Reveil[]> {
  try {
    const vivante = { status: { notIn: ["COMPLETED", "CANCELLED"] as MissionStatus[] } };
    const enAttente = await prisma.missionStep.findMany({
      where: { status: "WAITING", nodeType: "WAIT_EVENT", mission: seulement ? { ...vivante, id: { in: [...seulement] } } : vivante },
      select: { id: true, missionId: true, key: true, title: true, waitFor: true, result: true },
    });

    const reveils: Reveil[] = [];
    for (const step of enAttente) {
      const attente = lireAttente(step.waitFor);
      if (!attente) continue;
      const etat = etatAttente(attente, lireProgres(step.result), null, maintenant);
      // Rien de neuf ET pas complète : on passe. Une progression persistée déjà COMPLÈTE sur une
      // étape encore WAITING (reprise après un crash entre l'écriture et la suite) se finalise :
      // le réveil est idempotent, jamais une attente figée avec toutes ses branches réglées.
      if (etat.nouvelles.length === 0 && !etat.complete) continue;

      if (!etat.complete) {
        await prisma.missionStep.updateMany({
          where: { id: step.id, status: "WAITING" },
          data: { result: { attenteProgres: etat.reglees } as never },
        });
        await journaliser(step.missionId, "TIME_PARTIAL",
          `« ${step.title} » : l'échéance d'une des conditions est passée — l'attente continue.`,
          { stepKey: step.key, branchesReglees: etat.reglees });
        continue;
      }

      const r = await prisma.missionStep.updateMany({
        where: { id: step.id, status: "WAITING" },
        data: {
          status: "DONE",
          completedAt: maintenant,
          // MÊMES CLÉS QUE L'ATTENTE RÉGLÉE PAR UN FAIT (§118.20) : personne n'a répondu, et
          // c'est la VALEUR qui le dit — pas l'absence du champ.
          result: { reveillePar: "TEMPS", ...lireReponse(null), instant: maintenant.toISOString(), attenteProgres: etat.reglees } as never,
        },
      });
      if (r.count !== 1) continue;

      await journaliser(step.missionId, "TIME_WAKE",
        `« ${step.title} » : le moment attendu est arrivé.`,
        { stepKey: step.key, instant: maintenant.toISOString() });
      reveils.push({ missionId: step.missionId, stepKey: step.key });
    }
    return reveils;
  } catch (err) {
    console.error("[missions] réveil temporel impossible", err);
    return [];
  }
}

/**
 * RÈGLE UNE ATTENTE HUMAINE (§79) — quelqu'un a fourni ce qu'on lui demandait.
 *
 * Séparée du réveil par événement à dessein : ici, une PERSONNE agit, et l'audit doit dire
 * laquelle. Un réveil par événement n'a pas d'auteur au même sens.
 */
export async function fournirEntree(
  missionId: string,
  stepKey: string,
  contenu: unknown,
  parQui: string,
): Promise<boolean> {
  const step = await prisma.missionStep.findUnique({
    where: { missionId_key: { missionId, key: stepKey } },
    select: { id: true, status: true, nodeType: true, title: true },
  });
  if (!step || step.nodeType !== "WAIT_INPUT" || step.status !== "WAITING") return false;

  const r = await prisma.missionStep.updateMany({
    where: { id: step.id, status: "WAITING" },
    data: { status: "DONE", completedAt: new Date(), result: { fourniPar: parQui, contenu } as never },
  });
  if (r.count !== 1) return false;

  await journaliser(missionId, "INPUT_PROVIDED",
    `« ${step.title} » : l'élément demandé a été fourni.`, { stepKey }, parQui);
  return true;
}

/**
 * LES ATTENTES DONT L'ÉCHÉANCE EST PASSÉE — matière à RELANCE, pas à échec (§87).
 *
 * On rend l'information ; on ne décide pas. Ce qu'on fait d'une attente en retard — relancer,
 * changer de canal, demander au PDG — relève de la politique, pas du routage.
 */
export async function attentesEchues(maintenant = new Date()) {
  const steps = await prisma.missionStep.findMany({
    where: {
      status: "WAITING",
      nodeType: { in: ["WAIT_EVENT", "WAIT_INPUT"] },
      mission: { status: { notIn: ["COMPLETED", "CANCELLED"] } },
    },
    select: {
      id: true, missionId: true, key: true, title: true, waitFor: true, updatedAt: true,
      mission: { select: { ownerId: true, title: true } },
    },
  });

  const out: {
    missionId: string; ownerId: string; missionTitle: string;
    stepKey: string; stepTitle: string; attente: Attente; depuis: Date;
  }[] = [];

  for (const s of steps) {
    const attente = lireAttente(s.waitFor);
    if (!attente || !echue(attente, s.updatedAt, maintenant)) continue;
    out.push({
      missionId: s.missionId,
      ownerId: s.mission.ownerId,
      missionTitle: s.mission.title,
      stepKey: s.key,
      stepTitle: s.title,
      attente,
      depuis: s.updatedAt,
    });
  }
  return out;
}

/**
 * LES MISSIONS QUI PEUVENT AVANCER MAINTENANT — la question que pose l'ordonnanceur.
 *
 * Une mission est candidate si elle n'est ni terminée ni annulée ET qu'il lui reste au moins
 * une étape qui n'attend plus rien. Le filtre est volontairement LARGE : le moteur, lui, sait
 * dire « rien à faire » en un tour et sans effet de bord. Rater une mission prête coûterait
 * plus cher qu'un tour à vide.
 */
export async function missionsAFaireAvancer(limite = 20): Promise<string[]> {
  const rows = await prisma.mission.findMany({
    where: {
      kind: "RUNTIME",
      // `PAUSED` est écarté ICI, à la source, et non dans le balayage. Une mission suspendue qui
      // remonterait comme candidate serait chargée, examinée et reposée à chaque battement — et
      // il suffirait qu'un appelant oublie le filtre pour qu'elle reparte. Le seul endroit qui
      // répond « qui peut avancer ? » doit répondre juste.
      status: { notIn: ["COMPLETED", "CANCELLED", "PAUSED"] },
      OR: [
        { steps: { some: { status: { in: ["PENDING", "FAILED"] } } } },
        /**
         * ── LA MISSION DONT TOUT A ABOUTI ET QUE LE JUGE A REFUSÉE ────────────────────
         *
         * Elle ne porte AUCUNE étape PENDING ni FAILED : le premier filtre ne la voyait pas,
         * donc le battement ne la conduisait pas, donc `replanifierMission` — qui prévoit
         * pourtant ce cas sous le nom `objectifManque` — n'était jamais appelée pour elle.
         * Une mission de composition dont le plan a simplement oublié l'étape CALCUL ou
         * DOCUMENT mourait BLOCKED après son unique tour de lancement.
         *
         * ── CE QUI ARRÊTE LA BOUCLE, ET CE QUI NE L'ARRÊTE PLUS (§118.42) ────────────
         *
         * Ce n'était PAS un plafond de plans. Un compteur global tuait une mission de sept
         * jalons parce qu'un seul d'entre eux s'y reprenait à quatre fois. C'est maintenant
         * `replanBloque` : vrai quand le planificateur a buté DEUX FOIS SUR LE MÊME REFUS,
         * c'est-à-dire quand un tour de plus rendrait la même réponse, plus chère.
         *
         * Et il se remet à FAUX dès qu'une information neuve arrive — une réponse humaine, un
         * événement, une consigne. C'est la différence entre « il tourne en rond » et « on ne
         * lui avait rien donné de nouveau », et un compteur ne savait pas la faire.
         */
        { status: { in: [...ETATS_REPLANIFIABLES] }, replanBloque: false },
        /**
         * ── LA MISSION LONGUE ENTRE DEUX JALONS (§118.46) ───────────────────────────
         *
         * MESURÉ SUR UN RUN LIVE : une mission de sept jalons, jalon 1 compilé et ses onze
         * étapes toutes terminées, jalons 2 à 7 pas encore compilés — donc ZÉRO étape PENDING
         * ou FAILED en base, et un statut RUNNING qui n'est pas replanifiable. Aucune des deux
         * branches précédentes ne la voyait. Le battement ne la reprenait jamais, et la mission
         * mourait à son PREMIER jalon : la compilation paresseuse était écrite, testée, et sans
         * effet en production (§118.14).
         *
         * C'est l'état NORMAL d'une mission longue entre deux jalons, pas une anomalie. Un
         * jalon vivant EST du travail à faire, exactement comme une étape PENDING — il n'a
         * simplement pas encore d'étapes, parce que c'est le principe.
         */
        { milestones2: { some: { statut: { notIn: ["DONE", "SKIPPED", "CANCELLED"] } } } },
      ],
    },
    select: { id: true },
    // LA PRIORITÉ D'ABORD (« celle-ci devient prioritaire »), l'ancienneté ensuite — une
    // mission prioritaire passe devant, mais aucune mission ne meurt de faim : à priorité
    // égale, la plus ancienne est servie la première.
    orderBy: [{ priority: "desc" }, { updatedAt: "asc" }],
    take: limite,
  });
  return rows.map((r) => r.id);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FAITS ARRIVÉS AVANT L'ATTENTE — « événements dans le désordre ».
 *
 * Le réveil n'écoute que les étapes déjà WAITING. Or une réponse peut arriver AVANT que
 * l'attente n'existe : pendant que la mission attend son accord, pendant la lecture qui précède,
 * entre le plan et le premier tour. Sans rattrapage, la mission attendait un fait déjà inscrit
 * au registre — jusqu'à l'échéance, puis relançait quelqu'un qui avait répondu.
 *
 * ── LA FENÊTRE, OU POURQUOI ON NE RAMASSE PAS N'IMPORTE QUOI ────────────────────────────
 *
 * Un fait antérieur à la DEMANDE n'est pas une réponse : le message de Sarah d'hier ne répond
 * pas à celui qu'on lui envoie ce matin. La fenêtre commence donc à la fin de la dernière
 * dépendance qui ÉCRIT (la demande elle-même) ; sans écriture en amont, à la création de la
 * mission — jamais avant. Un fait cadré sur une AUTRE mission est ignoré.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export async function rattraperFaitAnterieur(opts: {
  missionId: string;
  stepKey: string;
  attente: Attente;
  dejaReglees: readonly number[];
  /** Les clés des dépendances qui écrivent (la demande dont on attend la réponse). */
  clesEcritures: readonly string[];
  maintenant?: Date;
}): Promise<{ complete: boolean; reglees: number[]; fait: FaitObserve | null }> {
  const reglees = [...opts.dejaReglees];
  const types = [...new Set(decomposer(opts.attente).branches.map((b) => b.event).filter((e): e is string => Boolean(e)))];
  if (types.length === 0) return { complete: false, reglees, fait: null };
  try {
    const mission = await prisma.mission.findUnique({ where: { id: opts.missionId }, select: { createdAt: true } });
    if (!mission) return { complete: false, reglees, fait: null };
    let depuis = mission.createdAt;
    if (opts.clesEcritures.length > 0) {
      const ecritures = await prisma.missionStep.findMany({
        where: { missionId: opts.missionId, key: { in: [...opts.clesEcritures] } }, select: { completedAt: true },
      });
      const fins = ecritures.map((e) => e.completedAt?.getTime() ?? null);
      // Une écriture amont sans date de fin : la fenêtre ne peut pas s'ouvrir — on n'invente pas.
      if (fins.some((f) => f === null)) return { complete: false, reglees, fait: null };
      depuis = new Date(Math.max(depuis.getTime(), ...(fins as number[])));
    }
    const faits = await prisma.businessEvent.findMany({
      where: { type: { in: types }, occurredAt: { gte: depuis }, OR: [{ missionId: null }, { missionId: opts.missionId }] },
      orderBy: { occurredAt: "asc" }, take: 200,
      select: { type: true, actorId: true, entityType: true, entityId: true, relatedRefs: true, payload: true, missionId: true },
    });
    // LES FAITS SEULS règlent une branche ici — jamais le temps. Une échéance passée est
    // l'affaire du balayage temporel (une seule source pour « le moment est arrivé ») ; la
    // laisser régler une branche au passage attribuerait le réveil au premier fait venu, d'un
    // autre fil, et une branche « sinon » (TIMEOUT) partirait pour une réponse qui n'existe pas.
    const { mode, branches } = decomposer(opts.attente);
    const acquis = new Set(reglees.filter((i) => i >= 0 && i < branches.length));
    for (const f of faits) {
      const fait: FaitObserve = { type: f.type, actorId: f.actorId, entityType: f.entityType, entityId: f.entityId, relatedRefs: f.relatedRefs, payload: f.payload, missionId: f.missionId };
      let nouveau = false;
      for (const [i, b] of branches.entries()) {
        if (acquis.has(i) || !correspond(b, fait)) continue;
        acquis.add(i);
        nouveau = true;
      }
      if (!nouveau) continue;
      const complete = mode === "ANY" ? acquis.size > 0 : acquis.size === branches.length;
      if (complete) {
        await journaliser(opts.missionId, "EVENT_CATCHUP",
          `« ${opts.stepKey} » : le fait attendu (${f.type}) était déjà arrivé, après ${opts.clesEcritures.length > 0 ? "la demande" : "le lancement"} — l'attente est réglée sans attendre.`,
          { stepKey: opts.stepKey, event: f.type, depuis: depuis.toISOString() });
        return { complete: true, reglees: [...acquis].sort((a, b) => a - b), fait };
      }
    }
    return { complete: false, reglees: [...acquis].sort((a, b) => a - b), fait: null };
  } catch (err) {
    console.error("[missions] rattrapage des faits antérieurs impossible", err);
    return { complete: false, reglees, fait: null };
  }
}
