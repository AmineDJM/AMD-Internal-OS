import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { sansBloquer } from "@/lib/journal";
import { avancer, type EngineDeps, type StepContext, type StepOutcome } from "@/lib/missions/runtime/engine";
import { compter, journaliser, type EtatEtape, type EtatMission } from "@/lib/missions/runtime/store";
import { rendreBail } from "@/lib/missions/runtime/bail";
import { vueParentEventail } from "@/lib/missions/runtime/worker";
import { mettreEnPause, reprendre } from "@/lib/missions/runtime/control";
import { systemClock, type CapabilityCatalog, type CapabilityOutcome, type CapabilityRunner, type Clock, type MissionActor, type PorteAttention } from "@/lib/missions/ports";
import type { LecteurInterrupteur } from "@/lib/interrupteurs/missions";
import type { JugeObjectif } from "@/lib/missions/goal/evaluate";
import type { CapabilityMeta } from "@/lib/missions/registry/capability-meta";
import { PREFIXE, decouperEnLots, type GesteAutorise } from "@/lib/missions/travaux/plan";
import type { PersonaTravaux } from "@/lib/missions/travaux/persona";
import { carnetPourEtape, ecrireAuCarnet, lireCarnet } from "@/lib/missions/travaux/carnet";
import { cloreEcriture, reclamerEcriture } from "@/lib/missions/travaux/ecritures";
import { consigneAnalyse, consigneLivrable, lireAnalyse, texteEtape } from "@/lib/missions/travaux/consignes";
import { MOTIF_BUDGET, MOTIF_DROITS, motifPlafond } from "@/lib/missions/travaux/regles";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CONDUIRE UN TRAVAIL (J2, décision 0016) — le Mission Runtime, sans rien lui ajouter de moteur.
 *
 * Un passage = quelques VAGUES de `avancer` (un tour chacune). Entre deux vagues, trois questions,
 * dans cet ordre, et c'est ici seulement qu'elles se posent :
 *
 *   1. la personne a-t-elle ENCORE le droit de faire travailler la persona ? (relu en base) — non :
 *      le travail se met en pause (motif DROITS), la personne est prévenue ;
 *   2. un PLAFOND est-il atteint (le travail, le mois de la personne, les jetons du jour) ? — oui :
 *      le travail DORT (pause motif BUDGET_HOLD), il n'échoue pas ; le passage suivant le réveille
 *      seul quand le plafond le permet de nouveau ;
 *   3. reste-t-il quelque chose à faire MAINTENANT ? — non : on rend la main ; une attente
 *      d'événement ou une minuterie dort en base, sans processus.
 *
 * Tout le reste est le moteur : chaque étape écrit son résultat dès qu'elle finit (le point de
 * reprise), une étape « en cours » d'un processus mort est reprise, un éventail se déploie, une
 * attente se règle par un fait ou par le temps, une condition se lit. Ce fichier ne fournit que ce
 * que le moteur attend d'un appelant : un exécutant de capacités (lectures et gestes par la persona,
 * lots par le code), deux gestionnaires de nœud (analyse, livrable), un juge et une porte d'attention.
 *
 * LE GESTE : il n'est permis que s'il figure dans la liste APPROUVÉE avec le plan, ET si la console
 * l'ouvre encore à la personne (relu juste avant), ET si son reçu n'est pas déjà clos — un geste
 * fait n'est jamais refait, un geste interrompu n'est jamais rejoué (`ecritures.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface DepsTravaux {
  persona: PersonaTravaux;
  clock?: Clock;
  /** Vagues au plus par passage (une vague = un tour du moteur). */
  vagues?: number;
  /** Durée au plus d'un passage : le battement sert aussi le reste de l'ERP. */
  dureeMaxMs?: number;
  interrupteur?: LecteurInterrupteur;
  /** RÉSERVÉ AUX TESTS : un point d'arrêt juste après qu'un geste a été fait et son reçu clos (redémarrage simulé). */
  sondes?: { apresGeste?: (stepKey: string) => Promise<void> };
}

export interface BilanConduite {
  travailId: string;
  statut: string | null;
  vagues: number;
  executees: number;
  echouees: number;
  /** Pourquoi le passage s'est arrêté avant la fin, quand ce n'est pas « plus rien à faire maintenant ». */
  arret?: "DROITS" | "BUDGET" | "BAIL" | "INTERRUPTEUR" | "DUREE" | "NON_APPROUVE" | "EN_PAUSE";
}

const TERMINAUX = new Set(["COMPLETED", "CANCELLED"]);
const OCCUPE = new Set(["RUNNING", "READY", "RETRYING"]);

const metaTravail = (n: string): CapabilityMeta => {
  const geste = n.startsWith(PREFIXE.geste);
  const lots = n === PREFIXE.lots;
  return {
    id: n, domain: "travaux", effect: geste ? "INTERNAL_REVERSIBLE_WRITE" : lots ? "ANALYZE" : "READ",
    idempotent: !geste, batchable: true, latency: "MEDIUM", confirmation: "NEVER", contrat: "LIBRE", declared: true,
    primitive: geste ? "ACTION" : lots ? "CALCUL" : "INFORMATION",
  };
};

/** Le catalogue que le moteur consulte : il ne connaît QUE les trois familles de capacités d'un travail. */
export const CATALOGUE_TRAVAUX: CapabilityCatalog = {
  has: (n) => n.startsWith(PREFIXE.lecture) || n.startsWith(PREFIXE.geste) || n === PREFIXE.lots,
  allowed: () => true,
  meta: metaTravail,
  brief: () => [],
  plafondEffet: "INTERNAL_REVERSIBLE_WRITE",
};

/** LE JUGE D'UN TRAVAIL — le contrôle qualité du moteur a déjà vérifié que tout a abouti ; le plan approuvé EST le critère. */
const JUGE_TRAVAIL: JugeObjectif = {
  juger: async () => ({ satisfait: true, raison: "Toutes les étapes du plan approuvé ont abouti, ou ont été écartées avec leur motif.", recoursSuggere: null }),
};

export function lireGestesAutorises(v: unknown): GesteAutorise[] {
  return (Array.isArray(v) ? v : [])
    .filter((g): g is GesteAutorise => !!g && typeof g === "object" && typeof (g as GesteAutorise).nom === "string")
    .map((g) => ({ nom: g.nom, libelle: String(g.libelle ?? g.nom), famille: String(g.famille ?? ""), libelleFamille: String(g.libelleFamille ?? "") }));
}

/** Une sortie d'outil (souvent du JSON en texte) rendue STRUCTURÉE quand elle l'est : `{{lecture.items}}` doit pouvoir la lire. */
function sortieStructuree(sortie: unknown): { output: unknown; structured: boolean } {
  if (typeof sortie !== "string") return { output: sortie, structured: !!sortie && typeof sortie === "object" };
  const t = sortie.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const v = JSON.parse(t) as unknown;
      return { output: Array.isArray(v) ? { items: v, count: v.length } : v, structured: true };
    } catch { /* du texte qui commence par une accolade : rendu tel quel */ }
  }
  return { output: { texte: sortie }, structured: false };
}

const echec = (kind: string, message: string, retryable: boolean): CapabilityOutcome => ({ ok: false, output: null, error: { kind, message, retryable } });

/** Les sorties des étapes dont dépend celle-ci — l'éventail vu par ses filles, jamais par sa comptabilité. */
function sortiesAmont(etat: EtatMission, step: EtatEtape): { cle: string; titre: string; sortie: unknown }[] {
  return step.dependsOn.flatMap((cle) => {
    const s = etat.steps.find((x) => x.key === cle);
    if (!s || s.status !== "DONE" || s.nodeType === "JOIN") return [];
    return [{ cle, titre: s.title, sortie: vueParentEventail(s, etat) ?? s.result }];
  });
}

export async function conduireTravail(travailId: string, deps: DepsTravaux): Promise<BilanConduite> {
  // `opts` : le passe-plat de l'interrupteur s'écrit ainsi (cliquet `suspension.test.ts` — la production ne l'injecte jamais).
  const opts = deps;
  const clock = deps.clock ?? systemClock;
  const persona = deps.persona;
  const bilan: BilanConduite = { travailId, statut: null, vagues: 0, executees: 0, echouees: 0 };
  const lire = () => prisma.mission.findFirst({
    where: { id: travailId, kind: "TRAVAIL" },
    select: {
      id: true, title: true, status: true, principalId: true, planApprouveLe: true, pausedReason: true,
      costUsd: true, plafondUsd: true, gestesAutorises: true, persona: true,
    },
  });
  let m = await lire();
  if (!m) return bilan;
  bilan.statut = m.status;
  if (!m.planApprouveLe || !m.principalId) return { ...bilan, arret: "NON_APPROUVE" };
  if (TERMINAUX.has(m.status) || m.persona !== persona.persona) return bilan;
  const principalId = m.principalId;

  const motifBudget = async (): Promise<string | null> => {
    const p = await persona.plafonds(principalId);
    const f = await prisma.mission.findUnique({ where: { id: travailId }, select: { costUsd: true, plafondUsd: true } });
    return motifPlafond({
      coutTravailUsd: f?.costUsd ?? 0, plafondTravailUsd: f?.plafondUsd ?? p.travailUsd,
      depenseMoisUsd: p.depenseMoisUsd, plafondMensuelUsd: p.mensuelUsd, jourAtteint: p.jourAtteint,
    });
  };

  // ── LA PAUSE : un plafond qui le permet de nouveau réveille le travail ; toute autre pause attend la personne ──
  if (m.status === "PAUSED") {
    if (!m.pausedReason?.startsWith(MOTIF_BUDGET) || (await motifBudget()) !== null) return { ...bilan, arret: "EN_PAUSE" };
    await reprendreTravail(travailId, principalId, "le plafond le permet de nouveau");
    m = (await lire())!;
  }

  // ── 1. LES DROITS, RELUS ────────────────────────────────────────────────────────────────
  const refus = await persona.refusTravail(principalId);
  if (refus) {
    await suspendre(travailId, principalId, `${MOTIF_DROITS} — ${refus}`);
    await signalerUneFois(travailId, principalId, `droits:${new Date().toISOString().slice(0, 10)}`, `Travail en pause : « ${m.title} »`, refus);
    return { ...bilan, statut: "PAUSED", arret: "DROITS" };
  }

  const nom = (await prisma.user.findUnique({ where: { id: principalId }, select: { name: true } }))?.name ?? "la personne";
  const actor: MissionActor = { userId: principalId, label: `${persona.nom} (pour ${nom})`, isAgent: true };
  let plafondDuJour: string | null = null;

  const runner: CapabilityRunner = {
    run: async (call) => {
      if (call.capability === PREFIXE.lots) {
        const r = decouperEnLots(call.input.liste, call.input.taille);
        return r.ok ? { ok: true, output: { lots: r.lots, total: r.total, nombre: r.lots.length }, structured: true } : echec("INVALID_INPUT", r.erreur, false);
      }
      if (call.capability.startsWith(PREFIXE.lecture)) {
        const r = await persona.lire(principalId, call.capability.slice(PREFIXE.lecture.length), call.input);
        if (!r.ok) return echec("CAPABILITY_FAILURE", r.erreur, r.reessayable);
        return { ok: true, ...sortieStructuree(r.sortie) };
      }
      if (call.capability.startsWith(PREFIXE.geste)) return geste(call.capability.slice(PREFIXE.geste.length), call.stepKey, call.idempotencyKey, call.input);
      return echec("UNKNOWN_CAPABILITY", `capacité inconnue d'un travail : ${call.capability}`, false);
    },
  };

  /** UN GESTE — approuvé, rejugé, réclamé, fait, clos, tracé. Dans cet ordre, et aucun ne se saute. */
  async function geste(nomGeste: string, stepKey: string, cleMoteur: string | null, entree: Record<string, unknown>): Promise<CapabilityOutcome> {
    const ligne = await prisma.mission.findUnique({ where: { id: travailId }, select: { gestesAutorises: true } });
    const approuve = lireGestesAutorises(ligne?.gestesAutorises).find((g) => g.nom === nomGeste);
    if (!approuve) return echec("MISSING_PERMISSION", `« ${nomGeste} » ne figure pas dans les gestes approuvés avec le plan : il repasse par une carte.`, false);
    const refusGeste = await persona.refusGeste(principalId, nomGeste);
    if (refusGeste) {
      await journaliser(travailId, "GESTE_REFUSE", `« ${approuve.libelle} » refusé au moment d'agir : ${refusGeste}`, { stepKey, geste: nomGeste }, principalId);
      return echec("MISSING_PERMISSION", refusGeste, false);
    }
    const cle = cleMoteur ?? `${travailId}|${stepKey}|${nomGeste}`;
    const reclame = await reclamerEcriture(cle, travailId, stepKey, nomGeste);
    if (reclame.etat === "FAIT") return { ok: true, output: reclame.resultat, deduplicated: true, structured: true };
    if (reclame.etat === "INTERROMPU") {
      return echec("INTERRUPTED_WRITE", `« ${approuve.libelle} » a été interrompu pendant qu'il s'exécutait (redémarrage) : on ne sait pas s'il a eu lieu — vérifiez avant de le refaire à la main. Il n'est pas rejoué.`, false);
    }
    let r: Awaited<ReturnType<PersonaTravaux["ecrire"]>>;
    try {
      r = await persona.ecrire(principalId, nomGeste, entree);
    } catch (e) {
      r = { ok: false, erreur: e instanceof Error ? e.message : String(e) };
    }
    const resultat = r.ok ? { message: r.message ?? null, lien: r.lien ?? null, resultat: r.resultat ?? null } : { erreur: r.erreur };
    await cloreEcriture(cle, r.ok ? "FAIT" : "ECHEC", resultat);
    // LA DOUBLE SIGNATURE (§30) : demandé par la personne, exécuté par la persona — cherchable comme celle d'Adam.
    await journaliser(travailId, "ACTION_TRACED", `${approuve.libelle} — demandé par ${nom}, exécuté par ${persona.nom}${r.ok ? "" : ` (échec : ${r.erreur})`}.`, {
      initiatedBy: principalId, executedBy: `${persona.nom}:${principalId}`, missionId: travailId, stepKey, capability: `${PREFIXE.geste}${nomGeste}`, ok: r.ok,
    }, principalId);
    await deps.sondes?.apresGeste?.(stepKey);
    return r.ok ? { ok: true, output: resultat, structured: true } : echec("CAPABILITY_FAILURE", r.erreur, false);
  }

  /** UNE ÉTAPE DE MODÈLE — le carnet (borné) et les sorties amont, jamais l'historique. */
  const etapeDeModele = (livrable: boolean) => async (ctx: StepContext): Promise<StepOutcome> => {
    const { step, mission } = ctx;
    const ligne = await prisma.mission.findUnique({ where: { id: travailId }, select: { carnet: true } });
    const carnet = lireCarnet(ligne?.carnet);
    const { consigne, titre: _titre, ...entrees } = step.input as Record<string, unknown>;
    const r = await persona.raisonner(principalId, {
      travailId,
      consigne: livrable ? consigneLivrable(persona.nom) : consigneAnalyse(persona.nom),
      texte: texteEtape({ carnet: carnetPourEtape(carnet), titre: step.title, consigne: String(consigne ?? ""), entrees, amont: sortiesAmont(mission, step) }),
    });
    if (!r.ok) {
      // LE PLAFOND DU JOUR N'EST PAS UN ÉCHEC : l'étape attend, le travail dort, et la reprise la remet en file.
      if (r.plafond) { plafondDuJour = r.erreur; return { status: "WAITING", raison: `plafond : ${r.erreur}`, result: { plafond: true } }; }
      return { status: "FAILED", error: r.erreur, errorKind: "CAPABILITY_FAILURE", retryable: true };
    }
    await compter(travailId, { modelCalls: 1, tokensIn: r.usage.entree, tokensOut: r.usage.sortie, costUsd: r.usage.coutUsd ?? 0 });
    if (livrable) {
      await ecrireAuCarnet(travailId, step.key, { livrable: { titre: step.title, contenu: r.texte } }, clock.now());
      return { status: "DONE", result: { titre: step.title, caracteres: r.texte.length, apercu: r.texte.slice(0, 600) }, receipt: "LIVRABLE" };
    }
    const lu = lireAnalyse(r.texte);
    await ecrireAuCarnet(travailId, step.key, { notes: lu.notes, trouvailles: lu.trouvailles }, clock.now());
    return { status: "DONE", result: { texte: lu.resultat, trouvailles: lu.trouvailles, notes: lu.notes }, receipt: "ANALYSE" };
  };

  const attention: PorteAttention = {
    signaler: async (s) => {
      const fin = s.kind === "MISSION_COMPLETED" ? "terminé" : s.kind === "MISSION_PARTIAL" ? "terminé en partie" : s.kind === "MISSION_BLOCKED" ? "bloqué" : null;
      if (!fin) return { niveau: "JOURNAL", canaux: [], supprime: true };
      const faites = s.bilan ? ` — ${s.bilan.faites}/${s.bilan.total} étapes` : "";
      await signalerUneFois(travailId, principalId, `fin:${s.kind}`, `Travail ${fin} : « ${m!.title} »`, `${s.raison ?? ""}${faites}`.trim());
      return { niveau: "INFO", canaux: ["notification"], supprime: false };
    },
  };

  const moteur: EngineDeps = {
    runner, catalog: CATALOGUE_TRAVAUX, clock, juge: JUGE_TRAVAIL, attention, maxTours: 1,
    handlers: { WORKER: etapeDeModele(false), ARTIFACT: etapeDeModele(true) },
    ...(opts.interrupteur ? { interrupteur: opts.interrupteur } : {}),
  };

  const debut = Date.now();
  const vaguesMax = deps.vagues ?? 25;
  let vides = 0;
  try {
    while (bilan.vagues < vaguesMax) {
      if (Date.now() - debut > (deps.dureeMaxMs ?? 45_000)) { bilan.arret = "DUREE"; break; }
      // ── 2. LES PLAFONDS, AVANT CHAQUE VAGUE — jamais après coup ─────────────────────────
      const motif = plafondDuJour ?? (await motifBudget());
      if (motif) {
        await suspendre(travailId, principalId, `${MOTIF_BUDGET} — ${motif}`);
        await signalerUneFois(travailId, principalId, `budget:${clock.now().toISOString().slice(0, 13)}`, `Travail en sommeil : « ${m.title} »`, `Plafond atteint : ${motif}. Rien n'est perdu — il reprendra là où il s'est arrêté.`);
        bilan.arret = "BUDGET";
        break;
      }
      const r = await avancer(travailId, actor, moteur);
      bilan.vagues += 1;
      bilan.executees += r.executees;
      bilan.echouees += r.echouees;
      bilan.statut = r.status;
      if (r.bailRefuse) { bilan.arret = "BAIL"; break; }
      if (r.suspenduGlobalement) { bilan.arret = "INTERRUPTEUR"; break; }
      if (TERMINAUX.has(r.status) || r.status === "PAUSED") break;
      if (r.executees + r.echouees + r.deployees > 0) { vides = 0; continue; }
      // RIEN N'A BOUGÉ : une attente (événement, minuterie) dort en base — on rend la main.
      if (!OCCUPE.has(r.status) || ++vides >= 3) break;
    }
    if (plafondDuJour && bilan.arret !== "BUDGET") {
      await suspendre(travailId, principalId, `${MOTIF_BUDGET} — ${plafondDuJour}`);
      bilan.arret = "BUDGET";
    }
  } finally {
    // Le passage suivant peut venir d'un autre processus (le worker) : on rend ce qu'on a pris.
    await rendreBail(travailId);
  }
  const apres = await prisma.mission.findUnique({ where: { id: travailId }, select: { status: true } });
  bilan.statut = apres?.status ?? bilan.statut;
  if (bilan.statut === "FAILED") {
    await signalerUneFois(travailId, principalId, "fin:FAILED", `Travail en échec : « ${m.title} »`, "Une étape n'a pas pu aboutir malgré ses reprises. Ouvrez le panneau Travaux pour voir laquelle.");
  }
  return bilan;
}

