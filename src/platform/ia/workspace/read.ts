import {
  WORKSPACE_LIMITS,
  type WorkspaceAction, type WorkspaceActionIcon, type WorkspaceColumn, type WorkspaceDoc,
  type WorkspaceEndpoint, type WorkspaceField, type WorkspaceMetric, type WorkspacePerson,
  type WorkspaceRow, type WorkspaceActionIntent,
} from "./protocol";
import { directIntent, intentArgs } from "./direct-intents";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LIRE UNE SORTIE D'OUTIL SANS JAMAIS LUI FAIRE CONFIANCE.
 *
 * Ce module ne contient que des relecteurs : des fonctions PURES qui prennent du JSON qu'on n'a
 * pas écrit et rendent une valeur typée du protocole, ou `null`. Il ne connaît aucun outil,
 * aucun bloc, aucune base — uniquement la forme d'un champ.
 *
 * ── POURQUOI IL EXISTE À PART ─────────────────────────────────────────────────────────────
 *
 * Ces relecteurs étaient dans `compose.ts`. Les blocs riches (story, vue 360, comparaison,
 * mission) ont besoin des MÊMES — et les mettre dans un second fichier qui importerait
 * `compose.ts` aurait créé un cycle, puisque `compose.ts` doit à son tour appeler ces blocs.
 *
 * Les DUPLIQUER aurait été pire : deux copies de `isInternalHref` divergent le jour où l'une
 * accepte `//evil.com` et pas l'autre. Une seule définition de la règle de sûreté, donc.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type Json = Record<string, unknown>;

