/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « CET ÉVÉNEMENT EST-IL CELUI QUE J'ATTENDAIS ? » — la question, isolée et pure.
 *
 * ── POURQUOI C'EST UN FICHIER SÉPARÉ ET SANS BASE ────────────────────────────────────────
 *
 * Parce que c'est la décision qui, prise de travers, réveille la mauvaise mission — et qu'une
 * mission réveillée à tort peut envoyer un e-mail. La règle doit donc être lisible d'un bloc et
 * testable au cas près, sans monter une base et un ledger pour vérifier qu'un nom ne correspond
 * pas à un autre.
 *
 * ── LA POSTURE : STRICTE PAR DÉFAUT ──────────────────────────────────────────────────────
 *
 * Une attente qui ne précise rien n'attrape RIEN. C'est l'inverse du réflexe habituel (« pas de
 * filtre = tout passe »), et c'est délibéré : une attente sans condition serait réveillée par le
 * premier fait venu, ce qui est exactement la panne qu'on ne veut pas.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { lireChemin } from "@/lib/missions/runtime/condition";

/** L'attente, telle que le plan l'a écrite. */
export interface Attente {
  /** Le type d'événement métier attendu. Sans lui (ni `until`), une branche n'attrape rien. */
  event?: string;
  /** De qui — identifiant d'acteur, adresse, ou nom présent dans la charge utile. */
  from?: string;
  /** L'entité concernée, en « TYPE:id ». */
  entity?: string;
  withinDays?: number;
  /**
   * RÉVEIL TEMPOREL (WAIT_FOR_TIME) — ISO 8601. La branche se règle quand CE MOMENT PASSE,
   * sans qu'aucun événement n'arrive. « Reviens demain à 10 h » est une attente comme une
   * autre : persistée, relue par le battement, jamais un `setTimeout` en mémoire.
   */
  until?: string;
  /**
   * E-MAIL : le FIL exact (threadId fournisseur). Toujours préféré aux heuristiques de texte
   * quand il existe — deux « Sarah » n'ont qu'un seul fil.
   */
  threadId?: string;
  /** E-mail : fragment d'OBJET, insensible à la casse (≥ 4 caractères, même règle que `from`). */
  subject?: string;
  /**
   * E-mail : une PIÈCE JOINTE est exigée — `true` (n'importe laquelle), ou un motif de nom de
   * fichier (« contrat », « *.pdf »). « Je te l'envoie demain » SANS pièce ne règle pas cette
   * attente : la condition demandait le document, pas une promesse.
   */
  attachment?: true | string;
  /**
   * LE PRÉDICAT SUR LA CHARGE UTILE (J2) — chaque champ nommé doit valoir exactement la valeur donnée
   * (texte comparé sans casse ni espaces de bord, nombre et booléen à l'identique ; chemin pointé admis :
   * « statut », « bc.etat »). « Quand le BC est SIGNÉ » : `{ event: "DOCUMENT_STATUT", entity: "BC:…",
   * payload: { statut: "SIGNE" } }` — un BC seulement « transmis » ne règle pas l'attente.
   */
  payload?: Record<string, string | number | boolean>;
  /** Composition OU : réglée dès qu'UNE branche l'est. */
  anyOf?: Attente[];
  /** Composition ET : réglée quand TOUTES les branches le sont (progression persistée). */
  allOf?: Attente[];
}

/** Le fait, tel que le registre l'a inscrit. Une VUE, pas le modèle Prisma. */
export interface FaitObserve {
  type: string;
  actorId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  relatedRefs?: readonly string[];
  payload?: unknown;
  missionId?: string | null;
}

export const norm = (s: string): string => s.trim().toLowerCase();

/**
 * « CE TEXTE DÉSIGNE-T-IL CETTE PERSONNE ? »
 *
 * Égalité exacte, ou inclusion à partir de quatre caractères. Le seuil n'est pas arbitraire :
 * en dessous, « ali » se retrouve dans « natalie@… » et l'on réveille la mauvaise personne.
 */
