import type { CompiledMission, CompiledStep, StepSpec } from "@/lib/missions/compiler/compile";
import type { Effect } from "@/lib/missions/registry/capability-meta";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PLAN D'UN TRAVAIL (J2, décision 0016) — ce que le modèle propose, ce que la personne approuve,
 * ce que le moteur exécute. Module PUR : aucune base, aucun modèle — l'écran (carte « Approuver le
 * plan ») le lit comme le serveur.
 *
 * Un travail n'est PAS un troisième moteur : ce fichier traduit un plan court, lisible par une
 * personne (« lis, analyse par lots, attends la signature, relance, rédige »), en étapes du Mission
 * Runtime (`CompiledStep`), que `materialiser` écrit et `avancer` conduit — avec les reçus, les baux,
 * les clés d'idempotence, les éventails et les attentes qui existent déjà.
 *
 *   LECTURE   un outil de lecture de la persona, sous les droits RELUS de la personne   → CAPABILITY
 *   ANALYSE   le modèle lit le CARNET et les sorties amont, écrit notes et trouvailles  → WORKER
 *   LOTS      découpe une liste en lots bornés (le code, pas le modèle)               → CAPABILITY
 *   GESTE     une écriture APPROUVÉE avec le plan, rejugée juste avant d'agir          → CAPABILITY (clé)
 *   ATTENTE   un événement métier (prédicat, échéance) ou une minuterie               → WAIT_EVENT
 *   LIVRABLE  le document final, rédigé depuis le carnet                              → ARTIFACT
 *
 * Une étape peut être CONDITIONNELLE (`si` : « relance SEULEMENT si l'attente s'est réglée par le
 * temps ») et une ANALYSE peut se DÉMULTIPLIER (`pourChaque` : une analyse par lot).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const PERSONAS_TRAVAIL = ["ADAM", "ASSISTANT_IA"] as const;
export type PersonaTravail = (typeof PERSONAS_TRAVAIL)[number];

export const TYPES_ETAPE = ["LECTURE", "ANALYSE", "LOTS", "GESTE", "ATTENTE", "LIVRABLE"] as const;
export type TypeEtape = (typeof TYPES_ETAPE)[number];

export const ISSUES_SI = ["EVENT", "TIMEOUT", "DONE", "FAILED", "SKIPPED"] as const;
export type IssueSi = (typeof ISSUES_SI)[number];

/** Les bornes OPÉRATIONNELLES d'un plan — un travail plus gros se découpe en lots, pas en étapes écrites. */
export const BORNES_PLAN = {
  etapes: 40,
  /** Un lot : entre 5 et 100 éléments ; au plus 50 lots (la taille s'élargit au besoin). */
  tailleLotMin: 5,
  tailleLotMax: 100,
  lotsMax: 50,
  elementsMax: 5_000,
  /** Une attente ne dépasse pas six mois. */
  joursMax: 180,
} as const;

/** Le plafond d'un travail quand la console n'en dit rien (décision 4 de la Direction). */
export const PLAFOND_TRAVAIL_DEFAUT_USD = 20;
export const PLAFOND_MENSUEL_DEFAUT_USD = 50;

/** Les capacités qu'un travail appelle, préfixées : le préfixe dit QUI les exécute. */
export const PREFIXE = { lecture: "lecture:", geste: "geste:", lots: "travail:lots" } as const;

export interface AttenteTravail {
  /** Le type d'événement métier attendu (registre `BusinessEvent`) : « DOCUMENT_STATUT », « MAIL_RECU »… */
  evenement?: string;
  /** L'entité concernée, « TYPE:id ». */
  entite?: string;
  /** Le prédicat sur la charge utile : chaque champ doit valoir exactement cette valeur. */
  champs?: Record<string, string | number | boolean>;
  /** L'échéance (avec un événement) ou la durée de la minuterie (seule). */
  jours?: number;
  minutes?: number;
}