export const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Une chaîne non vide, ou `null`. Les `undefined`, nombres et objets ne passent pas. */
export function s(v: unknown): string | null {
  if (typeof v === "string") { const t = v.trim(); return t.length > 0 ? t : null; }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

export function clip(v: string | null, max: number): string | null {
  if (!v) return null;
  return v.length <= max ? v : `${v.slice(0, max - 1).trimEnd()}…`;
}

/** Une liste de chaînes, bornée — les tableaux hétérogènes sont ignorés silencieusement. */
export function strings(v: unknown, max: number): string[] {
  return arr(v).map(s).filter((x): x is string => x !== null).slice(0, max);
}

export function endpointsOf(v: unknown): WorkspaceEndpoint[] {
  const out: WorkspaceEndpoint[] = [];
  for (const e of arr(v)) {
    if (!isObj(e)) continue;
    const valeur = s(e.valeur) ?? s(e.adresse) ?? s(e.value);
    if (!valeur) continue;
    const canalRaw = s(e.canal);
    const canal: WorkspaceEndpoint["canal"] =
      canalRaw === "téléphone" ? "téléphone" : canalRaw === "WhatsApp" ? "WhatsApp" : "e-mail";
    out.push({
      canal, valeur,
      usage: s(e.usage),
      fiabilite: s(e.fiabilite),
      ...(e.principale === true ? { principale: true } : {}),
    });
  }
  return out;
}


/**
 * LES GESTES D'UNE LIGNE — traduits, et VÉRIFIÉS.
 *
 * La phrase vient du serveur, mais elle traverse une sortie d'outil : on la relit comme tout le
 * reste de ce fichier. Une action sans libellé ou sans phrase ne s'affiche pas — un bouton muet,
 * ou un bouton qui n'envoie rien, sont deux façons de trahir la confiance qu'on lui accorde.
 */
export const EDIT_TYPES = new Set(["texte", "choix", "date", "nombre"]);

/**
 * UN CHAMP MODIFIABLE, RELU COMME TOUT LE RESTE.
 *
 * La règle qui compte : `phrase` DOIT contenir `%s`. Sans lui, la valeur saisie n'irait nulle
 * part et le bouton enverrait une phrase figée — c'est-à-dire modifierait autre chose que ce
 * que l'utilisateur croit. On écarte alors l'édition et le champ reste en lecture seule, ce
 * qui est le repli sûr.
 */
export function readEditable(v: unknown): WorkspaceField["editable"] | null {
  if (!isObj(v)) return null;
  const phrase = s(v.phrase);
  const type = s(v.type);
  if (!phrase || !phrase.includes("%s") || !type || !EDIT_TYPES.has(type)) return null;
  const options = strings(v.options, 24);
  return {
    phrase,
    type: type as "texte" | "choix" | "date" | "nombre",
    ...(options.length ? { options } : {}),
    ...(s(v.aide) ? { aide: clip(s(v.aide), 60) } : {}),
  };
}

/**
 * L'INTENTION D'UN BOUTON, RELUE CONTRE LE REGISTRE FERMÉ (§23).
 *
 * C'est le point de sûreté du raccourci : une capacité inconnue ne devient PAS un bouton
 * inerte qu'on découvrirait au clic — elle disparaît ici, et le geste retombe sur sa phrase,
 * qui marche. Les arguments sont filtrés à ceux que la capacité déclare : un argument surprise
 * ferait faire à l'outil autre chose que ce que le libellé promet.
 */
function readIntent(v: unknown): WorkspaceActionIntent | null {
  if (!isObj(v)) return null;
  const capability = s(v.capability);
  if (!capability) return null;
  const def = directIntent(capability);
  if (!def) return null;
  const args = intentArgs(def, isObj(v.args) ? v.args : {});
  if (Object.keys(args).length === 0) return null;
  return { capability, args };
}

export const ACTION_ICONS = new Set<string>([
  "voir", "email", "tache", "modifier", "apercu", "envoyer", "escalade", "planifier", "relancer", "valider",
]);

export function actionsOf(v: unknown, max: number = WORKSPACE_LIMITS.itemActions): WorkspaceAction[] {
  const out: WorkspaceAction[] = [];
  for (const a of arr(v)) {
    if (!isObj(a)) continue;
    const libelle = clip(s(a.libelle) ?? s(a.label), 24);
    const phrase = s(a.phrase) ?? s(a.prompt);
    if (!libelle || !phrase) continue;
    const ton = s(a.ton);
    // Le pictogramme vient d'un vocabulaire FERMÉ : un mot inconnu ne devient pas une icône au
    // hasard, il disparaît — et le bouton reste un bouton texte, parfaitement lisible.
    const icone = s(a.icone);
    out.push({
      libelle, phrase,
      ...(ton === "danger" || ton === "primaire" ? { ton } : {}),
      ...(icone && ACTION_ICONS.has(icone) ? { icone: icone as WorkspaceActionIcon } : {}),
      ...(readIntent(a.intent) ? { intent: readIntent(a.intent) as WorkspaceActionIntent } : {}),
    });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * LES ACCENTS QUE LES CLÉS N'ONT PAS.
 *
 * Les clés JSON des outils sont écrites sans accent (`dateDepot`, `priorite`, `entite`) parce
 * qu'une clé accentuée est une source d'ennuis. Mais « Date depot » et « Priorite » affichés au
 * PDG, dans une interface qui se veut soignée, sont des fautes d'orthographe.
 *
 * Une courte table couvre les clés RÉELLEMENT rencontrées dans l'ERP. Elle n'a pas vocation à
 * être exhaustive : ce qui n'y est pas passe par la règle générale, qui reste correcte.
 */
export const LABELS: Record<string, string> = {
  entite: "Entité", priorite: "Priorité", statut: "Statut", echeance: "Échéance",
  categorie: "Catégorie", departement: "Département", etat: "État", numero: "Numéro",
  reference: "Référence", montant: "Montant", devise: "Devise", creele: "Créé le",
  "date depot": "Date de dépôt", "date creation": "Date de création",
  "date limite": "Date limite", "etape courante": "Étape courante",
  "charge du dossier": "Chargé du dossier", "cree le": "Créé le", "mis a jour": "Mis à jour",
  "derniere activite": "Dernière activité", "nom complet": "Nom complet",
  "type de process": "Type de process", "niveau de process": "Niveau de process",
};

/**
 * `nomComplet` → « Nom complet » ; `chargeDuDossier` → « Chargé du dossier ». Presque sans
 * dictionnaire.
 *
 * LA CAPITALE N'EST PAS ANGLAISE. Découper le chameau donne « Charge Du Dossier », qui est de
 * l'anglais typographique dans une interface française. Seul le premier mot prend la majuscule
 * — SAUF les sigles, qu'on reconnaît à leur casse (« dateAMM » → « date AMM », jamais « amm »).
 */
export function humanize(key: string): string {
  const words = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/);
  const out = words.map((w, i) => {
    const acronym = w.length > 1 && w === w.toUpperCase();
    if (acronym) return w;
    return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w.toLowerCase();
  });
  const plain = out.join(" ");
  // La table est consultée sur la forme MINUSCULE, pour couvrir `dateDepot` et `date_depot`
  // d'un seul coup. Deux passes : l'expression entière d'abord (« date depot » → « Date de
  // dépôt »), puis MOT À MOT — sans quoi « numeroAMM » resterait « Numero AMM » parce que le
  // sigle qui suit empêche la correspondance globale.
  const whole = LABELS[plain.toLowerCase()];
  if (whole) return whole;
  const byWord = out.map((w, i) => {
    const fix = LABELS[w.toLowerCase()];
    if (!fix) return w;
    return i === 0 ? fix : fix.charAt(0).toLowerCase() + fix.slice(1);
  });
  return byWord.join(" ");
}

export const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export const TONES = new Set(["neutre", "attention", "alerte", "succes"]);
export const DOC_KINDS = new Set(["pdf", "image", "feuille", "texte", "autre"]);

/**
 * UN DOCUMENT NE S'OUVRE QUE PAR UNE ROUTE DE L'ERP.
 *
 * Une URL absolue dans un cadre affiché sous la réponse du PDG, c'est une page tierce qui
 * s'exécute dans son onglet. On n'accepte donc qu'un chemin interne — et la route, elle,
 * revérifie les droits du document à chaque requête.
 */
export const isInternalHref = (h: string): boolean => h.startsWith("/") && !h.startsWith("//");

export function readColumns(v: unknown): WorkspaceColumn[] {
  const out: WorkspaceColumn[] = [];
  for (const c of arr(v)) {
    if (!isObj(c)) continue;
    const key = s(c.key);
    if (!key) continue;
    out.push({
      key, label: s(c.label) ?? humanize(key),
      ...(c.numeric === true ? { numeric: true } : {}),
      ...(c.badge === true ? { badge: true } : {}),
    });
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * LES LIGNES D'UN TABLEAU DÉCLARÉ — les DEUX formes acceptées, une seule rendue.
 *
 * Un outil peut écrire `{ reference: "REG-001" }` (le cas courant) ou
 * `{ cells: {...}, actions: [...] }` quand il veut poser un geste sur la ligne. Exiger la
 * seconde partout alourdirait chaque appelant pour une capacité que trois d'entre eux utilisent.
 */
export function readRows(v: unknown, columns: WorkspaceColumn[]): WorkspaceRow[] {
  const out: WorkspaceRow[] = [];
  for (const r of arr(v)) {
    if (!isObj(r)) continue;
    const source = isObj(r.cells) ? r.cells : r;
    const cells: Record<string, string> = {};
    for (const c of columns) cells[c.key] = clip(s(source[c.key]), 120) ?? "—";
    const actions = actionsOf(r.actions).slice(0, WORKSPACE_LIMITS.rowActions);
    const href = s(r.href) ?? s(r.lien);
    const tons: Record<string, "neutre" | "attention" | "alerte" | "succes"> = {};
    if (isObj(r.tons)) {
      for (const [k, t] of Object.entries(r.tons)) {
        if (t === "neutre" || t === "attention" || t === "alerte" || t === "succes") tons[k] = t;
      }
    }
    out.push({
      cells,
      ...(Object.keys(tons).length ? { tons } : {}),
      ...(actions.length ? { actions } : {}),
      ...(href ? { href } : {}),
    });
    if (out.length >= WORKSPACE_LIMITS.tableRows) break;
  }
  return out;
}

export function readSheet(v: unknown): WorkspaceDoc["feuille"] {
  if (!isObj(v)) return null;
  const columns = readColumns(v.columns);
  if (columns.length === 0) return null;
  const rows: Record<string, string>[] = [];
  for (const r of arr(v.rows)) {
    if (!isObj(r)) continue;
    const line: Record<string, string> = {};
    for (const c of columns) line[c.key] = clip(s(r[c.key]), 120) ?? "—";
    rows.push(line);
    if (rows.length >= WORKSPACE_LIMITS.sheetRows) break;
  }
  if (rows.length === 0) return null;
  return { columns, rows, total: num(v.total) ?? rows.length };
}

export const TON = new Set(["neutre", "attention", "alerte", "succes"]);
export const tonOf = (v: unknown, fallback?: "neutre" | "succes" | "attention" | "alerte") => {
  const t = s(v);
  return t && TON.has(t) ? (t as "neutre" | "attention" | "alerte" | "succes") : fallback;
};

export function readMetrics(v: unknown): WorkspaceMetric[] {
  const out: WorkspaceMetric[] = [];
  for (const m of arr(v)) {
    if (!isObj(m)) continue;
    const valeur = clip(s(m.valeur) ?? s(m.value), 12);
    const label = clip(s(m.label) ?? s(m.libelle), 32);
    if (!valeur || !label) continue;
    out.push({ valeur, label, ...(tonOf(m.ton) ? { ton: tonOf(m.ton) } : {}) });
    if (out.length >= WORKSPACE_LIMITS.metrics) break;
  }
  return out;
}

/** Une personne déclarée par un outil — nom obligatoire, tout le reste facultatif. */
export function readPerson(v: unknown): WorkspacePerson | null {
  if (!isObj(v)) return null;
  const nom = clip(s(v.nom) ?? s(v.name), 80);
  if (!nom) return null;
  const statutLabel = clip(s(isObj(v.statut) ? v.statut.label : v.statut), 24);
  const metriques = readMetrics(v.metriques);
  // La photo suit la règle des documents : une route de l'ERP, qui revérifie les droits. Une URL
  // externe est ÉCARTÉE — elle ferait fuiter la consultation vers un tiers, et afficherait un
  // visage que l'ERP n'a pas validé.
  const photo = s(v.photo) ?? s(v.avatar);
  return {
    nom,
    poste: s(v.poste), departement: s(v.departement), entite: s(v.entite),
    ...(photo && isInternalHref(photo) ? { photo } : {}),
    coordonnees: endpointsOf(v.coordonnees),
    ...(statutLabel ? { statut: { label: statutLabel, ton: tonOf(isObj(v.statut) ? v.statut.ton : null, "neutre")! } } : {}),
    ...(metriques.length ? { metriques } : {}),
    ...(s(v.href) ?? s(v.lien) ? { href: (s(v.href) ?? s(v.lien)) as string } : {}),
  };
}