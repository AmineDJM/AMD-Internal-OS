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
 *   DEMANDE   « demander à » une personne : question, pièces attendues, échéance (J8)  → WAIT_INPUT
 *   LIVRABLE  le document final, rédigé depuis le carnet, déposé au Drive (J8)        → ARTIFACT
 *
 * J8 (décision 0023) : une ATTENTE et une DEMANDE portent leurs JALONS — une relance, une escalade (au
 * responsable hiérarchique), et pour la demande un abandon ; le travail a une PRIORITÉ ; le livrable un FORMAT.
 *
 * Une étape peut être CONDITIONNELLE (`si` : « relance SEULEMENT si l'attente s'est réglée par le
 * temps ») et une ANALYSE peut se DÉMULTIPLIER (`pourChaque` : une analyse par lot).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const PERSONAS_TRAVAIL = ["ADAM", "ASSISTANT_IA"] as const;
export type PersonaTravail = (typeof PERSONAS_TRAVAIL)[number];

export const TYPES_ETAPE = ["LECTURE", "ANALYSE", "LOTS", "GESTE", "ATTENTE", "DEMANDE", "LIVRABLE"] as const;
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

/** Un délai relatif, posé en date absolue à l'approbation. */
export interface DelaiTravail { jours?: number; minutes?: number }

/** À qui va une escalade : la personne du travail, ou son responsable hiérarchique (N+1). */
export const VERS_ESCALADE = ["PRINCIPAL", "RESPONSABLE"] as const;
export type VersEscalade = (typeof VERS_ESCALADE)[number];

/** Les priorités d'un travail — le battement sert les hautes d'abord, chaque personne à son tour. */
export const PRIORITES = { HAUTE: 10, NORMALE: 0, BASSE: -10 } as const;
export type PrioriteTravail = keyof typeof PRIORITES;
export const prioriteDe = (n: number | null | undefined): PrioriteTravail => ((n ?? 0) > 0 ? "HAUTE" : (n ?? 0) < 0 ? "BASSE" : "NORMALE");

/** Les formats d'un livrable : un VRAI document déposé au Drive de la personne (Markdown = carnet seulement). */
export const FORMATS_LIVRABLE = ["docx", "pdf", "xlsx", "md"] as const;
export type FormatLivrable = (typeof FORMATS_LIVRABLE)[number];

/**
 * « DEMANDER À » (J8) — une demande structurée déposée dans l'espace d'une autre personne. Elle ne voit QUE
 * `question`, `pieces` (ce qu'on attend d'elle) et les pièces `partager` (Drive de la personne du travail) —
 * jamais le carnet. Le travail attend sa réponse ; `relance` (défaut : à mi-délai), `escalade` (défaut : à
 * l'échéance, à son responsable), `abandon` (défaut : un second délai après l'échéance → issue TIMEOUT).
 */
export interface DemandeTravail {
  /** La personne sollicitée : identifiant, e-mail ou nom exact (résolu à la proposition). */
  a: string;
  /** Son nom, posé à la proposition (la carte et le panneau le montrent). */
  aNom?: string;
  question: string;
  pieces?: string[];
  /** Des pièces du Drive de la personne du travail (identifiants), partagées en LECTURE avec la personne sollicitée. */
  partager?: string[];
  /** L'échéance de la réponse. */
  jours?: number;
  minutes?: number;
  relance?: DelaiTravail;
  escalade?: DelaiTravail;
  abandon?: DelaiTravail;
}

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
  /** J8 : une relance (notification) après ce délai si rien n'est arrivé. */
  relance?: DelaiTravail;
  /** J8 : une escalade après ce délai — à la personne du travail ou à son responsable (`a`). */
  escalade?: DelaiTravail & { a?: VersEscalade };
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
  /** DEMANDE (J8) : à qui, quoi, pour quand. */
  demande?: DemandeTravail;
  /** LIVRABLE (J8) : le format du document déposé au Drive (défaut : Word). */
  format?: FormatLivrable;
  /** Ne part que si l'étape `etape` s'est terminée ainsi (ex. relance : `{ etape: "attente-bc", issue: "TIMEOUT" }`). */
  si?: { etape: string; issue: IssueSi };
}