export interface EtapeTravail {
  cle: string;
  titre: string;
  type: TypeEtape;
  /** Les étapes qui doivent être terminées avant celle-ci. */
  apres?: string[];
  /** LECTURE : l'outil de lecture ; GESTE : le geste. */
  outil?: string;
  /** Les arguments ; `{{cle.chemin}}` lit la sortie d'une étape amont (résolu par le moteur). */
  entree?: Record<string, unknown>;
  /** ANALYSE et LIVRABLE : ce qu'il faut en tirer, en une ou deux phrases. */
  consigne?: string;
  /** LOTS : la liste à découper (sortie d'une étape amont) et la taille d'un lot. */
  lots?: { etape: string; chemin: string; taille?: number };
  /** ANALYSE : une analyse par élément de la liste rendue par `etape` (en général : des LOTS). */
  pourChaque?: { etape: string; chemin?: string; comme?: string };
  attente?: AttenteTravail;
  /** Ne part que si l'étape `etape` s'est terminée ainsi (ex. relance : `{ etape: "attente-bc", issue: "TIMEOUT" }`). */
  si?: { etape: string; issue: IssueSi };
}

export interface PlanTravail {
  titre: string;
  objectif: string;
  etapes: EtapeTravail[];
}

/** Ce que la persona sait lire et faire POUR CETTE personne, maintenant — la validation s'y tient. */
export interface CatalogueTravail {
  lectures: { nom: string; libelle: string }[];
  gestes: { nom: string; libelle: string; famille: string; libelleFamille: string }[];
}

/** Un geste approuvé avec le plan : la liste que la carte montre et que le moteur relit avant chaque écriture. */
export interface GesteAutorise {
  nom: string;
  libelle: string;
  famille: string;
  libelleFamille: string;
}

const CLE_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const txt = (v: unknown, max = 300): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * LIT UN PLAN VENU DU MODÈLE — retypé, jamais cru sur parole. Rend le plan propre ou la liste des
 * fautes, en français, que l'outil renvoie au modèle pour qu'il corrige (et que la carte affiche).
 */
