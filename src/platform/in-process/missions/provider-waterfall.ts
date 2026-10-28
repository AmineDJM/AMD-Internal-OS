/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CASCADE — où passent réellement les quatre-vingt-trois secondes.
 *
 * ── POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────────────────
 *
 * Le premier run réel sur Render a rendu : 29 399 ms de planification, 83 504 ms au total. Le
 * second chiffre est le seul qui compte pour la personne qui attend, et cinquante-quatre
 * secondes n'étaient imputées à rien. Optimiser sans les avoir attribuées reviendrait à
 * deviner : on raccourcirait le morceau visible et l'on découvrirait ensuite qu'il pesait un
 * cinquième du total.
 *
 * ── LE RAISONNEUR INSTRUMENTÉ N'EST PAS UN SUBSTITUT ─────────────────────────────────────
 *
 * `RaisonneurInstrumente` DÉLÈGUE chaque appel au raisonneur de production, sans rien changer :
 * même modèle, même effort, même schéma, même réponse. Il note ce qui entre et ce qui sort.
 *
 * La distinction est capitale pour l'honnêteté du diagnostic : un mock REMPLACE et invalide la
 * preuve fournisseur ; un décorateur OBSERVE et la laisse intacte. C'est pour cela qu'il expose
 * `configured()` en le déléguant lui aussi — s'il répondait « oui » de lui-même, il aurait
 * commencé à mentir.
 *
 * ── CE QUE LA CASCADE SÉPARE ─────────────────────────────────────────────────────────────
 *
 * Chaque appel de modèle porte son `purpose`, qui vient du runtime lui-même : `mission.plan`,
 * `mission.worker`, `mission.judge`… C'est la ligne de partage réelle entre planification,
 * exécution des étapes de réflexion et jugement d'objectif. On ne la reconstruit pas, on la lit.
 *
 * Le reste — étapes de capacité, contrôle qualité, recours — vient du JOURNAL de la mission
 * (`MissionEvent`), qui horodate déjà tout. §17 : pas de second registre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { prisma } from "@/lib/prisma";
import type { Reasoner, ReasonRequest, ReasonResult } from "@/lib/missions/ports";
import { sansBloquer } from "@/lib/journal";

export interface AppelModele {
  /** Le scénario auquel cet appel appartient — sans quoi trois missions se mélangent. */
  scenario: string;
  /** L'ordre d'émission — c'est lui qui montre les appels séquentiels. */
  seq: number;
  purpose: string;
  role: string;
  schemaName: string;
  /** Le poids du schéma IMPOSÉ au fournisseur, en caractères JSON. Un coût, pas un détail. */
  schemaChars: number;
  promptChars: number;
  systemChars: number;
  debutMs: number;
  finMs: number;
  latenceMs: number;
  modele: string | null;
  jetonsEntree: number | null;
  jetonsSortie: number | null;
  /**
   * LES JETONS DE RÉFLEXION — comptés DANS `jetonsSortie`, invisibles dans la réponse.
   *
   * C'est la mesure qui manquait pour expliquer un plan à 6 563 jetons de sortie alors que son
   * JSON en pèse ~2 500 : la différence est du raisonnement, pas de la verbosité de schéma. Sans
   * ce champ, on aurait allégé le schéma et découvert ensuite qu'il pesait un cinquième du total.
   */
  jetonsReflexion: number | null;
  jetonsCaches: number | null;
  ok: boolean;
  erreur: string | null;
}

/**
 * LE DÉCORATEUR. Tout passe au vrai raisonneur ; rien n'est simulé, rien n'est raccourci.
 */
export class RaisonneurInstrumente implements Reasoner {
  readonly appels: AppelModele[] = [];
  private seq = 0;
  /**
   * LE SCÉNARIO EN COURS.
   *
   * Un seul instrument sert les trois scénarios — c'est voulu, il porte le budget global. Mais
   * sans marquage, la cascade du premier scénario affichait les onze appels des trois : on
   * lisait « total 37,7 s » au-dessus d'appels s'étalant jusqu'à 232 s. Un tableau qui mélange
   * trois missions ne permet plus d'imputer une seconde à quoi que ce soit.
   *
   * Chaque appel porte donc son scénario, et `pour()` rend la tranche exacte.
   */
  private scenario = "";