export function designe(attendu: string, candidats: readonly string[]): boolean {
  const a = norm(attendu);
  if (a === "") return false;
  if (candidats.includes(a)) return true;
  return a.length >= 4 && candidats.some((c) => c.includes(a));
}

/**
 * Les champs d'une charge utile susceptibles de porter l'émetteur. Explicites, pas devinés.
 * `fromName` et `systeme`/`source` (§37) : « la signature de Karim Mouffok » et « la signature
 * complète DocuSign » sont deux façons légitimes de nommer d'où vient un fait externe — mesuré au
 * banc : le planificateur écrit `from: "DocuSign"`, et un fait qui ne portait que l'adresse du
 * signataire ne réveillait pas la mission.
 */
const CHAMPS_EMETTEUR = ["from", "fromAddress", "senderEmail", "sender", "email", "personId", "employeeId", "userId", "fromName", "senderName", "systeme", "source"];

/**
 * LES ÉMETTEURS PLAUSIBLES D'UN FAIT — exporté, parce que les ENGAGEMENTS posent exactement la
 * même question (« ce fait vient-il de la personne qui avait promis ? ») et qu'une seconde
 * implémentation divergerait le jour où l'on ajoute un champ ici et pas là.
 */
export function emetteurs(fait: FaitObserve): string[] {
  const out: string[] = [];
  if (fait.actorId) out.push(fait.actorId);
  const p = fait.payload;
  if (p && typeof p === "object" && !Array.isArray(p)) {
    for (const champ of CHAMPS_EMETTEUR) {
      const v = (p as Record<string, unknown>)[champ];
      if (typeof v === "string" && v.trim() !== "") out.push(v);
    }
  }
  return out.map(norm);
}

/** Les entités touchées par un fait. Exporté pour la même raison que `emetteurs`. */
export function references(fait: FaitObserve): string[] {
  const out: string[] = [...(fait.relatedRefs ?? [])];
  if (fait.entityType && fait.entityId) out.push(`${fait.entityType}:${fait.entityId}`);
  return out.map(norm);
}

/**
 * LA CORRESPONDANCE.
 *
 * ── LE `from` EST LE POINT DÉLICAT ───────────────────────────────────────────────────────
 *
 * Une mission attend « la réponse de Redouane ». Le fait porte peut-être son identifiant ERP,
 * peut-être son adresse, peut-être les deux. On accepte donc l'égalité sur l'un quelconque des
 * émetteurs connus, et l'INCLUSION seulement quand l'attendu est assez long pour ne pas
 * ramasser n'importe qui : « ali » inclus dans « natalie@… » réveillerait une mission sur la
 * réponse de quelqu'un d'autre.
 */
/** Les champs d'une charge utile susceptibles de porter le FIL et l'OBJET d'un e-mail. */
const CHAMPS_FIL = ["threadId", "providerThreadId"];
const CHAMPS_OBJET = ["subject", "objet", "title"];
const CHAMPS_PIECES = ["attachments", "attachmentNames", "pieces"];

/** Les noms de pièces jointes portés par un fait — chaînes uniquement, jamais devinés. */
export function piecesJointes(fait: FaitObserve): string[] {
  const p = fait.payload;
  if (!p || typeof p !== "object" || Array.isArray(p)) return [];
  const o = p as Record<string, unknown>;
  for (const champ of CHAMPS_PIECES) {
    const v = o[champ];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string").map(norm);
  }
  return [];
}

/**
 * « CE NOM DE FICHIER RÉPOND-IL AU MOTIF ? » — inclusion insensible à la casse, `*` en joker.
 * Un motif vide n'attrape rien (même doctrine que le reste du fichier).
 */