export function lirePlan(brut: unknown, catalogue: CatalogueTravail): { ok: true; plan: PlanTravail; gestes: GesteAutorise[] } | { ok: false; fautes: string[] } {
  const o = obj(brut);
  const fautes: string[] = [];
  if (!o) return { ok: false, fautes: ["Le plan doit être un objet { titre, objectif, etapes }."] };
  const titre = txt(o.titre, 120);
  const objectif = txt(o.objectif, 2000);
  if (!titre) fautes.push("Titre manquant.");
  if (!objectif) fautes.push("Objectif manquant.");
  const brutes = Array.isArray(o.etapes) ? o.etapes : [];
  if (brutes.length === 0) fautes.push("Aucune étape.");
  if (brutes.length > BORNES_PLAN.etapes) fautes.push(`Au plus ${BORNES_PLAN.etapes} étapes : découpez le volume en LOTS plutôt qu'en étapes écrites.`);

  const lectures = new Set(catalogue.lectures.map((l) => l.nom));
  const gestesCat = new Map(catalogue.gestes.map((g) => [g.nom, g]));
  const etapes: EtapeTravail[] = [];
  const vues = new Set<string>();

  for (const [i, b] of brutes.slice(0, BORNES_PLAN.etapes).entries()) {
    const e = obj(b);
    const ou = `Étape ${i + 1}`;
    if (!e) { fautes.push(`${ou} : illisible.`); continue; }
    const cle = txt(e.cle, 48).toLowerCase();
    const type = txt(e.type, 20).toUpperCase() as TypeEtape;
    const nom = `${ou} « ${cle || "?"} »`;
    if (!CLE_RE.test(cle)) { fautes.push(`${ou} : clé « ${cle} » invalide (minuscules, chiffres, - ou _).`); continue; }
    if (vues.has(cle)) { fautes.push(`${nom} : clé en double.`); continue; }
    if (!(TYPES_ETAPE as readonly string[]).includes(type)) { fautes.push(`${nom} : type « ${type} » inconnu (${TYPES_ETAPE.join(", ")}).`); continue; }
    const apres = Array.isArray(e.apres) ? [...new Set(e.apres.map((x) => txt(x, 48).toLowerCase()).filter(Boolean))] : [];
    for (const a of apres) if (!vues.has(a)) fautes.push(`${nom} : « apres » désigne « ${a} », qui n'est pas une étape PRÉCÉDENTE.`);
    const etape: EtapeTravail = { cle, titre: txt(e.titre, 160) || cle, type, ...(apres.length ? { apres } : {}) };
    const entree = obj(e.entree);
    if (entree) etape.entree = entree;
    const consigne = txt(e.consigne, 1500);
    if (consigne) etape.consigne = consigne;

    const amont = (champ: string, etapeVisee: string) => {
      if (!vues.has(etapeVisee)) fautes.push(`${nom} : « ${champ} » désigne « ${etapeVisee} », qui n'est pas une étape précédente.`);
    };

    switch (type) {
      case "LECTURE": {
        const outil = txt(e.outil, 80);
        if (!lectures.has(outil)) fautes.push(`${nom} : lecture « ${outil} » inconnue ou non ouverte à cette personne.`);
        etape.outil = outil;
        break;
      }
      case "GESTE": {
        const outil = txt(e.outil, 80);
        if (!gestesCat.has(outil)) fautes.push(`${nom} : geste « ${outil} » inconnu ou fermé à cette personne (familles de la console).`);
        etape.outil = outil;
        break;
      }
      case "ANALYSE":
      case "LIVRABLE": {
        if (!consigne) fautes.push(`${nom} : « consigne » manquante (ce qu'il faut en tirer).`);
        const pc = obj(e.pourChaque);
        if (pc && type === "ANALYSE") {
          const de = txt(pc.etape, 48).toLowerCase();
          amont("pourChaque", de);
          etape.pourChaque = { etape: de, chemin: txt(pc.chemin, 80) || "lots", comme: txt(pc.comme, 30) || "lot" };
        }
        break;
      }
      case "LOTS": {
        const l = obj(e.lots);
        const de = txt(l?.etape, 48).toLowerCase();
        const chemin = txt(l?.chemin, 120);
        if (!de || !chemin) fautes.push(`${nom} : « lots » exige { etape, chemin } — la liste à découper.`);
        else amont("lots", de);
        const taille = typeof l?.taille === "number" ? Math.round(l.taille) : 25;
        etape.lots = { etape: de, chemin, taille: Math.min(BORNES_PLAN.tailleLotMax, Math.max(BORNES_PLAN.tailleLotMin, taille)) };
        break;
      }
      case "ATTENTE": {
        const a = obj(e.attente) ?? {};
        const evenement = txt(a.evenement, 80);
        const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
        const jours = num(a.jours);
        const minutes = num(a.minutes);
        if (!evenement && !jours && !minutes) fautes.push(`${nom} : une attente exige un « evenement » ou une durée (« jours » / « minutes »).`);
        if ((jours ?? 0) + (minutes ?? 0) / 1440 > BORNES_PLAN.joursMax) fautes.push(`${nom} : au plus ${BORNES_PLAN.joursMax} jours d'attente.`);
        const champs = obj(a.champs);
        etape.attente = {
          ...(evenement ? { evenement } : {}),
          ...(txt(a.entite, 120) ? { entite: txt(a.entite, 120) } : {}),
          ...(champs ? { champs: Object.fromEntries(Object.entries(champs).filter((x): x is [string, string | number | boolean] => ["string", "number", "boolean"].includes(typeof x[1]))) } : {}),
          ...(jours ? { jours } : {}),
          ...(minutes ? { minutes } : {}),
        };
        break;
      }
    }

    const si = obj(e.si);
    if (si) {
      const de = txt(si.etape, 48).toLowerCase();
      const issue = txt(si.issue, 12).toUpperCase() as IssueSi;
      amont("si", de);
      if (!(ISSUES_SI as readonly string[]).includes(issue)) fautes.push(`${nom} : « si.issue » doit valoir ${ISSUES_SI.join(", ")}.`);
      etape.si = { etape: de, issue };
    }
    vues.add(cle);
    etapes.push(etape);
  }

  if (etapes.length > 0 && !etapes.some((e) => e.type === "LIVRABLE")) {
    fautes.push("Le plan doit finir par au moins une étape LIVRABLE (le compte rendu ou le document attendu).");
  }
  if (fautes.length > 0) return { ok: false, fautes };
  const nomsGestes = [...new Set(etapes.filter((e) => e.type === "GESTE").map((e) => e.outil as string))];
  const gestes = nomsGestes.map((n) => gestesCat.get(n)!).map((g) => ({ nom: g.nom, libelle: g.libelle, famille: g.famille, libelleFamille: g.libelleFamille }));
  return { ok: true, plan: { titre, objectif, etapes }, gestes };
}

