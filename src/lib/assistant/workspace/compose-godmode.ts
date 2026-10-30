import {
  WORKSPACE_LIMITS,
  type StoryEvent, type StoryEventKind, type StoryParticipant, type StoryThread,
  type WorkspaceAction, type WorkspaceBlock, type WorkspaceBlockMeta, type WorkspaceBlockState,
  type WorkspaceCertainty, type WorkspaceDoc, type WorkspaceEntityRef, type WorkspaceField,
  type WorkspaceGauge, type WorkspaceItem, type WorkspacePerson,
} from "@/platform/ia/workspace/protocol";
import {
  actionsOf, arr, clip, DOC_KINDS, isInternalHref, isObj, num, readColumns, readEditable,
  readMetrics, readPerson, readRows, s, strings, TONES, tonOf, type Json,
} from "@/platform/ia/workspace/read";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES BLOCS RICHES, RELUS AVEC LA MÊME DÉFIANCE QUE LES AUTRES.
 *
 * Story, vue 360, comparaison, mission, alerte : cinq formes bien plus grandes que « un
 * tableau » ou « trois jauges ». Elles arrivent par `_blocs`, donc d'un outil canonique écrit
 * en TypeScript côté serveur — jamais du modèle, qui n'écrit aucun balisage dans ce produit.
 *
 * ── POURQUOI LES RELIRE PUISQU'ELLES VIENNENT DE NOTRE PROPRE CODE ────────────────────────
 *
 * Parce que « notre propre code » comprend un outil écrit dans six mois par quelqu'un qui aura
 * lu la documentation de travers, et parce qu'une sortie d'outil traverse une sérialisation
 * JSON qui perd les types. La relecture n'est pas une défiance envers l'auteur : c'est la seule
 * chose qui garantit que ce qui atteint l'écran a la forme que le composant attend.
 *
 * ── LA LIMITE QUI COMPTE : `manque` ───────────────────────────────────────────────────────
 *
 * Un jalon absent est le plus utile de la story, donc `etat: "manque"` doit survivre à la
 * relecture. Le repli d'un état inconnu est `a-venir`, jamais `fait` : se tromper vers
 * « pas encore » est réparable, se tromper vers « c'est fait » ne l'est pas.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Combien d'objets d'un même genre tiennent dans une réponse, avant de devenir un rapport. */
export const GODMODE_LIMITS = {
  /** Une affaire dépasse rarement 60 jalons ; au-delà, c'est un export, pas une lecture. */
  storyEvents: 80,
  storyThreads: 12,
  storyKpis: 6,
  storyLimites: 5,
  /** Trois chiffres par jalon : montant, quantité, écart. Le quatrième est du remplissage. */
  eventMetrics: 3,
  eventParticipants: 4,
  eventDocs: 4,
  eventFils: 6,
  /** Huit sections repliées tiennent dans une vue ; la neuvième ne sera jamais ouverte. */
  sections: 8,
  sectionFields: 20,
  sectionItems: 12,
  sectionGauges: 6,
  badges: 4,
  /** Trois colonnes comparées : au-delà, l'œil ne fait plus la comparaison, il lit un tableau. */
  comparisonSubjects: 3,
  comparisonRows: 20,
  /** Une mission de plus de douze gestes n'est plus une mission, c'est un projet. */
  missionSteps: 12,
  /**
   * LES JALONS D'UNE MISSION LONGUE. Le plafond est plus haut que celui des étapes parce
   * qu'un jalon est une LIGNE, pas un geste : vingt jalons se lisent, vingt gestes ne se
   * confirment pas. Il vaut celui du planificateur de jalons (`JALONS_MAX`) — au-delà, la
   * carte ne dirait plus le même horizon que la mission.
   */
  missionJalons: 20,
} as const;

const STORY_KINDS = new Set<string>([
  "publication", "cahier-des-charges", "soumission", "attribution",
  "contrat", "avenant", "commande", "livraison", "facture", "paiement",
  "courrier", "decision", "jalon", "cloture", "incident",
]);