  constructor(private readonly reel: Reasoner, private readonly t0: number) {}

  /** Ouvre une tranche. Tous les appels suivants lui appartiennent. */
  ouvrir(scenario: string): void { this.scenario = scenario; }

  /** Les appels d'UN scénario, et rien d'autre. */
  pour(scenario: string): AppelModele[] {
    return this.appels.filter((a) => a.scenario === scenario);
  }

  configured(): boolean {
    return this.reel.configured();
  }

  async reason<T>(req: ReasonRequest): Promise<ReasonResult<T>> {
    const seq = ++this.seq;
    const debut = Date.now();
    const r = await this.reel.reason<T>(req);
    const fin = Date.now();
    this.appels.push({
      scenario: this.scenario,
      seq,
      purpose: req.purpose,
      role: req.role,
      schemaName: req.schemaName,
      schemaChars: JSON.stringify(req.schema ?? {}).length,
      promptChars: (req.prompt ?? "").length,
      systemChars: (req.system ?? "").length,
      debutMs: debut - this.t0,
      finMs: fin - this.t0,
      latenceMs: r.latencyMs ?? fin - debut,
      modele: r.usage?.model ?? null,
      jetonsEntree: r.usage?.inputTokens ?? null,
      jetonsSortie: r.usage?.outputTokens ?? null,
      jetonsReflexion: r.usage?.reasoningTokens ?? null,
      jetonsCaches: r.usage?.cachedInputTokens ?? null,
      ok: r.ok,
      erreur: r.ok ? null : r.error ?? "échec",
    });
    return r;
  }

  /** Le temps réellement passé À ATTENDRE UN MODÈLE, appels chevauchants comptés une fois. */
  tempsModeleMs(scenario?: string): number {
    const seg = (scenario ? this.pour(scenario) : this.appels).map((a) => [a.debutMs, a.finMs] as const).sort((x, y) => x[0] - y[0]);
    let total = 0;
    let curDebut = -1;
    let curFin = -1;
    for (const [d, f] of seg) {
      if (d > curFin) { if (curFin > curDebut) total += curFin - curDebut; curDebut = d; curFin = f; }
      else curFin = Math.max(curFin, f);
    }
    if (curFin > curDebut) total += curFin - curDebut;
    return total;
  }

  /** Vrai quand deux appels se chevauchent — donc que du parallélisme a réellement eu lieu. */
  aDuParallelisme(scenario?: string): boolean {
    const tries = [...(scenario ? this.pour(scenario) : this.appels)].sort((a, b) => a.debutMs - b.debutMs);
    return tries.some((a, i) => i > 0 && a.debutMs < tries[i - 1].finMs);
  }

  /**
   * LES JETONS DE TOUS LES APPELS — et le mot « tous » est la correction.
   *
   * Le relevé global additionnait `metriques.usage` des trois `lancerMission`, c'est-à-dire les
   * trois SEULS appels de planification initiale, sous une étiquette qui disait « jetons entrée /
   * sortie » du diagnostic entier. Un run réel a montré l'écart : 11 521 annoncés en entrée pour
   * 52 463 réellement facturés — un facteur quatre et demi, dans le sens rassurant.
   *
   * §78 : un tableau de bord qui affiche un chiffre inventé fait prendre de vraies décisions sur
   * de faux chiffres. Ici la décision est « où faut-il optimiser » ; la fausser revient à
   * optimiser le mauvais maillon.
   */
  jetons(scenario?: string): { entree: number; sortie: number; reflexion: number | null } {
    const xs = scenario ? this.pour(scenario) : this.appels;
    const mesures = xs.filter((a) => a.jetonsReflexion !== null);
    return {
      entree: xs.reduce((s, a) => s + (a.jetonsEntree ?? 0), 0),
      sortie: xs.reduce((s, a) => s + (a.jetonsSortie ?? 0), 0),
      // `null` si AUCUN appel n'a distingué la réflexion : zéro affirmerait qu'il n'y en a pas eu.
      reflexion: mesures.length === 0 ? null : mesures.reduce((s, a) => s + (a.jetonsReflexion ?? 0), 0),
    };
  }
}

