/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE DIAGNOSTIC FOURNISSEUR ET MISSION — deux questions, deux verdicts.
 *
 * ── CE QUE LE PREMIER RUN RÉEL A APPRIS ──────────────────────────────────────────────────
 *
 * Sur Render, la chaîne a répondu : fournisseur appelé, plan conforme, compilateur satisfait,
 * mission écrite, six étapes exécutées, contrôle qualité passé — et le juge d'objectif a REFUSÉ
 * de conclure, parce que la demande exigeait « les trois plus urgents » et que les données ne
 * permettaient pas d'en établir trois de façon probante.
 *
 * Ce refus est CORRECT. C'est §10 de la doctrine appliquée à la lettre : un moteur qui conclut
 * parce qu'il n'a pas pu vérifier est pire qu'un moteur qui ne conclut pas. On ne touche donc
 * pas au juge. Trois défauts, en revanche, appartenaient bien au diagnostic :
 *
 *   1. IL CONFONDAIT DEUX QUESTIONS. « Un vrai fournisseur est-il appelé ? » et « ce scénario
 *      métier a-t-il atteint son objectif ? » n'ont aucune raison de partager un verdict. Le
 *      premier était prouvé ; le second a été annoncé en échec, et le rapport global a viré au
 *      rouge pour une raison qui ne concernait pas le fournisseur. D'où DEUX verdicts.
 *   2. IL S'ARRÊTAIT SUR UN ÉTAT INTERMÉDIAIRE. La mission restait `RUNNING` — ce qui, dans ce
 *      runtime, signifie « plus aucune étape à faire, et l'objectif n'a pas été jugé atteint ».
 *      Ni terminal, ni jugé. Le diagnostic doit POURSUIVRE le vrai moteur jusqu'à un état
 *      réellement stable, en passant par le recours et la replanification canoniques.
 *   3. SA DEMANDE N'ÉTAIT PAS SATISFIABLE. « Les trois plus urgents » présuppose qu'il y en ait
 *      trois. Un banc dont l'énoncé exige ce que la base ne contient pas ne mesure pas le
 *      produit : il mesure son propre présupposé.
 *
 * ── LES TROIS SCÉNARIOS, ET POURQUOI CEUX-LÀ ─────────────────────────────────────────────
 *
 *   A — SATISFIABLE          la vérité terrain garantit qu'une réponse complète EXISTE.
 *   B — PREUVE D'ABSENCE     l'information n'existe pas, et le LIVRABLE est de le démontrer.
 *   C — RECOURS              une première piste insuffisante, une seconde correcte.
 *
 * B mérite un mot. Demander une chose absente et attendre un échec serait un piège ; ici le
 * critère de succès EST la démonstration d'absence. C'est la seule façon de mesurer la
 * discipline épistémique sans la punir : un Adam qui prouve qu'il n'y a rien a fait son travail.
 *
 * ── CE QUI RESTE NON FALSIFIABLE ─────────────────────────────────────────────────────────
 *
 * Aucun plan n'est injecté : le planner reçoit une demande en français, toujours. Le raisonneur
 * n'est pas remplacé — il est DÉCORÉ par `RaisonneurInstrumente`, qui délègue tout et se
 * contente de chronométrer. Et `PROVIDER_CALL` ne passe au vert que sur la FACTURE : des jetons
 * comptés et un nom de modèle rendus par l'API. Un substitut rend `null`.
 *
 * ── LA SÛRETÉ ────────────────────────────────────────────────────────────────────────────
 *
 * `lectureSeule` plafonne le catalogue à `ANALYZE` : les capacités qui écrivent, communiquent,
 * engagent ou détruisent sont ABSENTES de la liste que le compilateur consulte — pas découragées
 * par une consigne qu'un document lu en route pourrait contredire. Le plafond est re-vérifié sur
 * les étapes réellement écrites, et un dépassement ARRÊTE le diagnostic.
 *
 * ── L'INTÉGRITÉ DU BANC LUI-MÊME (le lot « truth/evidence ») ─────────────────────────────
 *
 * Trois défauts découverts en observant les runs, et qui ne portaient pas sur le produit mais
 * sur l'instrument — donc les plus dangereux, puisqu'un instrument faux valide n'importe quoi :
 *
 *   1. IL SE CONTAMINAIT LUI-MÊME. Le scénario d'absence portait un nom FIXE ; deux runs ont
 *      laissé des classeurs à ce nom dans le Drive, et le troisième les a trouvés. D'où le
 *      JETON unique par run (`jetonUnique`) — sans jamais effacer un fichier de production.
 *   2. SA VÉRITÉ TERRAIN NE COUVRAIT QU'UNE SOURCE là où l'énoncé en citait quatre. D'où
 *      `preconditionAbsence`, qui compte les quatre AVANT de lancer et déclare le banc
 *      INVALIDE (`SETUP_FAILED`) plutôt que d'accuser le moteur d'un défaut qui n'est pas le
 *      sien.
 *   3. IL CONFONDAIT POLITIQUE ET OBSERVATION. `READ_ONLY_EXECUTION` passait au vert parce
 *      qu'une étape avait bougé. Il distingue désormais l'effet AUTORISÉ (le plafond), l'effet
 *      PLANIFIÉ (ce que le plan écrit contient) et l'effet EXÉCUTÉ (ce que les reçus des étapes
 *      qui ont tourné rapportent) — et exige, en plus, qu'AUCUN artefact ne soit apparu.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Découpé par responsabilité — voir le dossier `provider-smoke/` : `verdict.ts` (la chaîne
 * mesurée, les états, les résultats et le verdict lecture seule), `scenarios.ts` (jetons, préconditions
 * d'absence, catalogue des scénarios), `jeu.ts` (mener une mission à un état stable, la jouer,
 * arrêter les missions de diagnostic). Ce fichier garde le banc lui-même et son rendu texte.
 */