const STORY_ETATS = new Set<string>(["fait", "en-cours", "a-venir", "manque", "echec"]);
const THREAD_GENRES = new Set<string>(["produit", "famille", "risque", "acteur"]);
const CERTAINTIES = new Set<string>(["fait", "deduit", "estime", "propose", "attente"]);
const BLOCK_STATES = new Set<string>([
  "loading", "partial", "complete", "awaiting_confirmation", "sending", "executed", "failed",
]);
const ETAPE_ETATS = new Set<string>(["a-faire", "en-cours", "fait", "echec", "ignore"]);
// Un JALON ne connaît pas « ignoré » : un jalon écarté est ÉCARTÉ (donc franchi), jamais sauté.
const JALON_ETATS = new Set<string>(["a-faire", "en-cours", "fait", "echec"]);
const ALERTE_TONS = new Set<string>(["info", "attention", "alerte"]);

/**
 * L'IDENTITÉ D'UNE ENTITÉ — le champ qui rend le zoom et les actions déterministes possibles.
 *
 * `type` est laissé LIBRE (une chaîne, pas une énumération) et c'est délibéré : les types
 * canoniques de l'ERP sont déjà une trentaine et vivent dans le registre d'entités, pas ici.
 * Recopier cette liste dans le protocole aurait créé une seconde source de vérité qui dérive.
 * Ce qui est exigé, en revanche : les DEUX champs présents et non vides — une référence à
 * moitié remplie ne désigne rien, et un bouton branché dessus agirait au hasard.
 */
export function readEntityRef(v: unknown): WorkspaceEntityRef | null {
  if (!isObj(v)) return null;
  const type = clip(s(v.type), 40);
  const id = clip(s(v.id), 80);
  if (!type || !id) return null;
  return { type, id, ...(clip(s(v.label), 120) ? { label: clip(s(v.label), 120) } : {}) };
}

const certaintyOf = (v: unknown): WorkspaceCertainty | undefined => {
  const c = s(v);
  return c && CERTAINTIES.has(c) ? (c as WorkspaceCertainty) : undefined;
};

/** Les métadonnées communes à tout bloc — identité, état, fraîcheur, provenance. */
export function readMeta(v: Json): WorkspaceBlockMeta {
  const state = s(v.state);
  const version = num(v.version);
  return {
    ...(clip(s(v.blockId), 80) ? { blockId: clip(s(v.blockId), 80) as string } : {}),
    ...(readEntityRef(v.entityRef) ? { entityRef: readEntityRef(v.entityRef) } : {}),
    ...(state && BLOCK_STATES.has(state) ? { state: state as WorkspaceBlockState } : {}),
    // Une version NÉGATIVE ou fractionnaire n'est pas une version : on l'écarte plutôt que de
    // la corriger silencieusement, sinon le morphing comparerait des ordres inventés.
    ...(version !== null && version >= 0 && Number.isInteger(version) ? { version } : {}),
    ...(clip(s(v.freshness), 40) ? { freshness: clip(s(v.freshness), 40) } : {}),
    ...(clip(s(v.provenance), 60) ? { provenance: clip(s(v.provenance), 60) } : {}),
    ...(certaintyOf(v.certitude) ? { certitude: certaintyOf(v.certitude) } : {}),
  };
}

/** Des documents, avec la règle d'href interne appliquée sans exception. */
function readDocs(v: unknown, max: number): WorkspaceDoc[] {
  const out: WorkspaceDoc[] = [];
  for (const d of arr(v)) {
    if (!isObj(d)) continue;
    const nom = clip(s(d.nom) ?? s(d.name), 120);
    const href = s(d.href) ?? s(d.lien);
    if (!nom || !href || !isInternalHref(href)) continue;
    const type = s(d.type);
    out.push({
      nom, href,
      type: (type && DOC_KINDS.has(type) ? type : "autre") as WorkspaceDoc["type"],
      ...(s(d.taille) ? { taille: s(d.taille) } : {}),
      ...(s(d.date) ? { date: s(d.date) } : {}),
      ...(clip(s(d.soustitre), 80) ? { soustitre: clip(s(d.soustitre), 80) } : {}),
    });
    if (out.length >= max) break;
  }
  return out;
}