/** UNE PAUSE POSÉE PAR LE MOTEUR (plafond, droits) — le même geste que la main humaine, motif compris. */
async function suspendre(travailId: string, principalId: string, motif: string): Promise<void> {
  await mettreEnPause(travailId, principalId, motif, "TRAVAIL");
}

/**
 * REPRENDRE — la main de la personne, ou le réveil automatique d'un plafond relevé. Les étapes de
 * modèle restées « en attente » d'un plafond du jour repartent en file : elles n'avaient rien fait.
 */
export async function reprendreTravail(travailId: string, principalId: string, raison: string) {
  const r = await reprendre(travailId, principalId, "TRAVAIL");
  if (r.ok) {
    await prisma.missionStep.updateMany({
      where: { missionId: travailId, status: "WAITING", nodeType: { in: ["WORKER", "ARTIFACT"] } },
      data: { status: "READY" },
    });
    await journaliser(travailId, "TRAVAIL_REPRIS", `Repris : ${raison}.`, { raison }, principalId);
  }
  return r;
}

/**
 * PRÉVENIR LA PERSONNE, UNE FOIS — la clé est au journal du travail (pas de second registre). Un
 * battement qui revoit le même état ne renotifie pas.
 */
export async function signalerUneFois(travailId: string, principalId: string, cle: string, titre: string, corps: string): Promise<void> {
  const deja = await prisma.missionEvent.findFirst({
    where: { missionId: travailId, kind: "TRAVAIL_SIGNAL", detail: { path: ["cle"], equals: cle } },
    select: { id: true },
  });
  if (deja) return;
  await journaliser(travailId, "TRAVAIL_SIGNAL", titre, { cle }, principalId);
  await notifyUser({ userId: principalId, type: "GENERIC", title: titre.slice(0, 200), body: corps.slice(0, 280), link: `/assistant?travail=${travailId}` })
    .catch(sansBloquer("travaux.signalerUneFois.notifyUser"));
}