export interface PlanTravail {
  titre: string;
  objectif: string;
  /** J8 : la priorité du travail parmi ceux de la personne (défaut : NORMALE). */
  priorite?: PrioriteTravail;
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
const positif = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
const enJours = (d: DelaiTravail | undefined): number => (d?.jours ?? 0) + (d?.minutes ?? 0) / 1440;
/** Un délai `{ jours, minutes }` lu du modèle — `undefined` s'il ne dit rien. */
function lireDelai(v: unknown): DelaiTravail | undefined {
  const o = obj(v);
  if (!o) return undefined;
  const jours = positif(o.jours);
  const minutes = positif(o.minutes);
  return jours || minutes ? { ...(jours ? { jours } : {}), ...(minutes ? { minutes } : {}) } : undefined;
}
const listeDeTextes = (v: unknown, max: number, long = 200): string[] =>
  (Array.isArray(v) ? v : []).map((x) => txt(x, long)).filter(Boolean).slice(0, max);

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
  const prioriteBrute = txt(o.priorite, 10).toUpperCase();
  const priorite = prioriteBrute in PRIORITES ? (prioriteBrute as PrioriteTravail) : undefined;
  if (prioriteBrute && !priorite) fautes.push(`Priorité « ${prioriteBrute} » inconnue (${Object.keys(PRIORITES).join(", ")}).`);
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
        if (type === "LIVRABLE") {
          const format = (txt(e.format, 8).toLowerCase() || "docx") as FormatLivrable;
          if (!(FORMATS_LIVRABLE as readonly string[]).includes(format)) fautes.push(`${nom} : format « ${format} » inconnu (${FORMATS_LIVRABLE.join(", ")}).`);
          etape.format = format;
        }
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
        const relance = lireDelai(a.relance);
        const escalade = lireDelai(a.escalade);
        const vers = txt(obj(a.escalade)?.a, 20).toUpperCase();
        if (vers && !(VERS_ESCALADE as readonly string[]).includes(vers)) fautes.push(`${nom} : « escalade.a » doit valoir ${VERS_ESCALADE.join(" ou ")}.`);
        for (const [n, d] of [["relance", relance], ["escalade", escalade]] as const) {
          if (d && enJours(d) > BORNES_PLAN.joursMax) fautes.push(`${nom} : « ${n} » au plus ${BORNES_PLAN.joursMax} jours.`);
        }
        etape.attente = {
          ...(evenement ? { evenement } : {}),
          ...(txt(a.entite, 120) ? { entite: txt(a.entite, 120) } : {}),
          ...(champs ? { champs: Object.fromEntries(Object.entries(champs).filter((x): x is [string, string | number | boolean] => ["string", "number", "boolean"].includes(typeof x[1]))) } : {}),
          ...(jours ? { jours } : {}),
          ...(minutes ? { minutes } : {}),
          ...(relance ? { relance } : {}),
          ...(escalade ? { escalade: { ...escalade, ...(vers === "RESPONSABLE" ? { a: "RESPONSABLE" as const } : {}) } } : {}),
        };
        break;
      }
      case "DEMANDE": {
        const d = obj(e.demande) ?? {};
        const a = txt(d.a, 160);
        const question = txt(d.question, 2000);
        const jours = positif(d.jours);
        const minutes = positif(d.minutes);
        if (!a) fautes.push(`${nom} : « demande.a » — la personne à qui demander — manquante.`);
        if (!question) fautes.push(`${nom} : « demande.question » manquante (ce qu'on lui demande, en une ou deux phrases).`);
        if (!jours && !minutes) fautes.push(`${nom} : une demande exige une échéance (« demande.jours » ou « demande.minutes »).`);
        const delais = { relance: lireDelai(d.relance), escalade: lireDelai(d.escalade), abandon: lireDelai(d.abandon) };
        const total = (jours ?? 0) + (minutes ?? 0) / 1440 + enJours(delais.abandon ?? { jours, minutes });
        if (total > BORNES_PLAN.joursMax) fautes.push(`${nom} : une demande (échéance et abandon compris) dure au plus ${BORNES_PLAN.joursMax} jours.`);
        const partager = listeDeTextes(d.partager, 10, 40);
        etape.demande = {
          a, question,
          ...(listeDeTextes(d.pieces, 10).length ? { pieces: listeDeTextes(d.pieces, 10) } : {}),
          ...(partager.length ? { partager } : {}),
          ...(txt(d.aNom, 160) ? { aNom: txt(d.aNom, 160) } : {}),
          ...(jours ? { jours } : {}),
          ...(minutes ? { minutes } : {}),
          ...Object.fromEntries(Object.entries(delais).filter(([, v]) => v)),
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
  return { ok: true, plan: { titre, objectif, ...(priorite ? { priorite } : {}), etapes }, gestes };
}

const EFFET: Record<TypeEtape, Effect> = {
  LECTURE: "READ", ANALYSE: "ANALYZE", LOTS: "ANALYZE", GESTE: "INTERNAL_REVERSIBLE_WRITE", ATTENTE: "READ", DEMANDE: "PREPARE", LIVRABLE: "PREPARE",
};

const JOUR_MS = 86_400_000;
const dateApres = (base: Date, d: DelaiTravail | undefined): string | null =>
  d && enJours(d) > 0 ? new Date(base.getTime() + enJours(d) * JOUR_MS).toISOString() : null;

/** Les JALONS d'une attente (J8), en dates absolues posées à l'approbation — le balayage les lit (`jalons.ts`). */
export interface JalonsAttente {
  relanceA: string | null;
  escaladeA: string | null;
  escaladeVers: VersEscalade;
}

export function jalonsAttente(a: AttenteTravail, maintenant: Date): JalonsAttente | null {
  const relanceA = dateApres(maintenant, a.relance);
  const escaladeA = dateApres(maintenant, a.escalade);
  return relanceA || escaladeA ? { relanceA, escaladeA, escaladeVers: a.escalade?.a ?? "PRINCIPAL" } : null;
}

/**
 * LA DEMANDE COMPILÉE — ce que l'étape porte et ce que le dépôt (`delegation.ts`) lit. Les délais sont RELATIFS AU
 * DÉPÔT (« réponse sous 4 jours » compte du jour où l'on demande, pas de l'approbation du plan) ; le dépôt les pose
 * en dates absolues sur la demande, une fois — un redémarrage ne les décale pas.
 */
export interface DemandeCompilee {
  destinataireId: string;
  destinataireNom: string;
  question: string;
  pieces: string[];
  partager: string[];
  /** En minutes après le dépôt. */
  echeanceMin: number;
  relanceMin: number | null;
  escaladeMin: number;
  abandonMin: number;
}

/**
 * Les défauts d'une demande, dits une fois : relance à MI-DÉLAI (pour un délai d'au moins une heure),
 * escalade à l'ÉCHÉANCE (au responsable de la personne sollicitée), abandon un SECOND délai plus tard.
 */
export function demandeCompilee(d: DemandeTravail): DemandeCompilee {
  const min = (x: DelaiTravail | undefined) => Math.round(enJours(x) * 1440);
  const echeanceMin = Math.max(1, (d.jours ?? 0) * 1440 + (d.minutes ?? 0));
  return {
    destinataireId: d.a,
    destinataireNom: d.aNom ?? d.a,
    question: d.question,
    pieces: d.pieces ?? [],
    partager: d.partager ?? [],
    echeanceMin,
    relanceMin: d.relance ? min(d.relance) : echeanceMin >= 60 ? Math.round(echeanceMin / 2) : null,
    escaladeMin: d.escalade ? min(d.escalade) : echeanceMin,
    abandonMin: echeanceMin + (d.abandon ? min(d.abandon) : echeanceMin),
  };
}

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
        ...(e.type === "LIVRABLE" ? { artifactTitle: e.titre, artifactFormat: e.format ?? "docx" } : {}),
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
      case "ATTENTE": {
        const jalons = jalonsAttente(e.attente ?? {}, maintenant);
        return { ...base, nodeType: "WAIT_EVENT", capability: null, input: jalons ? { jalons } : {}, maxAttempts: 1, waitFor: attenteDuMoteur(e.attente ?? {}, maintenant) as CompiledStep["waitFor"] };
      }
      case "DEMANDE":
        // DEUX tentatives : le dépôt est idempotent (une demande par étape, clé unique en base).
        return { ...base, nodeType: "WAIT_INPUT", capability: null, input: { demande: demandeCompilee(e.demande!) }, maxAttempts: 2, waitFor: { ask: e.demande!.question } as CompiledStep["waitFor"] };
      case "LIVRABLE":
        return { ...base, nodeType: "ARTIFACT", capability: null, input: { consigne: e.consigne ?? "", titre: e.titre, format: e.format ?? "docx", ...(e.entree ?? {}) }, maxAttempts: 2 };
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