function readParticipants(v: unknown): StoryParticipant[] {
  const out: StoryParticipant[] = [];
  for (const p of arr(v)) {
    if (!isObj(p)) continue;
    const nom = clip(s(p.nom) ?? s(p.name), 80);
    if (!nom) continue;
    const photo = s(p.photo);
    out.push({
      nom,
      // Même règle que partout : un visage vient d'une route de l'ERP, qui revérifie les droits.
      ...(photo && isInternalHref(photo) ? { photo } : {}),
      ...(clip(s(p.role), 60) ? { role: clip(s(p.role), 60) } : {}),
    });
    if (out.length >= GODMODE_LIMITS.eventParticipants) break;
  }
  return out;
}

/**
 * UN JALON — et les deux règles qui empêchent la frise de mentir.
 *
 * 1. `date` peut être `null` : un jalon ATTENDU n'a pas de date, et lui en inventer une le
 *    ferait passer pour advenu. On accepte donc l'absence, on refuse la valeur douteuse.
 * 2. `etat` inconnu retombe sur `a-venir`. Jamais sur `fait`.
 */
function readStoryEvent(v: unknown): StoryEvent | null {
  if (!isObj(v)) return null;
  const id = clip(s(v.id), 80);
  const titre = clip(s(v.titre) ?? s(v.title), 140);
  const kind = s(v.kind);
  if (!id || !titre || !kind || !STORY_KINDS.has(kind)) return null;

  const etat = s(v.etat);
  const retard = num(v.retardJours);
  const metriques = readMetrics(v.metriques).slice(0, GODMODE_LIMITS.eventMetrics);
  const participants = readParticipants(v.participants);
  const docs = readDocs(v.docs, GODMODE_LIMITS.eventDocs);
  const fils = strings(v.fils, GODMODE_LIMITS.eventFils);
  const actions = actionsOf(v.actions, WORKSPACE_LIMITS.itemActions);

  return {
    id,
    date: s(v.date),
    kind: kind as StoryEventKind,
    titre,
    ...(clip(s(v.detail), WORKSPACE_LIMITS.snippetChars) ? { detail: clip(s(v.detail), WORKSPACE_LIMITS.snippetChars) } : {}),
    etat: (etat && STORY_ETATS.has(etat) ? etat : "a-venir") as StoryEvent["etat"],
    ...(readEntityRef(v.entityRef) ? { entityRef: readEntityRef(v.entityRef) } : {}),
    ...(metriques.length ? { metriques } : {}),
    ...(participants.length ? { participants } : {}),
    ...(docs.length ? { docs } : {}),
    ...(fils.length ? { fils } : {}),
    ...(clip(s(v.parent), 80) ? { parent: clip(s(v.parent), 80) } : {}),
    ...(retard !== null ? { retardJours: Math.round(retard) } : {}),
    ...(clip(s(v.provenance), 60) ? { provenance: clip(s(v.provenance), 60) } : {}),
    ...(certaintyOf(v.certitude) ? { certitude: certaintyOf(v.certitude) } : {}),
    ...(actions.length ? { actions } : {}),
  };
}

function readThreads(v: unknown): StoryThread[] {
  const out: StoryThread[] = [];
  for (const t of arr(v)) {
    if (!isObj(t)) continue;
    const id = clip(s(t.id), 80);
    const label = clip(s(t.label), 40);
    const count = num(t.count);
    // UN FIL VIDE NE SE PROPOSE PAS. Un filtre qui ne ramène rien fait douter de la donnée,
    // pas du filtre — et c'est le produit qui paraît cassé.
    if (!id || !label || count === null || count <= 0) continue;
    const genre = s(t.genre);
    out.push({
      id, label, count: Math.round(count),
      ...(genre && THREAD_GENRES.has(genre) ? { genre: genre as StoryThread["genre"] } : {}),
    });
    if (out.length >= GODMODE_LIMITS.storyThreads) break;
  }
  return out;
}

