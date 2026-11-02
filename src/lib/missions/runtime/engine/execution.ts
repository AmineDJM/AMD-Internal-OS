/**
 * Moteur de mission — L'EXÉCUTION D'UNE ÉTAPE : échéances, résolution des références `{{…}}`,
 * exécution, application de l'issue, aiguillage par type de nœud, appel d'une capacité et sa cible.
 */
import { prisma } from "@/lib/prisma";
import type { Clock, MissionActor } from "@/lib/missions/ports";
import { lireReponse } from "@/lib/missions/runtime/reponse";
import { verifierAvantAgir } from "@/lib/missions/agent/principal";
import { EtatEtape, EtatMission, cleIdempotence, compter, journaliser } from "@/lib/missions/runtime/store";
import { diagnostiquerReferences, injecterSorties, referencesDe, type DiagnosticReference, type SortieAmont } from "@/lib/missions/runtime/interpolate";
import { attenduDe, evaluerResultat } from "@/lib/missions/recovery/evaluate";
import { verifierContrat } from "@/lib/missions/registry/result-contract";
import { utilisablePourAgir } from "@/lib/missions/recovery/strategy";
import type { ActionRecours } from "@/lib/missions/recovery/action";
import { EFFECT_RANK } from "@/lib/missions/registry/capability-meta";
import { evaluerCondition, lireCondition } from "@/lib/missions/runtime/condition";
import { lireAttente, lireProgres } from "@/lib/missions/events/match";
import { resultatJonction } from "@/lib/missions/runtime/sorties";
import { rattraperFaitAnterieur } from "@/lib/missions/events/router";
import { fabriquerRecu } from "@/lib/missions/runtime/receipt";
import { vueParentEventail } from "@/lib/missions/runtime/worker";
import { type EngineDeps, metaDe, type StepContext, type StepOutcome } from "@/lib/missions/runtime/engine/contrat";
import { SYNTHESE } from "@/lib/missions/runtime/engine/ordonnancement";
import { tenterRecours } from "@/lib/missions/runtime/engine/recours";
import { ecrireSortie } from "@/lib/missions/runtime/engine/sortie";
import { deployerEventail } from "@/lib/missions/runtime/engine/eventail";

type Sortie =
  | { kind: "expansion"; n: number }
  | { kind: "etape"; echouee: boolean; dedupliquee: boolean };

/**
 * EXÉCUTE UNE ÉTAPE, et écrit le résultat. C'EST le point de reprise (§14).
 *
 * L'écriture suit immédiatement l'exécution, sans regrouper : différer pour « écrire par lot »
 * ferait perdre exactement le travail qu'on cherche à ne pas refaire.
 */
/** Les nœuds dont l'entrée ou l'attente peut lire la sortie d'une étape amont. */
const NOEUDS_A_RESOUDRE: ReadonlySet<string> = new Set(["CAPABILITY", "WORKER", "ARTIFACT", "WAIT_EVENT", "WAIT_INPUT"]);

/** Les échéances d'une attente, dans un ordre stable — pour comparer l'écrit et le résolu. */
function echeancesDe(w: Record<string, unknown> | null): unknown[] {
  if (!w) return [];
  const branches = (k: string): unknown[] =>
    Array.isArray(w[k]) ? (w[k] as unknown[]).map((b) => (b && typeof b === "object" ? (b as Record<string, unknown>).until : undefined)) : [];
  return [w.until, ...branches("anyOf"), ...branches("allOf")];
}