export interface Phase {
  nom: string;
  debutMs: number;
  finMs: number;
  dureeMs: number;
  detail: string;
}

export interface Cascade {
  totalMs: number;
  phases: Phase[];
  appels: AppelModele[];
  /** Temps passé à attendre un modèle, chevauchements dédupliqués. */
  tempsModeleMs: number;
  /** Le reste : base, outils, sérialisation, moteur. C'est ce qui n'était imputé à rien. */
  tempsHorsModeleMs: number;
  parallelisme: boolean;
  /** Les appels dont la réponse n'a pas servi (échec, ou plan jeté à la reprise). */
  appelsSansEffet: number;
  /**
   * ── LES MÉTRIQUES DU CHANTIER LATENCE (§18) — mesurées, jamais estimées ─────────────
   *
   * `voiePlan` : DIRECTE = le plan a été construit par le code, ZÉRO appel de planificateur ;
   * MODELE = le planificateur LLM a été payé ; `null` = non mesuré (lancement en échec).
   * `sommeDureesAppelsMs` vs `tempsModeleMs` (union) : leur rapport est le FACTEUR DE
   * PARALLÉLISME — 1,0 = tout séquentiel ; 2,0 = deux appels menés de front en moyenne.
   * `appelsChevauchants` : combien d'appels ont recouvert un autre — le « OUI/NON » de
   * `parallelisme` devenu un nombre. `premierResultatUtileMs` : le premier STEP_DONE du
   * journal — ce que la personne aurait déjà PU voir, indépendamment de la réponse finale.
   */
  voiePlan: string | null;
  sommeDureesAppelsMs: number;
  appelsChevauchants: number;
  premierResultatUtileMs: number | null;
  catalogue: {
    ouvertes: number;
    montreesAuPlanner: number | null;
    /** Le coût en caractères des résumés RÉELLEMENT envoyés au planner. */
    resumeChars: number | null;
    /** Combien de capacités le plan compilé utilise VRAIMENT. */
    utilisees: number;
    /** Celles exposées et jamais retenues — le gras du catalogue pour CETTE mission. */
    exposeesInutiles: number | null;
  };
}

/**
 * RECONSTRUIT LA CASCADE depuis le journal de la mission et les appels observés.
 *
 * Le journal fait foi pour les phases du moteur : il est écrit par le runtime lui-même, au
 * moment où les choses arrivent. Le reconstruire par soustraction depuis les totaux donnerait
 * des durées plausibles et fausses.
 */