/**
 * LA STORY — et le nettoyage qui la rend cohérente.
 *
 * Deux invariants sont imposés APRÈS lecture, parce qu'ils portent sur l'ensemble et pas sur un
 * champ : un `parent` qui ne désigne aucun jalon retenu est effacé (sinon l'enfant disparaîtrait
 * de l'affichage, rattaché à un père absent), et un `fils` qui ne correspond à aucun fil déclaré
 * est retiré (sinon un jalon serait invisible dans tous les filtres).
 *
 * C'est exactement ce que la troncature à 80 jalons peut provoquer : le père est au-delà du
 * plafond, l'enfant en deçà. Sans ce nettoyage, la story perdrait des jalons SILENCIEUSEMENT.
 */
function readStory(v: Json, title: string): WorkspaceBlock | null {
  const events: StoryEvent[] = [];
  const vus = new Set<string>();
  for (const e of arr(v.events)) {
    const ev = readStoryEvent(e);
    if (!ev || vus.has(ev.id)) continue;
    vus.add(ev.id);
    events.push(ev);
    if (events.length >= GODMODE_LIMITS.storyEvents) break;
  }
  if (events.length === 0) return null;

  const threads = readThreads(v.threads);
  const filsConnus = new Set(threads.map((t) => t.id));
  const propres = events.map((e) => {
    const parent = e.parent && vus.has(e.parent) ? e.parent : null;
    const fils = (e.fils ?? []).filter((f) => filsConnus.has(f));
    return { ...e, parent, ...(fils.length ? { fils } : { fils: undefined }) };
  });

  const kpis = readMetrics(v.kpis).slice(0, GODMODE_LIMITS.storyKpis);
  const limites = arr(v.limites)
    .map((l) => clip(s(l), WORKSPACE_LIMITS.snippetChars))
    .filter((l): l is string => l !== null)
    .slice(0, GODMODE_LIMITS.storyLimites);
  const actions = actionsOf(v.actions, WORKSPACE_LIMITS.blockActions);

  return {
    kind: "story", title,
    ...(clip(s(v.subtitle) ?? s(v.sousTitre), 160) ? { subtitle: clip(s(v.subtitle) ?? s(v.sousTitre), 160) } : {}),
    ...(kpis.length ? { kpis } : {}),
    events: propres,
    ...(threads.length ? { threads } : {}),
    ...(limites.length ? { limites } : {}),
    ...(actions.length ? { actions } : {}),
    ...readMeta(v),
  };
}

function readFields(v: unknown, max: number): WorkspaceField[] {
  const out: WorkspaceField[] = [];
  for (const f of arr(v)) {
    if (!isObj(f)) continue;
    const label = clip(s(f.label) ?? s(f.libelle), 40);
    const value = clip(s(f.value) ?? s(f.valeur), WORKSPACE_LIMITS.snippetChars);
    if (!label || !value) continue;
    const av = isObj(f.avatar) ? f.avatar : null;
    const avNom = av ? clip(s(av.nom) ?? s(av.name), 80) : null;
    const avPhoto = av ? s(av.photo) : null;
    out.push({
      label, value,
      ...(avNom ? { avatar: { nom: avNom, ...(avPhoto && isInternalHref(avPhoto) ? { photo: avPhoto } : {}) } } : {}),
      ...(tonOf(f.ton) ? { ton: tonOf(f.ton) } : {}),
      ...(readEditable(f.editable) ? { editable: readEditable(f.editable) } : {}),
    });
    if (out.length >= max) break;
  }
  return out;
}