export function pieceRepond(motif: string, noms: readonly string[]): boolean {
  const m = norm(motif);
  if (m === "") return false;
  const re = new RegExp(m.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*"), "i");
  return noms.some((n) => re.test(n));
}

/**
 * LA BRANCHE ÉLÉMENTAIRE face à UN FAIT. Une branche purement TEMPORELLE (`until` sans `event`)
 * n'est JAMAIS réglée par un fait — c'est le temps qui la règle (`echueTemporelle`), et
 * confondre les deux réveillerait « reviens demain » sur le premier e-mail venu.
 */
export function correspond(attente: Attente, fait: FaitObserve): boolean {
  // 1. LE TYPE EST OBLIGATOIRE. Une attente sans type n'attrape rien — voir l'en-tête.
  if (!attente.event || norm(attente.event) !== norm(fait.type)) return false;

  // 2. L'ÉMETTEUR, quand il est demandé.
  if (attente.from && !designe(attente.from, emetteurs(fait))) return false;

  // 3. L'ENTITÉ, quand elle est demandée.
  if (attente.entity) {
    if (!references(fait).includes(norm(attente.entity))) return false;
  }

  const charge = fait.payload && typeof fait.payload === "object" && !Array.isArray(fait.payload)
    ? (fait.payload as Record<string, unknown>) : {};
  const champTexte = (champs: readonly string[]): string | null => {
    for (const c of champs) {
      const v = charge[c];
      if (typeof v === "string" && v.trim() !== "") return v;
    }
    return null;
  };

  // 4. LE FIL — l'identifiant EXACT, jamais une inclusion : deux fils ne se ressemblent pas.
  if (attente.threadId) {
    const fil = champTexte(CHAMPS_FIL);
    if (!fil || norm(fil) !== norm(attente.threadId)) return false;
  }

  // 5. L'OBJET — inclusion ≥ 4 caractères, même seuil que `from` et pour la même raison.
  if (attente.subject) {
    const objet = champTexte(CHAMPS_OBJET);
    const attendu = norm(attente.subject);
    if (!objet || attendu.length < 4 || !norm(objet).includes(attendu)) return false;
  }

  // 6 bis. LE PRÉDICAT SUR LA CHARGE UTILE — chaque champ exigé, à l'identique. Un champ absent ne règle rien.
  if (attente.payload) {
    for (const [chemin, attendu] of Object.entries(attente.payload)) {
      const v = lireChemin(charge, chemin);
      if (typeof attendu === "string" ? typeof v !== "string" || norm(v) !== norm(attendu) : v !== attendu) return false;
    }
  }

  // 6. LA PIÈCE JOINTE — « je te l'envoie demain » SANS pièce ne règle pas l'attente (§26).
  if (attente.attachment !== undefined) {
    const noms = piecesJointes(fait);
    if (attente.attachment === true) {
      const declare = charge.hasAttachments === true;
      if (noms.length === 0 && !declare) return false;
    } else if (!pieceRepond(attente.attachment, noms)) {
      return false;
    }
  }

  return true;
}

/** La branche est-elle réglée par LE TEMPS ? Pure — l'horloge est un paramètre, jamais lue ici. */
export function echueTemporelle(attente: Attente, maintenant: Date): boolean {
  if (!attente.until) return false;
  const t = Date.parse(attente.until);
  return Number.isFinite(t) && maintenant.getTime() >= t;
}

/** Les branches élémentaires d'une attente, avec leur mode de composition. */
export function decomposer(a: Attente): { mode: "ANY" | "ALL"; branches: Attente[] } {
  if (a.allOf && a.allOf.length > 0) return { mode: "ALL", branches: a.allOf };
  if (a.anyOf && a.anyOf.length > 0) return { mode: "ANY", branches: a.anyOf };
  return { mode: "ANY", branches: [a] };
}

/**
 * L'ÉTAT D'UNE ATTENTE COMPOSÉE — la seule fonction que le routeur consulte.
 *
 * `dejaReglees` est la PROGRESSION PERSISTÉE (les indices de branches réglées par des faits
 * antérieurs) : une attente « le contrat ET le devis » qui a reçu le contrat hier ne le
 * redemande pas après un redémarrage — la mémoire est en base, jamais en process. Le calcul
 * est idempotent : rejouer le même fait rend le même état.
 */
export function etatAttente(
  attente: Attente,
  dejaReglees: readonly number[],
  fait: FaitObserve | null,
  maintenant: Date,
): { reglees: number[]; complete: boolean; nouvelles: number[] } {
  const { mode, branches } = decomposer(attente);
  const acquises = new Set(dejaReglees.filter((i) => Number.isInteger(i) && i >= 0 && i < branches.length));
  const nouvelles: number[] = [];
  for (const [i, b] of branches.entries()) {
    if (acquises.has(i)) continue;
    const regle = (fait !== null && correspond(b, fait)) || echueTemporelle(b, maintenant);
    if (regle) { acquises.add(i); nouvelles.push(i); }
  }
  const reglees = [...acquises].sort((a, b) => a - b);
  const complete = mode === "ANY" ? reglees.length > 0 : reglees.length === branches.length;
  return { reglees, complete, nouvelles };
}

/** La progression persistée d'une attente composée, relue depuis `step.result` sans confiance. */
export function lireProgres(v: unknown): number[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return [];
  const p = (v as Record<string, unknown>).attenteProgres;
  return Array.isArray(p) ? p.filter((x): x is number => Number.isInteger(x) && x >= 0) : [];
}

/**
 * L'ATTENTE EST-ELLE ÉCHUE ?
 *
 * Une échéance dépassée ne fait PAS échouer la mission : elle rend une relance PERTINENTE
 * (§87). Confondre les deux abandonnerait une mission au premier retard, alors qu'attendre
 * trois jours de plus une réponse est le comportement normal d'un être humain qui relance.
 */
export function echue(attente: Attente, depuis: Date, maintenant: Date): boolean {
  if (!attente.withinDays || attente.withinDays <= 0) return false;
  return maintenant.getTime() - depuis.getTime() > attente.withinDays * 24 * 3600 * 1000;
}

/**
 * Relit une attente venue de la base — retypée, jamais crue sur parole. Récursive pour les
 * compositions, PROFONDEUR 1 : une branche ne contient pas elle-même de branches — un plan qui
 * imbriquerait « (A ET B) OU C » se réécrit à plat, et attraper une forme qu'on comprend mal
 * est pire que ne rien attraper (doctrine du décodeur).
 */
export function lireAttente(v: unknown, profondeur = 0): Attente | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const s = (k: string): string | undefined =>
    typeof o[k] === "string" && (o[k] as string).trim() !== "" ? (o[k] as string).trim() : undefined;
  const n = typeof o.withinDays === "number" && o.withinDays > 0 ? o.withinDays : undefined;
  const piece: true | string | undefined =
    o.attachment === true ? true : s("attachment");
  const branches = (k: "anyOf" | "allOf"): Attente[] | undefined => {
    if (profondeur > 0 || !Array.isArray(o[k])) return undefined;
    const lues = (o[k] as unknown[]).map((b) => lireAttente(b, profondeur + 1))
      .filter((b): b is Attente => b !== null);
    return lues.length > 0 ? lues : undefined;
  };
  const charge = o.payload && typeof o.payload === "object" && !Array.isArray(o.payload)
    ? Object.fromEntries(Object.entries(o.payload as Record<string, unknown>)
      .filter((e): e is [string, string | number | boolean] => ["string", "number", "boolean"].includes(typeof e[1]) && e[0].trim() !== ""))
    : {};
  const a: Attente = {
    event: s("event"), from: s("from"), entity: s("entity"), withinDays: n,
    until: s("until"), threadId: s("threadId"), subject: s("subject"), attachment: piece,
    ...(Object.keys(charge).length ? { payload: charge } : {}),
    anyOf: branches("anyOf"), allOf: branches("allOf"),
  };
  const feuilleValide = Boolean(a.event || a.until || a.from || a.entity);
  return feuilleValide || a.anyOf || a.allOf ? a : null;
}