export async function cascade(
  missionId: string | null,
  instrument: RaisonneurInstrumente,
  scenario: string,
  t0: number,
  finMs: number,
  catalogue: Cascade["catalogue"],
  voiePlan: string | null = null,
): Promise<Cascade> {
  const phases: Phase[] = [];

  if (missionId) {
    const evts = await prisma.missionEvent.findMany({
      where: { missionId },
      select: { kind: true, summary: true, at: true },
      orderBy: { at: "asc" },
    }).catch(sansBloquer("provider-waterfall.cascade.missionEvent", []));

    // Chaque événement ouvre une phase qui se ferme au suivant. C'est grossier pour un événement
    // isolé, et exact pour une suite — or c'est bien une SUITE qu'on cherche à expliquer.
    for (const [i, e] of evts.entries()) {
      const debut = e.at.getTime() - t0;
      const fin = i + 1 < evts.length ? evts[i + 1].at.getTime() - t0 : finMs;
      phases.push({
        nom: e.kind,
        debutMs: debut,
        finMs: fin,
        dureeMs: Math.max(0, fin - debut),
        detail: e.summary.slice(0, 120),
      });
    }

    // Les étapes portent leur propre horodatage de départ : c'est la seule façon de distinguer
    // une étape lente d'une étape qui a attendu son tour dans la file.
    const steps = await prisma.missionStep.findMany({
      where: { missionId },
      select: { key: true, nodeType: true, capability: true, status: true, startedAt: true, attempt: true },
      orderBy: { startedAt: "asc" },
    }).catch(sansBloquer("provider-waterfall.cascade.missionStep", []));
    for (const s of steps) {
      if (!s.startedAt) continue;
      phases.push({
        nom: `step:${s.nodeType}`,
        debutMs: s.startedAt.getTime() - t0,
        finMs: s.startedAt.getTime() - t0,
        dureeMs: 0, // le moteur n'horodate pas la FIN d'étape ; on le dit plutôt que de l'inventer
        detail: `${s.key} · ${s.capability ?? s.nodeType} · ${s.status}${s.attempt > 1 ? ` · essai ${s.attempt}` : ""}`,
      });
    }
  }

  const propres = instrument.pour(scenario);
  const modele = instrument.tempsModeleMs(scenario);
  // Un appel est CHEVAUCHANT s'il recouvre au moins un autre appel du même scénario.
  const chevauchants = propres.filter((a) =>
    propres.some((b) => b !== a && a.debutMs < b.finMs && b.debutMs < a.finMs)).length;
  // Le premier STEP_DONE du journal : ce qu'une personne aurait DÉJÀ pu voir.
  const premierUtile = phases
    .filter((p) => p.nom === "STEP_DONE")
    .reduce<number | null>((min, p) => (min === null || p.debutMs < min ? p.debutMs : min), null);
  return {
    totalMs: finMs,
    phases: phases.sort((a, b) => a.debutMs - b.debutMs),
    appels: propres,
    tempsModeleMs: modele,
    tempsHorsModeleMs: Math.max(0, finMs - modele),
    parallelisme: instrument.aDuParallelisme(scenario),
    appelsSansEffet: propres.filter((a) => !a.ok).length,
    voiePlan,
    sommeDureesAppelsMs: propres.reduce((s, a) => s + a.latenceMs, 0),
    appelsChevauchants: chevauchants,
    premierResultatUtileMs: premierUtile,
    catalogue,
  };
}

/**
 * LA SYNTHÈSE PAR TYPE D'APPEL — la ligne que le rapport avant/après compare.
 *
 * Trois familles, parce que ce sont trois leviers différents : le PLANNER se réduit en montrant
 * moins de capacités et en évitant les replans, le WORKER se réduit en parallélisant, le JUDGE
 * se réduit en ne rejugeant pas ce qui n'a pas bougé. Les agréger en « appels de modèle »
 * cacherait lequel des trois a bougé.
 */
export function parFamille(appels: AppelModele[]): {
  famille: string; n: number; totalMs: number; entree: number; sortie: number; reflexion: number | null;
}[] {
  const cle = (a: AppelModele) =>
    a.purpose.includes("plan") ? "PLANNER"
    : a.purpose.includes("judge") ? "JUDGE"
    : a.purpose.includes("worker") ? "WORKER"
    : "AUTRE";
  const groupes = new Map<string, AppelModele[]>();
  for (const a of appels) groupes.set(cle(a), [...(groupes.get(cle(a)) ?? []), a]);
  return [...groupes.entries()].map(([famille, xs]) => {
    const mesures = xs.map((x) => x.jetonsReflexion).filter((x): x is number => x !== null);
    return {
      famille, n: xs.length,
      totalMs: xs.reduce((s, x) => s + x.latenceMs, 0),
      entree: xs.reduce((s, x) => s + (x.jetonsEntree ?? 0), 0),
      sortie: xs.reduce((s, x) => s + (x.jetonsSortie ?? 0), 0),
      // `null` quand le fournisseur n'a rien distingué — jamais zéro, qui voudrait dire
      // « il n'a pas réfléchi » au lieu de « on ne sait pas ».
      reflexion: mesures.length ? mesures.reduce((s, x) => s + x, 0) : null,
    };
  }).sort((a, b) => b.totalMs - a.totalMs);
}