import type { CurrentUser } from "@/lib/session";
import { raisonneur } from "@/platform/in-process/missions/reasoner";
import { RaisonneurInstrumente, rendreCascade } from "@/platform/in-process/missions/provider-waterfall";
import { type Chaine, type Maillon, MAILLONS_FOURNISSEUR, MAILLONS_MISSION, type ResultatSmoke } from "./provider-smoke/verdict";
import { jetonUnique, scenarios } from "./provider-smoke/scenarios";
import { arreterMissionsDeDiagnostic, jouer } from "./provider-smoke/jeu";

export { PLAFOND, MAILLONS_FOURNISSEUR, MAILLONS_MISSION, MAILLONS, verdictLectureSeule, type Maillon, type Etat, type Chaine, type ResultatMission, type ResultatSmoke } from "./provider-smoke/verdict";
export { jetonUnique, preconditionAbsence, scenarios, type Genre, type Precondition, type Scenario } from "./provider-smoke/scenarios";
export { jouer, arreterMissionsDeDiagnostic } from "./provider-smoke/jeu";

export async function smokeFournisseur(user: CurrentUser): Promise<ResultatSmoke> {
  const t0 = Date.now();
  const chaine: Chaine = {
    PROVIDER_CALL: "FAIL", PLANNER_REAL_MODEL: "FAIL", MISSION_PLAN_SCHEMA: "FAIL",
    COMPILER: "FAIL", MISSION_PERSISTED: "FAIL",
    READ_ONLY_EXECUTION: "FAIL", TERMINAL_STATE: "FAIL", QA_GOAL_SATISFACTION: "FAIL",
  };
  const out: ResultatSmoke = {
    horodatage: new Date().toISOString(), chaine,
    providerProven: false, missionE2eProven: false,
    premierEchecFournisseur: null, premierEchecMission: null, raison: null,
    cleDisponible: Boolean((process.env.OPENAI_API_KEY ?? "").trim()),
    modele: null, jetonsEntree: 0, jetonsSortie: 0, jetonsReflexion: null, appelsModele: 0,
    capacitesOuvertes: null,
    jeton: jetonUnique(),
    setupValide: true, raisonSetup: null, artefactsInattendus: [],
    scenarios: [], latenceTotaleMs: 0, missionsArretees: 0,
  };

  const finir = (): ResultatSmoke => {
    out.latenceTotaleMs = Date.now() - t0;
    out.premierEchecFournisseur = MAILLONS_FOURNISSEUR.find((k) => chaine[k] !== "PASS") ?? null;
    out.premierEchecMission = MAILLONS_MISSION.find((k) => chaine[k] !== "PASS") ?? null;
    out.providerProven = out.premierEchecFournisseur === null;
    out.missionE2eProven = out.providerProven && out.premierEchecMission === null;
    return out;
  };

  if (!out.cleDisponible) {
    out.raison = "OPENAI_API_KEY absente de l'environnement de ce processus.";
    return finir();
  }

  const instrument = new RaisonneurInstrumente(raisonneur, t0);
  const liste = await scenarios(out.jeton);

  for (const sc of liste) {
    const { r, chaine: partiel, metriques } = await jouer(user, sc, instrument, t0);
    out.scenarios.push(r);
    // UN MAILLON VERT LE RESTE : chaque scénario est une occasion de le prouver, et un scénario
    // métier plus exigeant que les autres n'efface pas ce que les précédents ont établi.
    for (const [k, v] of Object.entries(partiel)) if (v === "PASS") chaine[k as Maillon] = "PASS";
    out.modele ??= metriques.modele;
    out.capacitesOuvertes ??= metriques.ouvertes;
  }

  /**
   * ── UN MAILLON VERT SE PERD SI UN SEUL SCÉNARIO A LAISSÉ UNE TRACE ────────────────────
   *
   * La règle « un maillon vert le reste » vaut pour ce qu'un scénario PROUVE. Elle ne peut pas
   * valoir pour ce qu'un scénario RÉFUTE : si l'un des trois a écrit un fichier sous plafond de
   * lecture, la garantie « cette exécution est en lecture seule » est fausse pour le diagnostic
   * ENTIER, et deux scénarios sages ne la rétablissent pas.
   */
  const pollueurs = out.scenarios.filter((s) => s.artefactsCrees.length > 0);
  if (pollueurs.length > 0) {
    chaine.READ_ONLY_EXECUTION = "FAIL";
    out.artefactsInattendus = pollueurs.flatMap((s) => s.artefactsCrees);
  }

  // ── L'INSTRUMENT S'ARRÊTE AVEC LA MESURE (§118.132) ────────────────────────────────────
  // Après le verdict, et jamais avant : arrêter une mission en cours de mesure fausserait la
  // mesure. Ce qui est COMPLETED reste COMPLETED (`annuler` le refuse) ; le reste est arrêté
  // pour que le battement de production ne le reprenne plus.
  out.missionsArretees = await arreterMissionsDeDiagnostic(user.id, out.scenarios.map((s) => s.missionId));

  // LE BANC INVALIDE SE DIT À PART. Ce n'est pas une mission en échec : c'est une vérité terrain
  // fausse, donc une mesure qui n'a pas eu lieu. Les confondre accuserait le moteur.
  const setupsRates = out.scenarios.filter((s) => s.setupEchoue);
  out.setupValide = setupsRates.length === 0;
  if (setupsRates.length > 0) {
    out.raisonSetup = setupsRates.map((s) => `${s.genre} : ${s.motifArret}`).join(" ; ");
  }

  // LES JETONS SE LISENT SUR L'INSTRUMENT, PAS SUR LES PLANIFICATIONS. La boucle ci-dessus
  // additionnait `metriques.entree` — c'est-à-dire l'usage rendu par `lancerMission`, donc le
  // SEUL appel de planification initiale de chaque scénario. Un run réel a chiffré l'écart :
  // 11 521 jetons d'entrée annoncés pour 52 463 réellement facturés sur vingt appels.
  const tous = instrument.jetons();
  out.jetonsEntree = tous.entree;
  out.jetonsSortie = tous.sortie;
  out.jetonsReflexion = tous.reflexion;
  out.appelsModele = instrument.appels.length;

  const r = finir();
  if (!r.missionE2eProven && r.providerProven) {
    const pire = out.scenarios.find((s) => s.artefactsCrees.length > 0)
      ?? out.scenarios.find((s) => !s.stable && !s.setupEchoue)
      ?? out.scenarios.find((s) => s.goalSatisfied === false);
    out.raison = pire?.motifArret
      // UN BANC INVALIDE N'EST PAS UNE MISSION EN ÉCHEC, et la phrase doit le dire : sinon on
      // corrige le moteur pour un défaut qui vient du scénario.
      ?? (out.raisonSetup ? `banc invalide (aucune mesure) — ${out.raisonSetup}` : null)
      ?? "aucun scénario n'atteint un état terminal jugé cohérent";
  }
  return r;
}