const EFFET: Record<TypeEtape, Effect> = {
  LECTURE: "READ", ANALYSE: "ANALYZE", LOTS: "ANALYZE", GESTE: "INTERNAL_REVERSIBLE_WRITE", ATTENTE: "READ", LIVRABLE: "PREPARE",
};

/** L'attente d'un plan → l'attente du moteur (`events/match.ts`), échéances ABSOLUES posées à l'approbation. */
export function attenteDuMoteur(a: AttenteTravail, maintenant: Date): Record<string, unknown> {
  const delaiMs = ((a.jours ?? 0) * 1440 + (a.minutes ?? 0)) * 60_000;
  const echeance = delaiMs > 0 ? new Date(maintenant.getTime() + delaiMs).toISOString() : null;
  if (!a.evenement) return { until: echeance };
  const branche = {
    event: a.evenement,
    ...(a.entite ? { entity: a.entite } : {}),
    ...(a.champs && Object.keys(a.champs).length ? { payload: a.champs } : {}),
  };
  return echeance ? { anyOf: [branche, { until: echeance }] } : branche;
}

/**
 * LE PLAN APPROUVÉ → LE PROGRAMME DU MOTEUR. Appelé À L'APPROBATION (et non à la proposition) : une
 * minuterie « dans 21 jours » part du jour où la personne a dit oui, pas du jour où le modèle a écrit.
 */
