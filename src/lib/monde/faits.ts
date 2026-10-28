/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MODÈLE DU MONDE (mandat 6 §45) — pur, et ce n'est PAS une base de données de plus.
 *
 * ── CE QUE CE MODULE N'EST PAS ──────────────────────────────────────────────────────────
 *
 * Il ne stocke rien. La tentation évidente, en lisant « représentation structurée et durable de
 * l'entreprise », est de créer une table de faits que quelqu'un devrait tenir à jour. Elle
 * divergerait de l'ERP en trois semaines, et à la première divergence personne ne saurait
 * laquelle croire — l'ERP, qui sert à travailler, ou le modèle, qui sert à répondre.
 *
 * ── CE QU'IL EST : UNE LECTURE, ET UNE LECTURE QUI MANQUAIT ─────────────────────────────
 *
 * L'histoire de l'entreprise est DÉJÀ écrite, elle n'était simplement pas lue comme une
 * histoire : `AuditLog` note chaque changement de champ, `BusinessEvent` chaque fait métier,
 * `EntityLink` chaque relation déclarée. Ce module transforme ces trois journaux en FAITS
 * DATÉS — sujet, prédicat, objet, période de validité — et rend enfin possibles les deux
 * questions du mandat :
 *
 *   « Qui était responsable au moment de cette décision ? »   → `auMoment`
 *   « Qu'est-ce qui a changé depuis mars ? »                  → `changements`
 *
 * ── L'HONNÊTETÉ DE COUVERTURE EST UNE PROPRIÉTÉ, PAS UNE NOTE DE BAS DE PAGE ────────────
 *
 * Le journal ne contient que ce qui a été TRACÉ. Un champ jamais journalisé n'a pas d'histoire —
 * et le modèle doit répondre « je ne sais pas ce qu'il valait avant », jamais « il valait ce
 * qu'il vaut aujourd'hui ». Chaque réponse porte donc sa `couverture` : ce sur quoi elle
 * s'appuie, et ce qu'elle ne peut pas voir. Un modèle du monde qui compléterait les trous par
 * l'état actuel serait pire qu'aucun modèle : il aurait l'air de savoir.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { contient, dureeJours, direIntervalle, type Intervalle } from "@/lib/monde/temps";

/**
 * UN FAIT DATÉ. Le prédicat est une chaîne et non un énuméré, pour la même raison que
 * `BusinessEvent.type` : un domaine doit pouvoir nommer un fait sans migration.
 */
export interface Fait extends Intervalle {
  /** « EMPLOYEE:abc », « REGULATORY_PRODUCT:xyz » — type et identifiant, comme partout ailleurs. */
  sujet: string;
  sujetLibelle: string;
  /** « responsable », « statut », « prix », « budget », « rattache_a »… */
  predicat: string;
  /** La valeur, en clair. Toujours du texte : un modèle du monde n'est pas un schéma. */
  objet: string;
  /**
   * QUAND NOUS L'AVONS SU — distinct de `depuis`, qui dit quand c'était vrai.
   *
   * Une passation saisie trois semaines plus tard a `depuis` au 1er juillet et `constateLe` au
   * 21. « Qui était responsable le 5 juillet ? » lit le premier ; « le savait-on le 5 ? » lit le
   * second, et la réponse est non.
   */
  constateLe: Date;
  /** D'où le fait vient : `AuditLog#id`, `BusinessEvent#id`, `ERP:Employee.position`. */
  source: string;
  /** Qui a produit le changement, quand le journal le dit. */
  acteur: string | null;
  /**
   * D'OÙ VIENT L'HISTOIRE — et c'est ce qui décide si le fait vaut pour le PASSÉ.
   *
   * `JOURNALISEE` : le fait vient d'un changement daté (journal d'audit, événement métier). Il
   * vaut sur toute sa période, passé compris.
   *
   * `COURANTE` : le fait n'est qu'un relevé de la valeur ACTUELLE, pour un champ que rien ne
   * journalise. On sait qu'elle est vraie aujourd'hui ; on ignore depuis quand. Interrogé sur une
   * date antérieure à ce relevé, le modèle répond INCONNU — jamais « c'était déjà ça ». Sans
   * cette distinction, tout champ non journalisé serait rétro-projeté dans le passé avec
   * l'assurance d'un constat, et l'audit rétrospectif deviendrait faux en ayant l'air juste.
   */
  histoire?: "JOURNALISEE" | "COURANTE";
  /**
   * 1 = constaté dans un journal ; en dessous, DÉDUIT. Un fait déduit reste utilisable, mais il
   * ne se présente jamais comme un constat (§118.9 : TROUVÉ / DÉDUIT / CANDIDAT / INCONNU).
   */
  confiance: number;
}

