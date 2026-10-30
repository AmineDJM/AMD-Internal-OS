import type { WorkspaceBlock, WorkspaceBlockKind, WorkspaceComposition } from "@/platform/ia/workspace/protocol";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE TOUR COMME ESPACE DE TRAVAIL (§13–§22) — et non comme fil de bulles.
 *
 * ── LE DÉFAUT QUE CE FICHIER CORRIGE ─────────────────────────────────────────────────────
 *
 * Jusqu'ici, un tour d'Adam s'affichait ainsi : des pastilles portant des NOMS D'OUTILS, puis
 * la prose, puis les blocs — un groupe par résultat d'outil, dans l'ordre où les outils avaient
 * répondu — puis, tout en bas et détachées, les cartes de confirmation.
 *
 * Quatre conséquences, et ce sont exactement les quatre reproches faits au chantier précédent :
 *
 *   1. **La prose passait avant l'objet.** On lisait « j'ai préparé le mail » avant de voir le
 *      mail. §13 demande l'inverse : l'objet d'abord, une courte synthèse ensuite.
 *   2. **Le bouton était loin de la chose.** L'aperçu du message vivait en haut, « Confirmer et
 *      envoyer » en bas, séparés par trois blocs. §14 : les gestes vivent SOUS l'information.
 *   3. **L'ordre était celui des appels d'outils**, pas celui des décisions. Un brouillon prêt à
 *      partir se retrouvait derrière un tableau de contexte parce que l'outil avait répondu après.
 *   4. **Les pastilles disaient « gmail_search ».** §18 : l'utilisateur doit voir des états
 *      MÉTIER, pas la plomberie.
 *
 * ── CE QUE CE MODULE FAIT, ET CE QU'IL NE FAIT PAS ───────────────────────────────────────
 *
 * Il RANGE. Il ne rend rien, ne connaît aucun composant, n'importe que des types. Les blocs
 * existants — construits par `compose.ts` et dessinés par `blocks.tsx` — sont conservés tels
 * quels : c'était la bonne brique, il lui manquait un ordre et des liens. C'est aussi ce qui rend
 * cette logique testable sans navigateur, là où une refonte au niveau du composant ne l'aurait
 * pas été.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce qu'une proposition apporte au rangement. Volontairement maigre : on ne range pas des payloads. */
export interface TurnProposal {
  /** Le geste, tel que le registre d'actions le nomme (`send_email`, `decide_payment`…). */
  kind: string;
  title: string;
  /** `pending` seul appelle une décision ; le reste est déjà tranché. */
  state?: "pending" | "done" | "failed" | "cancelled";
  level?: "SENSITIVE" | "CRITICAL";
}

/** Un bloc, sa place, et les gestes qui lui appartiennent. */
export interface TurnSlot {
  block: WorkspaceBlock;
  /** Les indices des propositions rattachées à CE bloc. Le bouton vivra dessous. */
  proposals: number[];
  /** Le poids de décision — plus haut = plus urgent à lire. Exposé pour être testable. */
  weight: number;
}

/**
 * UNE PHASE MÉTIER. Ce que l'utilisateur a le droit de voir passer : « Préparation du message »,
 * pas « appel de l'outil n° 7 ».
 */
export interface TurnPhase {
  label: string;
  /** `done` quand l'étape est passée. `running` pendant qu'elle travaille. */
  state: "running" | "done";
}

export interface TurnWorkspace {
  /** Le premier bloc — celui qui porte la décision. `null` quand le tour est purement verbal. */
  lead: TurnSlot | null;
  /** Le reste, déjà rangé. `lead` n'y figure pas. */
  rest: TurnSlot[];
  phases: TurnPhase[];
  /** La synthèse d'Adam. Elle vient APRÈS les objets, et elle est courte. */
  synthesis: string;
  /**
   * Le tour appelle-t-il UNE confirmation groupée ? §10 : « une mission cohérente = une
   * confirmation ». Vrai dès que plusieurs gestes sont en attente dans le même tour.
   */
  singleConfirmation: boolean;
  /** Combien de gestes attendent une décision. Zéro = rien à confirmer. */
  pending: number;
}