export function compilerTravail(plan: PlanTravail, maintenant: Date): CompiledMission {
  const steps: CompiledStep[] = plan.etapes.map((e) => {
    const dependsOn = [...new Set([
      ...(e.apres ?? []),
      ...(e.si ? [e.si.etape] : []),
      ...(e.pourChaque ? [e.pourChaque.etape] : []),
      ...(e.lots ? [e.lots.etape] : []),
    ])];
    const spec: StepSpec | null = e.si || e.type === "LIVRABLE"
      ? {
        ...(e.si ? { when: { step: e.si.etape, outcome: e.si.issue } } : {}),
        ...(e.type === "LIVRABLE" ? { artifactTitle: e.titre, artifactFormat: "md" } : {}),
      }
      : null;
    const base = {
      key: e.cle, title: e.titre, workstream: null, dependsOn, effect: EFFET[e.type], idempotent: e.type !== "GESTE",
      needsIdempotencyKey: e.type === "GESTE", needsApproval: false, modelRole: null, wave: 0, spec,
      forEach: null, waitFor: null,
    };
    switch (e.type) {
      case "LECTURE":
        return { ...base, nodeType: "CAPABILITY", capability: `${PREFIXE.lecture}${e.outil}`, input: e.entree ?? {}, maxAttempts: 3 };
      case "GESTE":
        // DEUX tentatives : le reçu (`TravailEcriture`) rend la seconde sûre — un geste fait n'est jamais refait.
        return { ...base, nodeType: "CAPABILITY", capability: `${PREFIXE.geste}${e.outil}`, input: e.entree ?? {}, maxAttempts: 2 };
      case "LOTS":
        return {
          ...base, nodeType: "CAPABILITY", capability: PREFIXE.lots, maxAttempts: 1,
          input: { liste: `{{${e.lots!.etape}.${e.lots!.chemin}}}`, taille: e.lots!.taille ?? 25 },
        };
      case "ANALYSE": {
        const comme = e.pourChaque?.comme ?? "lot";
        return {
          ...base, nodeType: "WORKER", capability: null, maxAttempts: 2,
          input: { consigne: e.consigne ?? "", ...(e.entree ?? {}), ...(e.pourChaque ? { [comme]: `{{${comme}}}` } : {}) },
          forEach: e.pourChaque ? { from: e.pourChaque.etape, path: e.pourChaque.chemin ?? "lots", as: comme } : null,
        };
      }
      case "ATTENTE":
        return { ...base, nodeType: "WAIT_EVENT", capability: null, input: {}, maxAttempts: 1, waitFor: attenteDuMoteur(e.attente ?? {}, maintenant) as CompiledStep["waitFor"] };
      case "LIVRABLE":
        return { ...base, nodeType: "ARTIFACT", capability: null, input: { consigne: e.consigne ?? "", titre: e.titre, ...(e.entree ?? {}) }, maxAttempts: 2 };
    }
  }) as CompiledStep[];

  // La profondeur (pour le journal du moteur) : le plus long chemin de dépendances.
  const prof = new Map<string, number>();
  for (const s of steps) prof.set(s.key, 1 + Math.max(0, ...s.dependsOn.map((d) => prof.get(d) ?? 0)));
  for (const s of steps) s.wave = (prof.get(s.key) ?? 1) - 1;

  return {
    objective: plan.objectif,
    acceptance: ["Toutes les étapes du plan approuvé ont abouti, ou ont été écartées avec leur motif, et le livrable est au carnet."],
    complexity: "B",
    scale: steps.length > 15 ? "L" : "M",
    steps,
    maxEffect: steps.some((s) => s.effect === "INTERNAL_REVERSIBLE_WRITE") ? "INTERNAL_REVERSIBLE_WRITE" : "PREPARE",
    requiresApproval: false,
    capabilities: [...new Set(steps.map((s) => s.capability).filter((x): x is string => Boolean(x)))].sort(),
    depth: Math.max(1, ...prof.values()),
    gaps: [],
    planMeta: { workstreams: [], expectedArtifacts: [], approvalStrategy: "BUNDLE", completionCriteria: null },
  };
}

/** Découpe une liste en lots bornés — la capacité `travail:lots`, exécutée par le code. */
export function decouperEnLots(liste: unknown, tailleDemandee: unknown): { ok: true; lots: { id: string; numero: number; elements: unknown[] }[]; total: number } | { ok: false; erreur: string } {
  if (!Array.isArray(liste)) return { ok: false, erreur: "la liste à découper n'est pas une liste" };
  if (liste.length > BORNES_PLAN.elementsMax) return { ok: false, erreur: `${liste.length} éléments : au plus ${BORNES_PLAN.elementsMax} par travail` };
  const demandee = typeof tailleDemandee === "number" && Number.isFinite(tailleDemandee) ? Math.round(tailleDemandee) : 25;
  const taille = Math.max(
    BORNES_PLAN.tailleLotMin,
    Math.min(BORNES_PLAN.tailleLotMax, demandee),
    Math.ceil(liste.length / BORNES_PLAN.lotsMax),
  );
  const lots: { id: string; numero: number; elements: unknown[] }[] = [];
  for (let i = 0; i < liste.length; i += taille) {
    const numero = lots.length + 1;
    lots.push({ id: `lot-${String(numero).padStart(2, "0")}`, numero, elements: liste.slice(i, i + taille) });
  }
  return { ok: true, lots, total: liste.length };
}