/** « 30/11/2026 » → « 2026-11-30 » : la seule forme de date qu'on normalise, parce qu'elle est sans ambiguïté en français. */
function normaliserDate(u: unknown): unknown {
  if (typeof u !== "string") return u;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(u.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : u;
}

/**
 * RÉSOUT LES RÉFÉRENCES D'UNE ÉTAPE contre les sorties de la mission — ou dit pourquoi elle ne
 * peut pas partir. Pure vis-à-vis de la base : la persistance de l'attente résolue est faite
 * par l'appelant, une fois, et seulement si quelque chose a changé.
 */
function resoudreReferencesEtape(
  etat: EtatMission,
  step: EtatEtape,
): { step: EtatEtape; sortie?: StepOutcome; attenteResolue: boolean; phrases?: DiagnosticReference[] } {
  if (!NOEUDS_A_RESOUDRE.has(step.nodeType)) return { step, attenteResolue: false };
  if (referencesDe(step.input).length === 0 && referencesDe(step.waitFor).length === 0) return { step, attenteResolue: false };

  /**
   * LE PARENT D'UN ÉVENTAIL EST VU PAR SES FILLES, pas par sa comptabilité (§118.20).
   *
   * Sans `vueParentEventail`, `{{lire:contrats.texte}}` tombe sur `{ done, keys, failed,
   * expanded }` dès que l'étape amont s'est démultipliée — et toute sa descendance meurt sur
   * « l'étape a abouti mais ne rend pas « texte » ». Mesuré : 24 étapes tuées sur une seule
   * mission par une référence que le planificateur avait écrite JUSTE.
   *
   * `vueParentEventail` rend `null` sur une étape qui n'est pas un parent d'éventail : les
   * étapes ordinaires gardent exactement leur résultat, au bit près.
   */
  const sorties = new Map<string, SortieAmont>();
  for (const s of etat.steps) {
    if (s.key === step.key) continue;
    sorties.set(s.key, { status: s.status, result: vueParentEventail(s, etat) ?? s.result });
  }
  const diagnostics = [...diagnostiquerReferences(step.input, sorties), ...diagnostiquerReferences(step.waitFor, sorties)];
  const gab = (d: DiagnosticReference) => `{{${d.ref}}}`;
  const echec = (error: string): StepOutcome => ({ status: "FAILED", error, errorKind: "INVALID_STEP", retryable: false });

  // L'ORDRE EST CELUI DE L'INFORMATION : une faute de plan (étape inconnue, chemin absent) se dit
  // avant une absence de matière (liste vide, amont non abouti) — sinon le saut la masquerait.
  const inconnue = diagnostics.find((d) => d.etat === "ETAPE_INCONNUE");
  if (inconnue) {
    return { step, attenteResolue: false, sortie: echec(`« ${gab(inconnue)} » désigne une étape « ${inconnue.etape} » absente de la mission.`) };
  }
  const absent = diagnostics.find((d) => d.etat === "CHEMIN_ABSENT");
  if (absent) {
    const dispo = absent.disponibles.length > 0
      ? `champs disponibles : ${absent.disponibles.join(", ")}`
      : "elle ne rend aucun champ à cet endroit";
    return { step, attenteResolue: false, sortie: echec(`« ${gab(absent)} » : l'étape « ${absent.etape} » a abouti mais ne rend pas « ${absent.chemin} » — ${dispo}.`) };
  }
  const vide = diagnostics.find((d) => d.etat === "COLLECTION_VIDE");
  if (vide) {
    return { step, attenteResolue: false, sortie: { status: "SKIPPED", raison: `rien à traiter : « ${gab(vide)} » — la liste rendue par l'étape « ${vide.etape} » est vide.` } };
  }
  const nonAboutie = diagnostics.find((d) => d.etat === "ETAPE_NON_ABOUTIE");
  if (nonAboutie && !SYNTHESE.has(step.nodeType)) {
    return { step, attenteResolue: false, sortie: { status: "SKIPPED", raison: `« ${gab(nonAboutie)} » attend l'étape « ${nonAboutie.etape} », qui n'a pas abouti (${nonAboutie.statut ?? "?"}).` } };
  }

  // LA TRADUCTION EST REMONTÉE, JAMAIS TAISÉE. Un filtre silencieux ne laisse aucune trace de ce
  // qu'il retire (§118.52) ; ici rien n'est retiré, mais le plan a demandé un CHAMP et reçu une
  // PHRASE — c'est le genre de fait dont le compte rendu d'une mission a besoin, et le seul
  // signal qui dise au lecteur pourquoi une consolidation parle d'une absence.
  const phrases = diagnostics.filter((d) => d.etat === "PHRASE_ENTIERE");

  const valeurs = new Map<string, unknown>();
  for (const [k, v] of sorties) if (v.status === "DONE") valeurs.set(k, v.result);
  const input = injecterSorties(step.input, valeurs) as Record<string, unknown>;
  const waitFor = step.waitFor ? (injecterSorties(step.waitFor, valeurs) as Record<string, unknown>) : null;
  const attenteResolue = waitFor !== null && JSON.stringify(waitFor) !== JSON.stringify(step.waitFor);

  if (attenteResolue && step.nodeType === "WAIT_EVENT" && waitFor) {
    // UNE ÉCHÉANCE DÉRIVÉE DOIT ÊTRE UNE DATE. « {{analyse.dateEcheance}} » qui se résout à
    // rien, ou à « fin novembre », ferait dormir la mission pour toujours : on échoue tout de
    // suite, avec la valeur, et la replanification a de quoi corriger.
    if ("until" in waitFor) waitFor.until = normaliserDate(waitFor.until);
    for (const k of ["anyOf", "allOf"]) {
      if (!Array.isArray(waitFor[k])) continue;
      for (const b of waitFor[k] as unknown[]) {
        if (b && typeof b === "object" && "until" in (b as Record<string, unknown>)) {
          (b as Record<string, unknown>).until = normaliserDate((b as Record<string, unknown>).until);
        }
      }
    }
    const ecrites = echeancesDe(step.waitFor);
    const resolues = echeancesDe(waitFor);
    for (let i = 0; i < ecrites.length; i += 1) {
      if (typeof ecrites[i] !== "string" || referencesDe(ecrites[i]).length === 0) continue;
      const r = resolues[i];
      if (typeof r !== "string" || r.trim() === "" || !Number.isFinite(Date.parse(r))) {
        return { step, attenteResolue: false, sortie: echec(`l'échéance dérivée « ${String(ecrites[i])} » vaut « ${r === undefined || r === null ? "" : String(r)} », qui n'est pas une date lisible : cette attente ne se réveillerait jamais.`) };
      }
    }
  }
  return { step: { ...step, input, waitFor }, attenteResolue, phrases };
}

export async function executerUneEtape(
  etat: EtatMission,
  step: EtatEtape,
  actor: MissionActor,
  deps: EngineDeps,
  clock: Clock,
): Promise<Sortie> {
  // ── L'ÉTAPE CONDITIONNELLE : la condition se lit AVANT tout, éventail compris ──────────
  //
  // « Si pas de réponse avant vendredi, relance » : l'étape « relance » dépend de l'attente,
  // et ne part que si l'attente s'est réglée par le TEMPS. Non remplie, elle est IGNORÉE —
  // le journal dit pourquoi, avec les valeurs — et la suite du plan continue (§37).
  const condition = lireCondition(step.spec?.when);
  if (condition) {
    const amont = etat.steps.find((s) => s.key === condition.step);
    const verdict = evaluerCondition(condition, amont ? { status: amont.status, result: amont.result } : undefined);
    if (!verdict.remplie) {
      await ecrireSortie(etat, step, { status: "SKIPPED", raison: `condition non remplie — ${verdict.raison}` }, clock);
      return { kind: "etape", echouee: false, dedupliquee: false };
    }
  }

  // L'ÉVENTAIL SE DÉPLOIE AVANT TOUT AUTRE TRAITEMENT : ce n'est pas une étape à exécuter, c'est
  // une étape qui en fabrique d'autres.
  if (step.forEach) {
    const n = await deployerEventail(etat, step, step.forEach);
    return { kind: "expansion", n };
  }

  // ── LA TUYAUTERIE ENTRE ÉTAPES : `{{cle_etape.chemin}}` se résout ICI, avant tout appel ──
  //
  // Le planificateur compose ses étapes en lisant la sortie des précédentes ; le moteur, lui,
  // ne résolvait que les alias d'éventail, et « {{analyse:coherence.actionPaiement}} » partait
  // en toutes lettres vers l'outil (banc m5 : quatre plans sur neuf). Le diagnostic précède
  // l'injection : un chemin absent ÉCHOUE en nommant les champs rendus, une liste amont vide
  // IGNORE l'étape, une étape amont non aboutie n'invente rien.
  const resolution = resoudreReferencesEtape(etat, step);
  const stepExec = resolution.step;
  for (const p of resolution.phrases ?? []) {
    // Le fait, pas une interprétation : quel champ a été demandé, à quelle étape, et ce qu'elle
    // a répondu à la place. Écrit UNE fois par référence traduite, donc jamais du bruit.
    await journaliser(
      etat.id,
      "REFERENCE_TRADUITE",
      `« {{${p.ref}}} » : l'étape « ${p.etape} » a répondu par une PHRASE, sans aucun champ — `
      + `sa réponse entière remplace « ${p.chemin} ». La capacité a bien répondu ; sa réponse `
      + "n'était pas structurée.",
      { step: step.key, ref: p.ref, etape: p.etape, chemin: p.chemin },
    );
  }
  if (resolution.attenteResolue) {
    // L'ATTENTE DEVIENT CONCRÈTE EN BASE : le balayage temporel lit `waitFor.until` tel quel,
    // et une référence non résolue ne réveillerait jamais personne.
    await prisma.missionStep.update({ where: { id: step.id }, data: { waitFor: (stepExec.waitFor ?? null) as never } });
  }

  const ctx: StepContext = { mission: etat, step: stepExec, actor, clock };
  let sortie: StepOutcome;
  if (resolution.sortie) {
    sortie = resolution.sortie;
  } else {
    try {
      sortie = await dispatcher(ctx, deps);
    } catch (e) {
      sortie = {
        status: "FAILED",
        error: e instanceof Error ? e.message : String(e),
        errorKind: "CAPABILITY_FAILURE",
        retryable: true,
      };
    }
  }

  // ── §5 — RÉUSSITE TECHNIQUE ≠ RÉUSSITE SÉMANTIQUE ──────────────────────────────────
  //
  // Une capacité qui rend 200 avec le mauvais document a réussi son appel, pas l'objectif.
  // L'évaluation est déterministe et ne coûte aucun appel de modèle ; en l'absence de
  // critère (`spec.attendu`), elle se tait et le résultat passe tel quel.
  if (sortie.status === "DONE" && sortie.receipt !== "DEDUPLIQUE") {
    const verdict = evaluerResultat(attenduDe(step.spec), sortie.result);
    // §107-109 — C'EST LA CERTITUDE QUI AUTORISE À AGIR, pas l'absence d'erreur.
    //
    // Un CANDIDAT peut guider la recherche suivante ; il ne peut pas satisfaire l'objectif ni
    // déclencher un effet externe. En passant par `utilisablePourAgir`, l'acceptation d'une
    // étape est gouvernée par l'échelle TROUVÉ / DÉDUIT / CANDIDAT / INCONNU — et non par un
    // test local qui lui ressemblerait.
    if (verdict.kind || !utilisablePourAgir(verdict.certitude)) {
      sortie = {
        status: "FAILED",
        error: verdict.raison,
        // `kind` est nul seulement quand la certitude vaut TROUVÉ ; on ne peut donc pas
        // arriver ici sans cause. Le repli nomme quand même la seule qui aurait du sens.
        errorKind: verdict.kind ?? "INSUFFICIENT_DATA",
        // Rejouer À L'IDENTIQUE ne changerait rien : c'est le CHEMIN qu'il faut changer, et
        // c'est le recours local qui en décide juste en dessous.
        retryable: false,
      };
    }
  }

  // ── §10 — LE RECOURS LOCAL, AVANT D'ÉPUISER L'ÉTAPE ────────────────────────────────
  if (sortie.status === "FAILED") {
    const repris = await tenterRecours(etat, stepExec, sortie, clock, { registre: deps.registre, acteur: actor, catalog: deps.catalog });
    if (repris) return { kind: "etape", echouee: false, dedupliquee: false };
  }

  await ecrireSortie(etat, step, sortie, clock);
  return {
    kind: "etape",
    echouee: sortie.status === "FAILED",
    dedupliquee: sortie.status === "DONE" && sortie.receipt === "DEDUPLIQUE",
  };
}

/**
 * TRADUIT L'ACTION EN (CAPACITÉ, ENTRÉE) EFFECTIVES — le seul endroit qui touche l'étape.
 *
 * `courante` est rendue telle quelle quand l'action ne change pas de capacité : rendre `null`
 * ferait croire à un changement à la comparaison qui suit, et l'on écrirait `capability: null`
 * en base sur une étape qui en a une.
 */
export function appliquer(
  action: ActionRecours,
  courante: string | null,
  entree: Record<string, unknown>,
): { capability: string | null; input: Record<string, unknown> } {
  switch (action.type) {
    case "AUTRE_CAPACITE":
      return { capability: action.capability, input: action.input };
    case "REQUETE_ELARGIE":
      return { capability: courante, input: action.input };
    case "REJEU":
      return { capability: courante, input: entree };
  }
}

/** Aiguille selon le type de nœud. Les types de CONTRÔLE ont un comportement natif. */
async function dispatcher(ctx: StepContext, deps: EngineDeps): Promise<StepOutcome> {
  const { step } = ctx;
  const h = deps.handlers ?? {};

  switch (step.nodeType) {
    case "JOIN":
      // Une jonction ne fait rien : ses dépendances étant terminées, elle l'est aussi. Son
      // existence sert à réduire le nombre d'arêtes, pas à produire quoi que ce soit — les
      // DONNÉES, elles, la traversent (`amontDeLEtape`), et le compilateur refuse d'y lire
      // autre chose que son compteur.
      return { status: "DONE", result: resultatJonction(step.dependsOn.length) };

    case "WAIT_EVENT": {
      if (h.WAIT_EVENT) return h.WAIT_EVENT(ctx);
      // ── LES FAITS DÉJÀ ARRIVÉS (événements dans le désordre) ────────────────────────────
      //
      // Avant de dormir, l'attente regarde si ce qu'elle attend est DÉJÀ au registre — arrivé
      // pendant l'accord, la lecture amont, ou entre deux tours. La fenêtre commence à la fin
      // de la dernière dépendance qui ÉCRIT (la demande) : un fait antérieur à la demande n'est
      // pas une réponse. Une progression partielle (« le contrat ET le devis » : le contrat
      // déjà là) est persistée avec l'attente.
      const attente = lireAttente(step.waitFor);
      if (attente) {
        const clesEcritures = step.dependsOn.filter((k) => {
          const d = ctx.mission.steps.find((x) => x.key === k);
          return d?.capability ? EFFECT_RANK[metaDe(d.capability, deps.catalog).effect] >= EFFECT_RANK.INTERNAL_REVERSIBLE_WRITE : false;
        });
        const deja = lireProgres(step.result);
        const r = await rattraperFaitAnterieur({ missionId: ctx.mission.id, stepKey: step.key, attente, dejaReglees: deja, clesEcritures, maintenant: ctx.clock.now() });
        if (r.complete && r.fait) {
          return { status: "DONE", result: { reveillePar: r.fait.type, ...lireReponse(r.fait.payload), payload: (r.fait.payload ?? null) as never, attenteProgres: r.reglees, rattrape: true } };
        }
        if (r.reglees.length > deja.length) {
          return { status: "WAITING", raison: `attend l'événement ${String(step.waitFor?.event ?? "?")} (une partie déjà arrivée)`, result: { attenteProgres: r.reglees } };
        }
      }
      return { status: "WAITING", raison: `attend l'événement ${String(step.waitFor?.event ?? "?")}` };
    }

    case "WAIT_INPUT":
      return h.WAIT_INPUT
        ? h.WAIT_INPUT(ctx)
        : { status: "WAITING", raison: String(step.waitFor?.ask ?? "attend un élément humain") };

    case "APPROVAL":
      return h.APPROVAL
        ? h.APPROVAL(ctx)
        // SANS GESTIONNAIRE D'APPROBATION, ON ATTEND — jamais on ne passe. Le défaut d'une porte
        // est d'être fermée : l'inverse ferait d'une brique manquante une autorisation tacite.
        : { status: "WAITING", raison: "attend une approbation" };

    case "WORKER":
      return h.WORKER
        ? h.WORKER(ctx)
        : { status: "FAILED", error: "aucun exécutant de worker n'est branché", errorKind: "MISSING_WORKER", retryable: false };

    case "QA":
      return h.QA ? h.QA(ctx) : { status: "SKIPPED", raison: "aucun contrôleur qualité n'est branché" };

    case "ARTIFACT":
      return h.ARTIFACT
        ? h.ARTIFACT(ctx)
        : { status: "FAILED", error: "aucune fabrique d'artefact n'est branchée", errorKind: "MISSING_ARTIFACT", retryable: false };

    case "CAPABILITY":
    default:
      return executerCapacite(ctx, deps);
  }
}

/** L'appel d'une capacité, avec sa clé d'idempotence quand l'étape en réclame une. */
async function executerCapacite(ctx: StepContext, deps: EngineDeps): Promise<StepOutcome> {
  const { step, mission, actor } = ctx;
  if (!step.capability) {
    return { status: "FAILED", error: "étape CAPABILITY sans capacité", errorKind: "INVALID_STEP", retryable: false };
  }

  // ── §29 : L'INTERDIT D'AUTO-ESCALADE, VÉRIFIÉ UNE SECONDE FOIS ────────────────────────
  //
  // Le compilateur l'a déjà refusé. Cette garde-ci couvre le cas où l'étape n'est PAS venue
  // d'un plan compilé : une reprise, une réparation, ou une ligne insérée directement en base.
  // Une garde qui ne vit qu'à un seul endroit protège tant que personne n'ouvre un second
  // chemin ; celle-ci protège aussi le second chemin.
  if (deps.catalog?.has(step.capability)) {
    const v = verifierAvantAgir(step.capability, deps.catalog.meta(step.capability).effect, actor);
    if (!v.ok) {
      return { status: "FAILED", error: v.raison, errorKind: "MISSING_PERMISSION", retryable: false };
    }
  }

  const cle = step.idempotencyKey
    ?? (step.needsIdempotencyKey ? cleIdempotence(mission.id, step.key, step.capability, cibleDe(step.input)) : null);

  if (cle && cle !== step.idempotencyKey) {
    // POSER LA CLÉ AVANT D'AGIR. Si une autre exécution l'a déjà posée, l'unicité en base
    // refuse — et ce refus EST l'information : le travail a déjà été réclamé ailleurs.
    try {
      await prisma.missionStep.update({ where: { id: step.id }, data: { idempotencyKey: cle } });
    } catch {
      return { status: "DONE", receipt: "DEDUPLIQUE", result: { deduplique: true } };
    }
  }

  const debut = ctx.clock.now();
  const out = await deps.runner.run({
    capability: step.capability,
    input: step.input,
    actor,
    missionId: mission.id,
    stepKey: step.key,
    idempotencyKey: cle,
  });

  await compter(mission.id, { toolCalls: 1 });

  /**
   * ── LE REÇU EST FABRIQUÉ ICI, ET SEULEMENT ICI ────────────────────────────────────────
   *
   * C'est le seul endroit où l'on détient les cinq faits à la fois : la capacité appelée,
   * l'effet que le REGISTRE lui déclare, l'entrée réellement partie, les deux horodatages, et
   * la sortie. Le fabriquer plus loin obligerait à les repasser ; le fabriquer plus tôt
   * obligerait à deviner le résultat.
   *
   * Il est fabriqué même sur ÉCHEC : « nous avons interrogé cette source et l'appel a échoué »
   * est une information, et c'est celle qui distingue une piste non explorée d'une piste
   * explorée sans succès.
   */
  const meta = metaDe(step.capability, deps.catalog);

  /**
   * ── LE SUCCÈS SÉMANTIQUE, ENTRE LE TRANSPORT ET L'ATTENDU DE L'ÉTAPE ─────────────────
   *
   * Quatre niveaux existent, et le runtime n'en tenait que deux :
   *
   *   1. transport      le handler n'a pas levé  → le `try` de `executerUneEtape` ;
   *   2. capacité       elle n'a pas déclaré d'échec → `out.ok` ;
   *   3. SÉMANTIQUE     ce qu'elle rend satisfait ce qu'elle PROMET → ici, et nulle part avant ;
   *   4. attendu        la forme correspond à `spec.attendu` → `recovery/evaluate.ts`.
   *
   * Le 3 manquait, et son absence a un coût nommable : sur un run réel, `read_document` a rendu
   * « Pièce introuvable ou sans fichier », l'étape est passée DONE, et le juge d'objectif a reçu
   * comme preuve de lecture une phrase disant que la lecture n'avait pas eu lieu.
   *
   * Le contrôle porte sur la FORME (`out.structured` : une structure, ou une phrase ?), jamais
   * sur le sens de la phrase — voir `result-contract.ts`. Une capacité sans contrat déclaré
   * (`LIBRE`, le défaut) n'est pas contrôlée : on ne vérifie pas une promesse qui n'a pas été
   * faite.
   */
  const verdict = out.ok
    ? verifierContrat(meta.contrat, out.output, out.structured, EFFECT_RANK[meta.effect] >= EFFECT_RANK.PREPARE)
    : null;
  const honore = verdict === null || verdict.etat === "SUCCESS";

  const recu = fabriquerRecu({
    capability: step.capability,
    effect: meta.effect,
    source: meta.domain,
    input: step.input,
    // LE REÇU DIT CE QUI S'EST VRAIMENT PASSÉ. Un contrat non honoré n'est pas un succès, et
    // laisser `ok: out.ok` ici ferait entrer dans le registre de preuves une lecture qui n'a
    // rien lu — exactement la preuve fabriquée que ce lot existe pour supprimer.
    ok: out.ok && honore,
    sortie: out.output,
    debut,
    fin: ctx.clock.now(),
    deduplicated: out.deduplicated,
  });

  if (!out.ok) {
    return {
      status: "FAILED",
      error: out.error?.message ?? "échec sans message",
      errorKind: out.error?.kind ?? "CAPABILITY_FAILURE",
      retryable: out.error?.retryable ?? true,
      recu,
    };
  }
  if (verdict && !honore) {
    return {
      status: "FAILED",
      error: `${step.capability} : ${verdict.raison}`,
      errorKind: verdict.kind ?? "INCOMPATIBLE_RESULT",
      // REJOUER À L'IDENTIQUE REDIRAIT LA MÊME CHOSE. C'est le CHEMIN qu'il faut changer, et
      // `tenterRecours` — appelé juste après par `executerUneEtape` — en décide.
      retryable: false,
      recu,
    };
  }
  return {
    status: "DONE", result: out.output, recu,
    receipt: out.deduplicated ? "DEDUPLIQUE" : undefined,
  };
}

/** La cible d'une action — ce qui rend la clé unique par PERSONNE, pas seulement par étape. */
function cibleDe(input: Record<string, unknown>): string | null {
  for (const champ of ["to", "destinataire", "employeeId", "userId", "personId", "recordId", "id"]) {
    const v = input[champ];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}