/** La sortie — deux verdicts distincts, puis la cascade qui explique le temps. */
export function rendreTexte(r: ResultatSmoke): string {
  const val = (x: number | string | boolean | null) => (x === null ? "—" : String(x));
  const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);
  const lignes: string[] = [
    "═══════════════ SMOKE FOURNISSEUR & MISSION — ADAM ═══════════════",
    "",
    "  CHAÎNE FOURNISSEUR",
    ...MAILLONS_FOURNISSEUR.map((m) => `  ${m.padEnd(24)} ${r.chaine[m]}`),
    `  ${"PROVIDER_PROVEN".padEnd(24)} ${r.providerProven ? "YES" : "NO"}`,
    "",
    "  CHAÎNE MISSION",
    ...MAILLONS_MISSION.map((m) => `  ${m.padEnd(24)} ${r.chaine[m]}`),
    `  ${"MISSION_E2E_PROVEN".padEnd(24)} ${r.missionE2eProven ? "YES" : "NO"}`,
    "",
    ...(r.premierEchecFournisseur ? [`Premier maillon fournisseur rompu : ${r.premierEchecFournisseur}`] : []),
    ...(r.premierEchecMission ? [`Premier maillon mission rompu     : ${r.premierEchecMission}`] : []),
    ...(r.raison ? [`Raison : ${r.raison}`] : []),
    "",
    ...(r.setupValide
      ? []
      : [`BANC INVALIDE (SETUP_FAILED) — aucune mesure : ${r.raisonSetup}`, ""]),
    ...(r.artefactsInattendus.length > 0
      ? [`⚠ ARTEFACTS CRÉÉS SOUS PLAFOND DE LECTURE : ${r.artefactsInattendus.join(", ")}`, ""]
      : []),
    "── Mesures globales ─────────────────────────────────────",
    `  jeton de ce run              ${r.jeton}`,
    `  OPENAI_API_KEY présente      ${r.cleDisponible ? "oui" : "NON"}`,
    `  modèle (rendu par l'API)     ${val(r.modele)}`,
    `  appels de modèle             ${r.appelsModele}`,
    `  jetons entrée / sortie       ${r.jetonsEntree} / ${r.jetonsSortie}`
    + (r.jetonsReflexion !== null ? `  (dont ${r.jetonsReflexion} de réflexion en sortie)` : ""),
    `  capacités ouvertes (plafond) ${val(r.capacitesOuvertes)}`,
    `  latence totale               ${ms(r.latenceTotaleMs)}`,
    `  missions de banc arrêtées    ${r.missionsArretees} (le battement ne les reprendra pas)`,
    "",
  ];

  for (const s of r.scenarios) {
    lignes.push(
      `── SCÉNARIO ${s.genre}${s.setupEchoue ? " — INVALID / SETUP_FAILED" : ""} ──────────────────────`,
      `  demande        « ${s.demande.slice(0, 150)}… »`,
      `  vérité terrain ${s.verite}`,
      // LA PRÉCONDITION EST AFFICHÉE SOURCE PAR SOURCE : « toutes à zéro » n'a de valeur que si
      // l'on voit LESQUELLES ont été comptées.
      ...(s.precondition
        ? [`  précondition   ${s.precondition.satisfaite === true ? "OK" : "ÉCHEC"} — `
          + s.precondition.sources.map((x) => `${x.source.split(" ")[0]}=${x.compte < 0 ? "?" : x.compte}`).join(" · ")]
        : []),
      ...(s.setupEchoue ? [`  arrêt          ${s.motifArret}`, ""] : []),
      ...(s.setupEchoue ? [] : [
        `  mission        ${val(s.missionId)}`,
        `  état final     ${val(s.statutFinal)} ${s.stable ? "(stable)" : "(NON STABLE)"}`,
        `  arrêt          ${s.motifArret}`,
        `  tours moteur   ${s.toursMoteur} · replanifications ${s.replanifications} · plan v${val(s.versionPlan)}`,
        // CE QUE LES REPLANIFICATIONS ONT COÛTÉ, et pas seulement combien il y en a eu.
        `  appels modèle  ${Object.entries(s.appelsParUsage).map(([k, n]) => `${k.replace("mission.", "")}×${n}`).join(" · ") || "—"}`
        + (s.cascade ? `  (modèle ${ms(s.cascade.tempsModeleMs)} / total ${ms(s.cascade.totalMs)})` : ""),
        `  recours        ${s.recoursObserves} événement(s) STEP_RECOVERY`,
        `  étapes         ${val(s.etapesCompilees)} compilées · ${s.etapesTerminees} terminées · ${s.etapesEnEchec} en échec`,
        // POLITIQUE / PLAN / EXÉCUTION, dans cet ordre : ce sont trois faits différents, et les
        // confondre est exactement ce qui a produit un faux vert.
        `  effet          autorisé ${s.effetMaxAutorise} · planifié ${val(s.effetMaxPlanifie)} · EXÉCUTÉ ${val(s.effetMaxExecute)}`,
        `  artefacts      ${val(s.artefactsAvant)} → ${val(s.artefactsApres)}`
        + (s.artefactsCrees.length > 0 ? `  ⚠ CRÉÉS : ${s.artefactsCrees.join(", ")}` : "  (aucun créé)"),
        `  QA / objectif  ${val(s.qaPassed)} / ${val(s.goalSatisfied)}`,
        ...(s.goalVerdict ? [`  verdict juge   ${s.goalVerdict.slice(0, 200)}`] : []),
        "",
      ]),
    );
    if (s.cascade) lignes.push(...rendreCascade(s.cascade).map((l) => `  ${l}`), "");
  }

  // LE TAUX DE CONTOURNEMENT DU PLANIFICATEUR (§18) — compté sur les scénarios réellement
  // lancés : combien ont obtenu leur plan par le CODE, sans payer un appel de planification.
  const lances = r.scenarios.filter((s) => !s.setupEchoue && s.cascade);
  const directes = lances.filter((s) => s.cascade?.voiePlan === "DIRECTE");
  if (lances.length > 0) {
    lignes.push(
      `  bypass planificateur   ${directes.length}/${lances.length} scénario(s) planifiés par le CODE`
      + (directes.length > 0 ? ` (${directes.map((s) => s.genre).join(", ")})` : ""),
      "");
  }

  lignes.push("══════════════════════════════════════════════════════════");
  return lignes.join("\n");
}