/**
 * CE QUE LA RÉPONSE S'EST APPUYÉE DESSUS — et ce qu'elle n'a pas pu voir.
 *
 * Ce n'est pas de la modestie : sans elle, « aucun responsable trouvé à cette date » et
 * « ce champ n'est pas journalisé » sont la même phrase, et la première fait conclure à tort.
 */
export interface Couverture {
  /** Les prédicats pour lesquels une histoire existe réellement. */
  journalises: string[];
  /** Les prédicats connus SEULEMENT par leur valeur actuelle — aucune histoire disponible. */
  sansHistoire: string[];
  /** Le plus ancien fait connu : avant cette date, le modèle ne sait rien. */
  depuis: Date | null;
  faits: number;
}

/** Les faits vrais à un instant donné. */
export function valideA(faits: readonly Fait[], quand: Date): Fait[] {
  return faits.filter((f) => contient(f, quand) && !avantLeReleve(f, quand));
}

/**
 * CE QU'ON SAVAIT À CET INSTANT — le temps de CONSTAT, pas le temps de validité.
 *
 * La différence n'est pas théorique : elle décide si l'on peut reprocher une décision. Un
 * dirigeant qui a tranché le 5 juillet sur la foi d'un responsable périmé n'a pas mal décidé si
 * la passation n'a été saisie que le 21.
 */
export function connuA(faits: readonly Fait[], quand: Date): Fait[] {
  return faits.filter((f) => f.constateLe.getTime() <= quand.getTime() && contient(f, quand));
}

/** L'histoire d'une propriété, du plus ancien au plus récent. */
export function historique(faits: readonly Fait[], sujet: string, predicat: string): Fait[] {
  return faits
    .filter((f) => f.sujet === sujet && f.predicat === predicat)
    .sort((a, b) => (a.depuis?.getTime() ?? -Infinity) - (b.depuis?.getTime() ?? -Infinity));
}

/**
 * QUI / QUOI, À CET INSTANT — la réponse à « qui était responsable quand cette décision a été
 * prise ? ». Rend `null` plutôt que la valeur actuelle : ne pas savoir est une réponse.
 */
export function auMoment(faits: readonly Fait[], sujet: string, predicat: string, quand: Date): Fait | null {
  return historique(faits, sujet, predicat).find((f) => contient(f, quand) && !avantLeReleve(f, quand)) ?? null;
}

/** Un relevé de valeur COURANTE ne dit rien d'une date antérieure au relevé lui-même. */
const avantLeReleve = (f: Fait, quand: Date): boolean =>
  f.histoire === "COURANTE" && quand.getTime() < f.constateLe.getTime();

export interface Changement {
  sujet: string;
  sujetLibelle: string;
  predicat: string;
  /** Ce que c'était avant la période observée — `null` quand on ne le sait pas. */
  avant: string | null;
  apres: string;
  quand: Date;
  acteur: string | null;
  source: string;
  /** Depuis combien de jours ce nouvel état tient. */
  depuisJours: number | null;
}

/**
 * CE QUI A CHANGÉ DANS UNE PÉRIODE — la réponse à « qu'est-ce qui a changé depuis mars ? ».
 *
 * Un changement est un fait dont la validité COMMENCE dans la fenêtre. On y attache la valeur
 * précédente en remontant l'histoire du même couple sujet/prédicat : « le statut est passé de
 * DÉPOSÉ à INSTRUIT » se lit d'un coup d'œil, là où deux faits séparés demandent de les
 * rapprocher soi-même.
 */
export function changements(faits: readonly Fait[], depuis: Date, jusqua?: Date): Changement[] {
  const fin = jusqua?.getTime() ?? Infinity;
  const debut = depuis.getTime();
  const out: Changement[] = [];
  for (const f of faits) {
    const d = f.depuis?.getTime();
    if (d === undefined || d < debut || d > fin) continue;
    const avant = historique(faits, f.sujet, f.predicat)
      .filter((x) => (x.jusqua?.getTime() ?? Infinity) <= d)
      .pop();
    out.push({
      sujet: f.sujet, sujetLibelle: f.sujetLibelle, predicat: f.predicat,
      avant: avant?.objet ?? null, apres: f.objet, quand: f.depuis!,
      acteur: f.acteur, source: f.source,
      depuisJours: dureeJours({ depuis: f.depuis, jusqua: f.jusqua }, jusqua ?? new Date()),
    });
  }
  return out.sort((a, b) => b.quand.getTime() - a.quand.getTime());
}

export interface Contradiction {
  sujet: string;
  predicat: string;
  /** Les faits qui se disputent la même période. */
  faits: Fait[];
  periode: string;
  /** Ce que le code recommande — jamais un choix arbitraire (§46 le traitera à fond). */
  suite: string;
}

/**
 * DEUX VALEURS POUR LA MÊME PROPRIÉTÉ AU MÊME MOMENT.
 *
 * Ce n'est une contradiction que pour les prédicats FONCTIONNELS — ceux qui n'admettent qu'une
 * valeur à la fois (un statut, un prix, un responsable). « Rattaché à » en admet plusieurs, et
 * les signaler serait du bruit. L'appelant fournit donc la liste ; le module ne la devine pas,
 * parce que deviner ici produirait des alertes fausses en masse.
 */