/** La cascade, rendue pour un humain qui cherche où sont passées les secondes. */
export function rendreCascade(c: Cascade): string[] {
  const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);
  const barre = (d: number) => "█".repeat(Math.max(0, Math.min(40, Math.round((d / Math.max(1, c.totalMs)) * 40))));

  const facteur = c.tempsModeleMs > 0 ? (c.sommeDureesAppelsMs / c.tempsModeleMs).toFixed(2) : "—";
  return [
    "── CASCADE ─────────────────────────────────────────────",
    `  total                        ${ms(c.totalMs)}`,
    `  voie du plan                 ${c.voiePlan === "DIRECTE" ? "DIRECTE — 0 appel de planificateur" : c.voiePlan ?? "non mesurée"}`,
    `  dont attente modèle          ${ms(c.tempsModeleMs)} (${((c.tempsModeleMs / Math.max(1, c.totalMs)) * 100).toFixed(0)} %)`,
    `  dont hors modèle (base/outils/moteur)  ${ms(c.tempsHorsModeleMs)} (${((c.tempsHorsModeleMs / Math.max(1, c.totalMs)) * 100).toFixed(0)} %)`,
    `  parallélisme entre appels    ${c.parallelisme ? `OUI — ${c.appelsChevauchants}/${c.appels.length} chevauchants` : "NON — tous séquentiels"}`
    + ` · facteur ${facteur} (somme ${ms(c.sommeDureesAppelsMs)} / union ${ms(c.tempsModeleMs)})`,
    `  premier résultat utile       ${c.premierResultatUtileMs !== null ? `${ms(c.premierResultatUtileMs)} (premier STEP_DONE)` : "non mesuré"}`,
    `  appels sans effet            ${c.appelsSansEffet}`,
    "",
    "  PAR FAMILLE D'APPEL — les trois leviers, séparés",
    "  famille    n      durée   jetons entrée   jetons sortie   dont réflexion",
    ...parFamille(c.appels).map((f) => "  " + [
      f.famille.padEnd(10),
      String(f.n).padStart(2),
      ms(f.totalMs).padStart(9),
      String(f.entree).padStart(14),
      String(f.sortie).padStart(15),
      (f.reflexion === null
        ? "NON MESURÉ"
        : `${f.reflexion} (${Math.round((f.reflexion / Math.max(1, f.sortie)) * 100)} %)`).padStart(16),
    ].join(" ")),
    "",
    "  APPELS DE MODÈLE (ordre d'émission)",
    "  seq  purpose                  rôle              début      durée    jetons e/s   réflexion   schéma",
    ...c.appels.map((a) => "  " + [
      String(a.seq).padEnd(4),
      a.purpose.slice(0, 24).padEnd(25),
      a.role.slice(0, 17).padEnd(18),
      ms(a.debutMs).padStart(8),
      ms(a.latenceMs).padStart(8),
      `${a.jetonsEntree ?? "—"}/${a.jetonsSortie ?? "—"}`.padStart(12),
      (a.jetonsReflexion !== null
        ? `${a.jetonsReflexion} (${Math.round((a.jetonsReflexion / Math.max(1, a.jetonsSortie ?? 1)) * 100)} %)`
        : "—").padStart(11),
      String(a.schemaChars).padStart(8),
    ].join(" ")),
    "",
    "  PHASES DU MOTEUR (journal de mission)",
    ...c.phases.map((p) => `  ${ms(p.debutMs).padStart(8)}  ${p.nom.padEnd(18)} ${barre(p.dureeMs)} ${ms(p.dureeMs).padStart(8)}  ${p.detail}`),
    "",
    "  CATALOGUE DE CAPACITÉS",
    `    ouvertes (plafond lecture) ${c.catalogue.ouvertes}`,
    `    montrées au planner        ${c.catalogue.montreesAuPlanner ?? "—"}`,
    `    poids des résumés envoyés  ${c.catalogue.resumeChars !== null ? `${c.catalogue.resumeChars} caractères` : "—"}`,
    `    réellement utilisées       ${c.catalogue.utilisees}`,
    `    exposées et non retenues   ${c.catalogue.exposeesInutiles ?? "—"}`,
  ];
}