/**
 * LE POIDS DE DÉCISION PAR NATURE DE BLOC.
 *
 * L'ordre n'est pas esthétique : il répond à « qu'est-ce que je dois trancher maintenant ? ».
 * Un brouillon prêt à partir engage l'entreprise dès qu'on clique ; une fiche de contact
 * n'engage rien. Entre les deux, tout se classe par ce que le PDG risque en ne le voyant pas.
 */
const KIND_WEIGHT: Record<WorkspaceBlockKind, number> = {
  // UNE ALERTE PASSE DEVANT TOUT. Elle n'a pas été demandée : si elle ne prend pas la tête, elle
  // se lit après la réponse à une autre question, c'est-à-dire trop tard. C'est la seule nature
  // de bloc qui a le droit de dépasser un brouillon prêt à partir.
  alerte: 95,
  email: 90,      // un message prêt à partir — le geste le plus engageant
  mission: 85,    // plusieurs gestes, UNE confirmation : ce qui reste à trancher en un clic
  queue: 80,      // ce qui attend explicitement une décision
  dossier: 70,    // l'objet métier, avec son blocage
  // LA STORY ET LA VUE 360 sont des RÉPONSES, pas des décisions : elles pèsent moins qu'un
  // geste en attente, plus qu'un tableau. Les mettre au-dessus de l'e-mail ferait passer une
  // lecture avant une action engagée.
  story: 68,
  entity360: 66,
  comparison: 50,
  planification: 60, // un engagement récurrent : à vérifier une fois, pas à trancher chaque jour
  // LE DOCUMENT OUVERT passe devant la pièce à relire, et de peu devant le dossier : c'est
  // l'objet sur lequel la personne travaille EN CE MOMENT. Le reléguer sous un tableau
  // l'obligerait à faire défiler la conversation entre deux retouches de son contrat.
  artifact: 72,
  document: 55,   // une pièce à relire avant de valider
  progress: 45,   // des jauges : un constat, pas une décision
  // LES REPRÉSENTATIONS (§35) : un tableau de bord est une RÉPONSE composée — devant les jauges
  // qu'il contient souvent ; une figure seule passe juste devant le tableau qu'elle accompagne.
  dashboard: 48,
  viz: 42,
  table: 40,
  timeline: 35,
  record: 35,
  agenda: 30,
  mail: 25,
  people: 20,
  directory: 15,
};

/**
 * CE QU'UNE ALERTE FAIT REMONTER — et jusqu'où, exactement.
 *
 * Un dossier bloqué passe devant les autres dossiers et devant les documents. Il ne passe PAS
 * devant la file des décisions qui attendent le PDG (dossier 70 + 9 = 79, file 80), et ce point
 * a été corrigé après avoir REGARDÉ le rendu du scénario « qu'est-ce que j'ai raté ? » : le
 * dossier bloqué y prenait la tête.
 *
 * La distinction est celle-ci. Un dossier bloqué dit « quelque chose est coincé ». Une file de
 * décisions dit « c'est VOUS qui bloquez ». À la question « qu'ai-je raté ? », la seconde répond
 * mieux — c'est d'ailleurs l'ordre de l'exemple donné au §13 de la mission.
 */
const ALERT_BONUS = 9;
/** Un bloc auquel un geste EN ATTENTE est rattaché passe devant tout le reste. */
const PENDING_BONUS = 60;
/**
 * Ce qu'un message perd une fois PARTI.
 *
 * Le chiffre n'est pas rond par hasard : il fait retomber l'aperçu (90) à 30, c'est-à-dire sous
 * un tableau de contexte (40) et au-dessus d'un simple message de boîte (25). Un envoi accompli
 * est un accusé de réception ; il se consulte, il ne se décide plus.
 */
const SENT_PENALTY = 60;