function readGauges(v: unknown, max: number): WorkspaceGauge[] {
  const out: WorkspaceGauge[] = [];
  for (const g of arr(v)) {
    if (!isObj(g)) continue;
    const label = clip(s(g.label) ?? s(g.libelle), 60);
    const valeur = num(g.valeur) ?? num(g.value);
    if (!label || valeur === null) continue;
    const ton = s(g.ton);
    out.push({
      label, valeur,
      ...(num(g.total) !== null ? { total: num(g.total) as number } : {}),
      ...(s(g.unite) ? { unite: s(g.unite) } : {}),
      ...(clip(s(g.detail), 80) ? { detail: clip(s(g.detail), 80) } : {}),
      ...(ton && TONES.has(ton) ? { ton: ton as WorkspaceGauge["ton"] } : {}),
    });
    if (out.length >= max) break;
  }
  return out;
}

function readItems(v: unknown, max: number): WorkspaceItem[] {
  const out: WorkspaceItem[] = [];
  for (const it of arr(v)) {
    if (!isObj(it)) continue;
    const titre = clip(s(it.titre) ?? s(it.libelle), 140);
    if (!titre) continue;
    const href = s(it.href) ?? s(it.lien);
    const actions = actionsOf(it.actions);
    out.push({
      titre,
      detail: clip(s(it.detail), WORKSPACE_LIMITS.snippetChars),
      statut: clip(s(it.statut) ?? s(it.etat), 32),
      echeance: clip(s(it.echeance) ?? s(it.date), 40),
      ...(href && isInternalHref(href) ? { href } : {}),
      ...(actions.length ? { actions } : {}),
    });
    if (out.length >= max) break;
  }
  return out;
}

type Entity360 = Extract<WorkspaceBlock, { kind: "entity360" }>;
type Section = Entity360["sections"][number];

/**
 * UNE SECTION DE LA VUE 360 — et la règle des DEUX ouvertes.
 *
 * `ouvert` est appliqué au maximum deux fois. Un serveur qui ouvrirait tout obtiendrait le
 * tableau de bord illisible que la divulgation progressive existe pour éviter : le plafond est
 * donc tenu ICI, une bonne fois, plutôt qu'espéré de chaque appelant.
 */
function readSection(v: unknown, budgetOuvert: { reste: number }): Section | null {
  if (!isObj(v)) return null;
  const id = clip(s(v.id), 60);
  const label = clip(s(v.label), 60);
  if (!id || !label) return null;

  const fields = readFields(v.fields ?? v.champs, GODMODE_LIMITS.sectionFields);
  const gauges = readGauges(v.gauges ?? v.jauges, GODMODE_LIMITS.sectionGauges);
  const items = readItems(v.items, GODMODE_LIMITS.sectionItems);
  const docs = readDocs(v.docs, WORKSPACE_LIMITS.docs + 3);
  const people: WorkspacePerson[] = [];
  for (const p of arr(v.people ?? v.personnes)) {
    const person = readPerson(p);
    if (person) people.push(person);
    if (people.length >= WORKSPACE_LIMITS.people) break;
  }

  let table: Section["table"];
  if (isObj(v.table)) {
    const columns = readColumns(v.table.columns);
    const rows = readRows(v.table.rows, columns);
    if (columns.length > 0 && rows.length > 0) {
      table = { columns, rows, total: num(v.table.total) ?? rows.length };
    }
  }

  const note = clip(s(v.note), WORKSPACE_LIMITS.snippetChars);
  const vide = fields.length === 0 && gauges.length === 0 && items.length === 0
    && docs.length === 0 && people.length === 0 && !table;
  // UNE SECTION VIDE RESTE UTILE SI ELLE DIT POURQUOI (§54). Sans note, elle ne dit rien : on
  // ne l'affiche pas, plutôt que d'offrir un chevron qui ouvre sur du blanc.
  if (vide && !note) return null;

  const veutOuvert = v.ouvert === true && budgetOuvert.reste > 0;
  if (veutOuvert) budgetOuvert.reste -= 1;
  const actions = actionsOf(v.actions, WORKSPACE_LIMITS.blockActions);

  return {
    id, label,
    ...(veutOuvert ? { ouvert: true } : {}),
    ...(fields.length ? { fields } : {}),
    ...(gauges.length ? { gauges } : {}),
    ...(items.length ? { items } : {}),
    ...(table ? { table } : {}),
    ...(docs.length ? { docs } : {}),
    ...(people.length ? { people } : {}),
    ...(note ? { note } : {}),
    ...(actions.length ? { actions } : {}),
  };
}