export function contradictions(faits: readonly Fait[], fonctionnels: ReadonlySet<string>): Contradiction[] {
  const parCle = new Map<string, Fait[]>();
  for (const f of faits) {
    if (!fonctionnels.has(f.predicat)) continue;
    const cle = `${f.sujet}|${f.predicat}`;
    (parCle.get(cle) ?? parCle.set(cle, []).get(cle)!).push(f);
  }
  const out: Contradiction[] = [];
  for (const [cle, liste] of parCle) {
    if (liste.length < 2) continue;
    const tri = [...liste].sort((a, b) => (a.depuis?.getTime() ?? -Infinity) - (b.depuis?.getTime() ?? -Infinity));
    for (let i = 1; i < tri.length; i += 1) {
      const a = tri[i - 1]!; const b = tri[i]!;
      const finA = a.jusqua?.getTime() ?? Infinity;
      const debutB = b.depuis?.getTime() ?? -Infinity;
      if (finA <= debutB) continue;
      if (a.objet === b.objet) continue;
      const [sujet, predicat] = cle.split("|") as [string, string];
      out.push({
        sujet, predicat, faits: [a, b],
        periode: direIntervalle({ depuis: b.depuis, jusqua: a.jusqua }),
        // La plus RÉCEMMENT constatée l'emporte d'ordinaire — mais c'est une recommandation,
        // pas une résolution : le moteur de contradictions (§46) tranchera sur la fraîcheur,
        // l'autorité de la source et la provenance, pas sur un seul critère.
        suite: a.constateLe.getTime() >= b.constateLe.getTime()
          ? `deux valeurs se recouvrent : « ${a.objet} » a été constatée en dernier (${a.constateLe.toISOString().slice(0, 10)})`
          : `deux valeurs se recouvrent : « ${b.objet} » a été constatée en dernier (${b.constateLe.toISOString().slice(0, 10)})`,
      });
    }
  }
  return out;
}

/** L'état complet d'un sujet à une date : une valeur par prédicat, plus ce qui manque. */
export function etatA(faits: readonly Fait[], sujet: string, quand: Date): { valeurs: Record<string, string>; sources: Record<string, string>; inconnus: string[] } {
  const valeurs: Record<string, string> = {};
  const sources: Record<string, string> = {};
  const predicats = new Set(faits.filter((f) => f.sujet === sujet).map((f) => f.predicat));
  const inconnus: string[] = [];
  for (const p of predicats) {
    const f = auMoment(faits, sujet, p, quand);
    // AUCUNE VALEUR À CETTE DATE ≠ la valeur d'aujourd'hui. Le prédicat est listé comme INCONNU,
    // ce qui laisse la réponse honnête au lieu de la rendre complète et fausse.
    if (!f) { inconnus.push(p); continue; }
    valeurs[p] = f.objet;
    sources[p] = f.source;
  }
  return { valeurs, sources, inconnus };
}

/** La couverture d'un ensemble de faits — ce qui a une histoire et ce qui n'en a pas. */
export function couverture(faits: readonly Fait[]): Couverture {
  const parPredicat = new Map<string, number>();
  for (const f of faits) parPredicat.set(f.predicat, (parPredicat.get(f.predicat) ?? 0) + 1);
  const dates = faits.map((f) => f.depuis?.getTime()).filter((x): x is number => typeof x === "number");
  // « Sans histoire » se lit d'abord sur le MARQUEUR, puis, à défaut, sur le fait qu'un prédicat
  // n'ait qu'une seule valeur connue — un fait journalisé une seule fois n'a pas plus d'histoire.
  const courants = new Set(faits.filter((f) => f.histoire === "COURANTE").map((f) => f.predicat));
  return {
    journalises: [...parPredicat.entries()].filter(([p, n]) => n > 1 && !courants.has(p)).map(([p]) => p).sort(),
    sansHistoire: [...parPredicat.entries()].filter(([p, n]) => n === 1 || courants.has(p)).map(([p]) => p).sort(),
    depuis: dates.length ? new Date(Math.min(...dates)) : null,
    faits: faits.length,
  };
}

/** Une chronologie lisible d'un sujet — l'histoire racontée dans l'ordre. */
export function chronologie(faits: readonly Fait[], sujet: string): { quand: Date; texte: string; source: string }[] {
  return faits
    .filter((f) => f.sujet === sujet && f.depuis)
    .sort((a, b) => a.depuis!.getTime() - b.depuis!.getTime())
    .map((f) => ({
      quand: f.depuis!,
      texte: `${f.predicat} : ${f.objet}${f.acteur ? ` (${f.acteur})` : ""} — ${direIntervalle(f)}`,
      source: f.source,
    }));
}