/**
 * LES PHASES MÉTIER, par famille d'outil.
 *
 * La table est volontairement GROSSIÈRE : quinze étapes techniques ne renseignent pas, elles
 * occupent. Trois ou quatre phases lisibles suffisent à dire « j'ai compris, je travaille, c'est
 * prêt » — ce que §18 demande, et tout ce que quelqu'un lit pendant qu'il attend.
 */
const PHASE_OF: { match: RegExp; label: string }[] = [
  { match: /^(directory|people|find_person|resolve)/, label: "Recherche du destinataire" },
  { match: /(gmail|mail|email|message)/, label: "Préparation du message" },
  { match: /(export|xlsx|excel|deliverable|document|drive)/, label: "Préparation du document" },
  { match: /(regulatory|dossier|product|pipeline)/, label: "Analyse des dossiers" },
  { match: /(payment|finance|invoice|budget|treasury)/, label: "Vérification financière" },
  { match: /(calendar|agenda|meeting|event)/, label: "Consultation de l'agenda" },
  { match: /(task|reminder|schedule|workflow)/, label: "Organisation du suivi" },
  { match: /(search|inspect|read|list|get)/, label: "Recherche dans l'ERP" },
];

/** Le repli. Jamais un nom d'outil : mieux vaut vague et vrai que précis et illisible. */
const PHASE_FALLBACK = "Analyse en cours";

/**
 * TRADUIT UNE TRACE D'OUTILS EN PHASES MÉTIER.
 *
 * Les doublons consécutifs fusionnent : appeler trois fois l'annuaire est UNE recherche de
 * destinataire, pas trois. Sans cette fusion, la barre d'avancement raconterait la plomberie —
 * exactement ce que la trace précédente faisait.
 */
export function phasesOf(trace: string[], done = true): TurnPhase[] {
  const out: TurnPhase[] = [];
  for (const t of trace) {
    const label = PHASE_OF.find((p) => p.match.test(t.toLowerCase()))?.label ?? PHASE_FALLBACK;
    if (out[out.length - 1]?.label === label) continue;
    out.push({ label, state: "done" });
  }
  if (!done && out.length) out[out.length - 1].state = "running";
  // Quatre phases suffisent à dire l'essentiel ; au-delà, on décrirait le travail au lieu de
  // rassurer sur son avancement.
  return out.slice(-4);
}

/**
 * QUELS BLOCS UN GESTE CONCERNE.
 *
 * On lie par NATURE d'abord (un envoi de message va sous l'aperçu du message), puis par TITRE si
 * la nature ne suffit pas. Un geste qu'on ne sait pas rattacher n'est pas perdu : il retombe sur
 * le bloc de tête, ce qui reste bien mieux que de le reléguer en bas de page.
 */
const KIND_AFFINITY: { action: RegExp; block: WorkspaceBlockKind }[] = [
  { action: /^(send_email|send_prepared_mail|send_message)$/, block: "email" },
  { action: /^decide_payment$/, block: "queue" },
  { action: /^(update_regulatory|assign_regulatory|set_regulatory|create_dossier|request_regulatory)/, block: "dossier" },
  { action: /^(create_task|update_task|create_admin_request|update_request)$/, block: "queue" },
  { action: /^(create_calendar_event|update_calendar_event)$/, block: "agenda" },
  { action: /^(create_legal_document|update_legal_document)$/, block: "document" },
];

/** Les mots d'un titre qui servent au rapprochement. Les courts n'apprennent rien. */
function titleTokens(s: string): Set<string> {
  return new Set(
    (s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9]+/).filter((w) => w.length >= 4),
  );
}

function blockTitle(b: WorkspaceBlock): string {
  return "title" in b && typeof b.title === "string" ? b.title : "";
}

function hasAlert(b: WorkspaceBlock): boolean {
  return b.kind === "dossier" && Boolean(b.alerte);
}

/**
 * RANGE UN TOUR.
 *
 * Ne lève jamais et ne perd jamais un bloc : un tour dont l'affichage tomberait vaudrait moins
 * qu'un tour mal rangé. Les entrées vides rendent un espace vide, ce qui est une réponse.
 */