function readEntity360(v: Json, title: string): WorkspaceBlock | null {
  const budget = { reste: 2 };
  const sections: Section[] = [];
  for (const sec of arr(v.sections)) {
    const parsed = readSection(sec, budget);
    if (parsed) sections.push(parsed);
    if (sections.length >= GODMODE_LIMITS.sections) break;
  }
  // UNE VUE 360 SANS SECTION N'EST PAS UNE VUE 360. Un en-tête seul promet une profondeur qui
  // n'existe pas ; mieux vaut alors la réponse en texte.
  if (sections.length === 0) return null;

  const badges: Entity360["badges"] = [];
  for (const bd of arr(v.badges)) {
    const label = clip(s(isObj(bd) ? bd.label : bd), 28);
    if (!label) continue;
    badges.push({ label, ton: tonOf(isObj(bd) ? bd.ton : null, "neutre")! });
    if (badges.length >= GODMODE_LIMITS.badges) break;
  }

  const kpis = readMetrics(v.kpis).slice(0, 4);
  const limites = arr(v.limites)
    .map((l) => clip(s(l), WORKSPACE_LIMITS.snippetChars))
    .filter((l): l is string => l !== null)
    .slice(0, GODMODE_LIMITS.storyLimites);
  const photo = s(v.photo);
  const href = s(v.href) ?? s(v.lien);
  const actions = actionsOf(v.actions, WORKSPACE_LIMITS.blockActions);

  return {
    kind: "entity360", title,
    ...(clip(s(v.subtitle) ?? s(v.sousTitre), 160) ? { subtitle: clip(s(v.subtitle) ?? s(v.sousTitre), 160) } : {}),
    ...(badges.length ? { badges } : {}),
    ...(photo && isInternalHref(photo) ? { photo } : {}),
    ...(kpis.length ? { kpis } : {}),
    sections,
    ...(limites.length ? { limites } : {}),
    ...(href && isInternalHref(href) ? { href } : {}),
    ...(actions.length ? { actions } : {}),
    ...readMeta(v),
  };
}

type Comparison = Extract<WorkspaceBlock, { kind: "comparison" }>;

/**
 * LA COMPARAISON — et l'invariant d'ALIGNEMENT.
 *
 * `valeurs` est positionnel : la case 0 appartient au sujet 0. Une ligne plus courte que le
 * nombre de sujets décalerait toutes les suivantes et ferait lire la valeur d'Alger sous
 * « Oran ». On COMPLÈTE donc à la longueur exacte avec `null` (« — » à l'écran) et on tronque
 * l'excédent : une case vide se voit, une case décalée se croit.
 */
function readComparison(v: Json, title: string): WorkspaceBlock | null {
  const sujets: Comparison["sujets"] = [];
  for (const su of arr(v.sujets)) {
    if (!isObj(su)) continue;
    const id = clip(s(su.id), 60);
    const label = clip(s(su.label), 60);
    if (!id || !label) continue;
    sujets.push({
      id, label,
      ...(clip(s(su.sousTitre), 60) ? { sousTitre: clip(s(su.sousTitre), 60) } : {}),
      ...(readEntityRef(su.entityRef) ? { entityRef: readEntityRef(su.entityRef) } : {}),
    });
    if (sujets.length >= GODMODE_LIMITS.comparisonSubjects) break;
  }
  // COMPARER, C'EST AU MOINS DEUX. Un sujet seul n'est pas une comparaison, c'est une fiche.
  if (sujets.length < 2) return null;

  const lignes: Comparison["lignes"] = [];
  for (const l of arr(v.lignes)) {
    if (!isObj(l)) continue;
    const dimension = clip(s(l.dimension), 60);
    if (!dimension) continue;
    const brut = arr(l.valeurs).map((x) => clip(s(x), 60));
    const valeurs = sujets.map((_, i) => brut[i] ?? null);
    lignes.push({
      dimension, valeurs,
      ...(clip(s(l.delta), 40) ? { delta: clip(s(l.delta), 40) } : {}),
      ...(tonOf(l.deltaTon) ? { deltaTon: tonOf(l.deltaTon) } : {}),
      ...(clip(s(l.insight), WORKSPACE_LIMITS.snippetChars) ? { insight: clip(s(l.insight), WORKSPACE_LIMITS.snippetChars) } : {}),
    });
    if (lignes.length >= GODMODE_LIMITS.comparisonRows) break;
  }
  if (lignes.length === 0) return null;

  const actions = actionsOf(v.actions, WORKSPACE_LIMITS.blockActions);
  return {
    kind: "comparison", title,
    ...(clip(s(v.subtitle) ?? s(v.sousTitre), 160) ? { subtitle: clip(s(v.subtitle) ?? s(v.sousTitre), 160) } : {}),
    sujets, lignes,
    ...(clip(s(v.note), WORKSPACE_LIMITS.snippetChars) ? { note: clip(s(v.note), WORKSPACE_LIMITS.snippetChars) } : {}),
    ...(actions.length ? { actions } : {}),
    ...readMeta(v),
  };
}

type Mission = Extract<WorkspaceBlock, { kind: "mission" }>;

/**
 * LA MISSION — UNE confirmation, et la garantie qu'elle est unique.
 *
 * `confirmation` est un geste, pas une liste : le protocole l'impose, et la relecture ne prend
 * que le PREMIER si un appelant en envoie plusieurs. C'est la promesse de §18 — « plusieurs
 * gestes, une confirmation » — tenue par le type plutôt que par la discipline de l'appelant.
 */