export function composeTurn(input: {
  compositions?: WorkspaceComposition[] | null;
  proposals?: TurnProposal[] | null;
  trace?: string[] | null;
  reply?: string | null;
  /** Le tour est-il terminé ? Sert à marquer la dernière phase comme en cours. */
  finished?: boolean;
}): TurnWorkspace {
  const compositions = input.compositions ?? [];
  const proposals = input.proposals ?? [];
  const phases = phasesOf(input.trace ?? [], input.finished !== false);
  const synthesis = (input.reply ?? "").trim();

  // ── 1. RASSEMBLER. Un même objet vu par deux outils ne s'affiche pas deux fois : le PDG le
  //    lirait comme deux choses différentes, et compterait deux fois ce qu'il n'y a qu'une fois.
  const slots: TurnSlot[] = [];
  const seen = new Set<string>();
  for (const c of compositions) {
    for (const block of c.blocks ?? []) {
      const key = `${block.kind}::${blockTitle(block).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // LE BLOC PEUT DIRE QU'IL N'EST PAS LE SUJET (`poids`). Le genre décide par défaut ; un
      // aperçu de sources, qui emprunte la forme d'une file, ne doit pas hériter du poids d'une
      // décision en attente — mesuré au banc live, il passait devant la figure demandée.
      slots.push({ block, proposals: [], weight: block.poids ?? KIND_WEIGHT[block.kind] ?? 10 });
    }
  }

  // ── 2. RATTACHER LES GESTES À LEUR OBJET. C'est ici que « Confirmer et envoyer » cesse
  //    d'errer en bas de page pour venir se poser sous le message qu'il envoie.
  proposals.forEach((p, i) => {
    const target = bestSlotFor(p, slots);
    if (target) target.proposals.push(i);
  });

  // ── 3. PESER. L'ordre suit la décision, jamais l'ordre d'arrivée des outils.
  for (const s of slots) {
    if (hasAlert(s.block)) s.weight += ALERT_BONUS;
    if (s.proposals.some((i) => (proposals[i].state ?? "pending") === "pending")) s.weight += PENDING_BONUS;
    // Un message DÉJÀ ENVOYÉ n'appelle plus de décision : il redescend au rang de CONSTAT, sans
    // quoi il occuperait la tête de page pour ne rien demander. La pénalité le fait passer sous
    // un tableau de contexte (40) et le pose au niveau d'un accusé de réception — ce qu'il est.
    if (s.block.kind === "email" && s.block.statut !== "brouillon") s.weight -= SENT_PENALTY;
  }

  // Tri STABLE : à poids égal, l'ordre d'arrivée est conservé. Sans cela, deux affichages du même
  // tour pourraient différer, ce qui est déroutant sans être utile.
  const ordered = slots
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.weight - a.s.weight || a.i - b.i)
    .map((x) => x.s);

  // ── 4. LES GESTES ORPHELINS retombent sur le bloc de tête. Un bouton sans objet vaut mieux
  //    qu'un bouton invisible ; c'est le pire cas, et il reste utilisable.
  const bound = new Set(ordered.flatMap((s) => s.proposals));
  const orphans = proposals.map((_, i) => i).filter((i) => !bound.has(i));
  if (orphans.length && ordered.length) ordered[0].proposals.push(...orphans);

  const pending = proposals.filter((p) => (p.state ?? "pending") === "pending").length;

  return {
    lead: ordered[0] ?? null,
    rest: ordered.slice(1),
    phases,
    synthesis,
    // §10 : une mission cohérente = une confirmation. Dès qu'il y a plusieurs gestes en attente
    // dans le même tour, ils forment un lot et se confirment ensemble.
    singleConfirmation: pending > 1,
    pending,
  };
}

/** Le meilleur bloc pour un geste — par nature, puis par titre, puis rien. */
function bestSlotFor(p: TurnProposal, slots: TurnSlot[]): TurnSlot | null {
  const affinity = KIND_AFFINITY.find((a) => a.action.test(p.kind))?.block;
  if (affinity) {
    const byKind = slots.filter((s) => s.block.kind === affinity);
    if (byKind.length === 1) return byKind[0];
    if (byKind.length > 1) return byTitle(p, byKind) ?? byKind[0];
  }
  return byTitle(p, slots);
}

function byTitle(p: TurnProposal, slots: TurnSlot[]): TurnSlot | null {
  const want = titleTokens(p.title);
  if (!want.size) return null;
  let best: TurnSlot | null = null;
  let bestScore = 0;
  for (const s of slots) {
    const have = titleTokens(blockTitle(s.block));
    let shared = 0;
    for (const w of want) if (have.has(w)) shared += 1;
    if (shared > bestScore) { bestScore = shared; best = s; }
  }
  return bestScore > 0 ? best : null;
}

/**
 * LE TOUR EST-IL UN ESPACE DE TRAVAIL, OU UNE SIMPLE RÉPONSE ?
 *
 * Cette question a une réponse binaire et c'est voulu : l'UI ne doit pas dessiner un cadre
 * d'espace de travail autour d'une phrase. « Il est 15 h » est une réponse ; on ne l'encadre pas.
 */
export const isWorkspaceTurn = (t: TurnWorkspace): boolean => t.lead !== null;

/**
 * COMBIEN DE BLOCS ON MONTRE AVANT DE REPLIER (§16 — divulgation progressive).
 *
 * Trois : le bloc de tête et deux autres. Au-delà, la page devient un tableau de bord, ce que §15
 * interdit explicitement — « je ne veux pas construire un dashboard géant indépendant ». Le reste
 * reste accessible d'un geste, mais ne s'impose pas.
 */
export const VISIBLE_BEFORE_FOLD = 3;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MÊME OBJET NE S'EMPILE PAS — il change (§21, §22).
 *
 * ── CE QUE ÇA CORRIGE ────────────────────────────────────────────────────────────────────
 *
 * Un brouillon d'e-mail, une mission, une vue 360 traversent plusieurs états. Sans règle, chaque
 * changement pose une NOUVELLE carte dans le fil : à la fin, trois versions du même message y
 * cohabitent et plus personne ne sait laquelle fait foi. C'est le défaut le plus coûteux d'une
 * conversation qui sert d'interface, parce qu'il ne se voit qu'après coup — quand on relit.
 *
 * ── LA RÈGLE, ET SES DEUX LIMITES ────────────────────────────────────────────────────────
 *
 * Un bloc porteur d'un `blockId` déjà repris PLUS BAS dans le fil ne s'affiche plus : la
 * dernière version fait foi, et c'est la seule qu'on lit.
 *
 * 1. Seul un `blockId` EXPLICITE compte. Un bloc sans identité n'est jamais masqué — deux
 *    tableaux qui se ressemblent ne sont pas le même objet, et le supposer effacerait une
 *    réponse à une question qu'on avait bel et bien posée deux fois.
 * 2. On masque l'ANCIEN, jamais le nouveau. Une version qui recule serait un bug ; ici l'ordre
 *    du fil décide, ce qui est la seule chose dont on soit sûr.
 *
 * ── POURQUOI C'EST UNE FONCTION PURE, ET PAS UNE RÈGLE DANS LE COMPOSANT ─────────────────
 *
 * Parce que la preuve doit tenir dans un test unitaire, pas dans une capture d'écran qu'il
 * faudrait relire à chaque changement. Elle prend le fil ENTIER — un bloc ne peut pas savoir
 * seul qu'il a été rejoué trois messages plus bas — et rend le même fil, élagué.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function elaguerFil(
  parTour: readonly (readonly WorkspaceComposition[])[],
): WorkspaceComposition[][] {
  // Premier passage : le RANG de la dernière apparition de chaque identité.
  const dernier = new Map<string, string>();
  parTour.forEach((tour, i) => tour.forEach((c, j) => c.blocks.forEach((b, k) => {
    if (b.blockId) dernier.set(b.blockId, `${i}.${j}.${k}`);
  })));

  // Second passage : on ne garde que la dernière. Les blocs SANS identité passent tous.
  return parTour.map((tour, i) => tour.map((c, j) => ({
    ...c,
    blocks: c.blocks.filter((b, k) => !b.blockId || dernier.get(b.blockId) === `${i}.${j}.${k}`),
  })).filter((c) => c.blocks.length > 0));
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QU'ON A RANGÉ REDEVIENT-IL UN ÉCRAN ? — la porte d'entrée d'un tour RELU.
 *
 * Un tour d'Adam est persisté avec ce qu'il a CONSTRUIT (`AssistantMessage.workspace`), pour
 * qu'en revenant on retrouve son écran et pas seulement sa phrase. La mémoire range du JSON
 * sans le typer — elle ne doit pas dépendre d'une forme d'affichage, sans quoi le jour où le
 * protocole évolue elle refuserait de relire ce qu'elle a écrit. C'est donc ICI qu'on décide
 * si l'on sait rendre ce qui remonte.
 *
 * ── POURQUOI CETTE FONCTION VIT À CÔTÉ D'`elaguerFil` ────────────────────────────────────
 *
 * Parce que c'est `elaguerFil` qui consomme le résultat, et qu'elle parcourt `c.blocks`. Une
 * première version de ce filtre acceptait tout objet : un enregistrement écrit par une autre
 * version du protocole serait arrivé sans `blocks`, et le fil entier serait tombé sur
 * `undefined.forEach` — pas un bloc manquant, la CONVERSATION en écran blanc, au retour, pour
 * une donnée qu'on ne savait pas lire. Un refus à tort coûte plus cher que le défaut qu'on
 * corrige (§118.27), et un écran blanc est le refus le plus cher qui soit.
 *
 * On exige donc EXACTEMENT ce que le rendu consomme, et rien de plus : ce qu'on ne sait pas
 * lire se relit en texte, comme avant. Les deux fonctions sont dans le même fichier pour que
 * le banc puisse les faire se rencontrer — c'est leur rencontre qui est la propriété, pas
 * l'une ou l'autre prise seule (§118.49).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function lireWorkspaceRange(brut: unknown): WorkspaceComposition[] | null {
  if (!Array.isArray(brut) || brut.length === 0) return null;
  const bons = brut.filter((c): c is WorkspaceComposition =>
    !!c && typeof c === "object" && !Array.isArray(c) && Array.isArray((c as { blocks?: unknown }).blocks));
  return bons.length ? bons : null;
}

/**
 * UN TOUR RELU, tel que l'ÉCRAN en a besoin — et pas un octet de plus.
 *
 * L'écran rendait `StoredMessage`, le type de la MÉMOIRE. La raison de ne plus le faire est
 * celle qui vaut déjà dans l'autre sens, écrite en toutes lettres sur `StoredMessage.workspace` :
 * la mémoire ne doit pas dépendre d'une forme d'affichage — elle refuserait de relire ce qu'elle
 * a écrit le jour où le protocole change. La réciproque est vraie et coûte le même prix :
 * l'affichage qui dépend d'une forme de STOCKAGE cesse de compiler le jour où la mémoire ajoute
 * une colonne. Les deux se rencontrent sur ce qui est vrai des deux côtés — un rôle, un texte,
 * et ce qui avait été construit ; `StoredMessage` reste compatible par sa STRUCTURE, sans que
 * personne n'importe l'autre.
 *
 * Ce que ce type n'est PAS : la réparation d'un franchissement de frontière. Je l'ai d'abord
 * cru et écrit — le cliquet est passé de 428 à 429 dans le même lot — puis mesuré : le
 * franchissement venait d'un `import { Prisma }` ajouté pour UNE conversion de type dans
 * `assistant-memory.ts`, et il a été retiré là-bas. Le type reste pour son mérite propre, et la
 * mesure reste écrite ici : une cause plausible qu'on n'a pas vérifiée est plus tenace qu'une
 * cause absente (§118.76).
 */
export interface TourRelu {
  role: "user" | "assistant";
  content: string;
  /** Ce qu'Adam avait construit — `unknown` : c'est `lireWorkspaceRange` qui décide. */
  workspace?: unknown;
}