function readMission(v: Json, title: string): WorkspaceBlock | null {
  const etapes: Mission["etapes"] = [];
  const vus = new Set<string>();
  for (const e of arr(v.etapes)) {
    if (!isObj(e)) continue;
    const id = clip(s(e.id), 60);
    const label = clip(s(e.label) ?? s(e.libelle), 120);
    if (!id || !label || vus.has(id)) continue;
    vus.add(id);
    const etat = s(e.etat);
    etapes.push({
      id, label,
      ...(clip(s(e.detail), WORKSPACE_LIMITS.snippetChars) ? { detail: clip(s(e.detail), WORKSPACE_LIMITS.snippetChars) } : {}),
      // Un état inconnu retombe sur « à faire » : afficher « fait » sur un geste dont on ne sait
      // rien ferait croire à une exécution qui n'a pas eu lieu.
      etat: (etat && ETAPE_ETATS.has(etat) ? etat : "a-faire") as Mission["etapes"][number]["etat"],
      ...(clip(s(e.erreur), WORKSPACE_LIMITS.snippetChars) ? { erreur: clip(s(e.erreur), WORKSPACE_LIMITS.snippetChars) } : {}),
      ...(actionsOf(e.actions, WORKSPACE_LIMITS.itemActions).length
        ? { actions: actionsOf(e.actions, WORKSPACE_LIMITS.itemActions) }
        : {}),
    });
    if (etapes.length >= GODMODE_LIMITS.missionSteps) break;
  }
  if (etapes.length === 0) return null;

  /**
   * L'HORIZON, QUAND IL Y EN A UN (§118.50).
   *
   * Deux formes acceptées et c'est délibéré : `jalons` à plat, pour un bloc composé par le
   * modèle, et `horizon.jalons`, la forme exacte que rend `vueMission`. Le second est le
   * chemin RÉEL — la carte d'une mission dans la conversation vient de la base, pas d'une
   * rédaction — et exiger que l'appelant l'aplatisse aurait ajouté un endroit où se tromper.
   */
  const sourceJalons = arr(v.jalons).length > 0
    ? arr(v.jalons)
    : isObj(v.horizon) ? arr((v.horizon as Json).jalons) : [];
  const jalons: NonNullable<Mission["jalons"]> = [];
  for (const j of sourceJalons) {
    if (!isObj(j)) continue;
    const ordre = typeof j.ordre === "number" && Number.isFinite(j.ordre) ? Math.trunc(j.ordre) : null;
    const titre = clip(s(j.titre) ?? s(j.title), 120);
    if (ordre === null || !titre) continue;
    const etat = s(j.etat);
    jalons.push({
      ordre, titre,
      ...(clip(s(j.resultat), WORKSPACE_LIMITS.snippetChars)
        ? { resultat: clip(s(j.resultat), WORKSPACE_LIMITS.snippetChars) } : {}),
      // Même règle que pour une étape : un état inconnu retombe sur « à faire ». Afficher
      // « fait » sur un jalon dont on ne sait rien annoncerait un résultat jamais constaté.
      etat: (etat && JALON_ETATS.has(etat) ? etat : "a-faire") as NonNullable<Mission["jalons"]>[number]["etat"],
      ...(j.compile === true ? { compile: true } : j.compile === false ? { compile: false } : {}),
    });
    if (jalons.length >= GODMODE_LIMITS.missionJalons) break;
  }

  const conf: WorkspaceAction | undefined = actionsOf(v.confirmation ? [v.confirmation] : [], 1)[0];
  const actions = actionsOf(v.actions, WORKSPACE_LIMITS.blockActions);
  return {
    kind: "mission", title,
    ...(clip(s(v.subtitle) ?? s(v.sousTitre), 160) ? { subtitle: clip(s(v.subtitle) ?? s(v.sousTitre), 160) } : {}),
    etapes,
    ...(jalons.length ? { jalons } : {}),
    ...(conf ? { confirmation: conf } : {}),
    ...(actions.length ? { actions } : {}),
    ...readMeta(v),
  };
}

/**
 * L'ALERTE — et pourquoi le ton n'a PAS de repli permissif.
 *
 * Un ton inconnu ne devient pas « alerte » : une notification rouge qu'on n'a pas demandée use
 * l'attention et finit par être ignorée, y compris quand elle est juste. Le repli est `info`.
 */
function readAlerte(v: Json, title: string): WorkspaceBlock | null {
  const message = clip(s(v.message), 300);
  if (!message) return null;
  const ton = s(v.ton);
  const actions = actionsOf(v.actions, WORKSPACE_LIMITS.blockActions);
  return {
    kind: "alerte", title,
    ton: (ton && ALERTE_TONS.has(ton) ? ton : "info") as "info" | "attention" | "alerte",
    message,
    ...(clip(s(v.detail), WORKSPACE_LIMITS.snippetChars) ? { detail: clip(s(v.detail), WORKSPACE_LIMITS.snippetChars) } : {}),
    ...(clip(s(v.origine), 80) ? { origine: clip(s(v.origine), 80) } : {}),
    ...(actions.length ? { actions } : {}),
    ...readMeta(v),
  };
}

/**
 * LE POINT D'ENTRÉE — appelé par `readBlock` quand aucun des sept traducteurs historiques n'a
 * reconnu la forme. Rend `null` pour tout `kind` étranger, comme le reste du composeur.
 */
export function readGodmodeBlock(v: Json, title: string): WorkspaceBlock | null {
  switch (v.kind) {
    case "story": return readStory(v, title);
    case "entity360": return readEntity360(v, title);
    case "comparison": return readComparison(v, title);
    case "mission": return readMission(v, title);
    case "alerte": return readAlerte(v, title);
    default: return null;
  }
}
