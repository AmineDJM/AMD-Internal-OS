import { motsDistinctifs } from "./cible-designee";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE PROPOSITION QUE LA PERSONNE A DÉPASSÉE NE DOIT PLUS ÊTRE CLIQUABLE.
 *
 * ── LE DÉFAUT, MESURÉ DANS LE VRAI CHAT ─────────────────────────────────────────────────
 *
 * Scène jouée par le banc live (`CHANGEMENT DE SCOPE`) :
 *
 *   Tour 1 — « Crée une tâche pour Raihana : vérifier l'étiquetage bilingue Nivolex,
 *             échéance vendredi. »              → une carte à confirmer.
 *   Tour 2 — « Non, finalement pas Raihana : c'est Amel Haddad, et l'échéance c'est lundi. »
 *                                               → une SECONDE carte.
 *
 * Les deux cartes restaient à l'écran, et les DEUX étaient exécutables. Un clic sur la
 * première a créé la tâche que le PDG venait d'annuler : Raihana, vendredi. Pas un doublon —
 * la MAUVAISE tâche, attribuée à la mauvaise personne, avec la mauvaise échéance, et un reçu
 * qui dit « fait ».
 *
 * C'est la même famille que « Corrige ça » devenu « ANNULER le devis DEV-2026-0038 » : un
 * geste d'écriture dont la CIBLE ne vient plus de ce que la personne a dit.
 *
 * ── POURQUOI CE N'EST PAS UNE TABLE DE PHRASES ──────────────────────────────────────────
 *
 * On pourrait chercher « non », « finalement », « plutôt ». Ce serait une liste sans fin, fausse
 * dans les deux sens, et muette sur « Amel plutôt, et lundi » qui ne contient aucun de ces mots.
 *
 * La règle ici ne lit pas la PHRASE, elle lit les DEUX PROPOSITIONS. Deux écritures de même
 * NATURE (`kind`) portant sur le même SUJET ne peuvent pas être toutes deux voulues : les
 * exécuter toutes les deux crée un doublon, et n'en exécuter qu'une laisse le hasard du clic
 * décider laquelle. La plus RÉCENTE est celle que la personne vient d'énoncer ; c'est elle qui
 * fait foi (§11 : « la contrainte que la personne vient d'énoncer » ne se coupe jamais).
 *
 * ── CE QUI DOIT SURVIVRE, ET QUI COMPTE AUTANT ──────────────────────────────────────────
 *
 * « Crée une tâche pour Raihana sur l'étiquetage » puis « et une pour Amel sur le CPP » sont
 * DEUX demandes. Elles partagent la nature mais pas le sujet, et retirer la première ferait
 * perdre du travail — le défaut inverse, aussi coûteux. Le sujet décide, pas l'ordre d'arrivée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce qu'il faut savoir d'une proposition pour dire si une autre la remplace. */
export interface PropositionComparable {
  id: string;
  /** La NATURE de l\'écriture (`create_task`, `send_email`…). Deux natures différentes ne se remplacent jamais. */
  kind: string;
  /** Le titre de la carte — ce que la personne LIT avant de cliquer. */
  title: string;
  /** Le résumé mémorisable (cible + objet), quand il existe : il porte souvent le sujet mieux que le titre. */
  summary?: string | null;
  /**
   * F2 (banc réel du 02/11, TR-LO-01) — L'OBJET de la carte, quand la charge le nomme (le titre d'une tâche, l'objet d'un
   * mail) : il identifie la chose MIEUX que le résumé, qui recopie le contexte de la conversation. Mesuré : « Envoyer les
   * échantillons — AO oncologie CHU Mustapha » et « Relancer le pharmacien chef du CHU Mustapha » partageaient, par leur
   * DESCRIPTION, « appel d'offres oncologie CHU Mustapha » — la seconde retirait la première, toujours valable.
   */
  objet?: string | null;
}

/** Les champs d'une charge qui NOMMENT son objet (dans l'entrée d'une capacité, ou la charge elle-même). */
const CHAMPS_OBJET = ["title", "titre", "objet", "subject", "sujet", "name", "nom", "libelle"] as const;

/** L'objet d'une carte, lu sur sa charge — `null` si elle ne le nomme pas (le résumé décide alors, comme avant). */
export function objetDeLaCharge(payload: unknown): string | null {
  const o = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  if (!o) return null;
  for (const lieu of [o.entree, o]) {
    const l = lieu && typeof lieu === "object" ? (lieu as Record<string, unknown>) : null;
    const v = l ? CHAMPS_OBJET.map((k) => l[k]).find((x) => typeof x === "string" && x.trim()) : undefined;
    if (typeof v === "string") return v.trim().slice(0, 300);
  }
  return null;
}

/**
 * COMBIEN DE MOTS DISTINCTIFS COMMUNS FONT « LE MÊME SUJET ».
 *
 * Deux, et pas un : un seul mot commun (« Nivolex ») rapproche deux demandes qui parlent du même
 * produit sans porter sur la même chose — « prépare le dossier Nivolex » et « relance l\'ANPP sur
 * Nivolex » sont deux travaux distincts. Deux mots communs sur des étiquettes courtes, c\'est déjà
 * la même phrase à un détail près.
 */
export const MOTS_COMMUNS_MIN = 2;

/**
 * ... SAUF QUAND LES ÉTIQUETTES SONT TROP MAIGRES POUR EN PORTER DEUX.
 *
 * « Modifier le devis » n\'a qu\'un mot distinctif. Exiger deux communs rendrait la règle
 * inapplicable là où le risque est le plus grand — deux propositions vagues de même nature. Sous
 * ce seuil, un seul mot commun suffit, et si aucune des deux n\'a de mot distinctif du tout, la
 * seule NATURE partagée tranche : deux écritures anonymes de même nature sont la même.
 */
const ETIQUETTE_MAIGRE = 2;

/** Le sujet d\'une proposition : titre et résumé confondus, réduits à ce qui identifie. */
export function sujetDe(p: PropositionComparable, parObjet = true): string[] {
  return motsDistinctifs(parObjet && p.objet?.trim() ? p.objet : `${p.title} ${p.summary ?? ""}`);
}

/**
 * LA NOUVELLE PROPOSITION REMPLACE-T-ELLE L\'ANCIENNE ?
 *
 * Jamais entre deux natures différentes. Jamais entre deux sujets distincts. Le doute profite à
 * la CONSERVATION : on ne retire que ce qu\'on sait remplacé.
 */
export function remplace(nouvelle: PropositionComparable, ancienne: PropositionComparable): boolean {
  if (nouvelle.id === ancienne.id) return false;
  if (nouvelle.kind !== ancienne.kind) return false;
  const a = sujetDe(nouvelle);
  const b = sujetDe(ancienne);
  const communs = a.filter((m) => b.includes(m)).length;
  const maigre = a.length < ETIQUETTE_MAIGRE || b.length < ETIQUETTE_MAIGRE;
  if (a.length === 0 && b.length === 0) return true; // deux écritures anonymes de même nature
  return communs >= (maigre ? 1 : MOTS_COMMUNS_MIN);
}

/**
 * LES PROPOSITIONS EN ATTENTE QUE CE NOUVEAU LOT REND CADUQUES.
 *
 * Rend des identifiants, pas des objets : l\'appelant écrit en base, et ce module ne connaît ni
 * Prisma ni le RBAC. Il se teste sans réseau, ce qui est la raison d\'être de sa forme.
 */
export function propositionsPerimees(
  nouvelles: PropositionComparable[],
  enAttente: PropositionComparable[],
): string[] {
  const morts = new Set<string>();
  for (const ancienne of enAttente) {
    if (nouvelles.some((n) => remplace(n, ancienne))) morts.add(ancienne.id);
  }
  return [...morts];
}

/**
 * LA NATURE QUI SE COMPARE — et pas toujours le `kind` brut.
 *
 * Tous les gestes de l\'Assistant IA partagent UN `kind` (`assistant_ia_op`) : comparés sur lui seul, une
 * relance et un rendez-vous sur le même dossier (« SP-0142 Karim ») se « remplaceraient ». Leur vraie
 * nature est l\'opération qu\'ils portent (`payload.op`) — c\'est elle que `remplace` doit voir
 * (audit 27/10, IA-ASSISTANT-10).
 */
export function natureComparable(kind: string, payload: unknown): string {
  // F2 : toutes les CAPACITÉS (J6) partagent aussi un `kind` — leur nature est l'action qu'elles portent (`payload.id`).
  const cle = kind === "assistant_ia_op" ? "op" : kind === "assistant_ia_capacite" ? "id" : null;
  if (!cle) return kind;
  const v = (payload as Record<string, unknown> | null)?.[cle];
  return typeof v === "string" && v ? `${kind}:${v}` : kind;
}

/**
 * F2 (TR-LO-01) — UNE QUESTION SUR UNE CARTE NE LA CHANGE PAS. « Rappelle-moi ce qu'on vient de préparer pour cet appel
 * d'offres » reprenait le sujet des deux cartes en attente : elles étaient retirées avant même que le modèle réponde, et
 * le clic « Confirmer » tombait sur « annulée ». On ne lit pas ici des mots de correction : on reconnaît l'ACTE de parole —
 * une question (« ? », mot interrogatif en tête) ou un rappel (« rappelle-moi », « résume », « montre ») ne corrige rien.
 */
export function estQuestionOuRappel(message: string): boolean {
  const t = (message ?? "").trim();
  if (/\?\s*$/.test(t)) return true;
  const n = t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/^(?:et|alors|au fait|dis|bon)[\s,]+/, "");
  return /^(?:rappelle|redis|repete|resume|recapitule|montre|affiche|liste|relis|dis[- ]moi|qu['’ ]|quel|quand|ou en|ou est|comment|combien|pourquoi|qui |est[- ]ce|c['’ ]est quoi|a quoi)/.test(n);
}

/**
 * C1 (décision 0068) — L'ACTE DE CORRIGER. Mesuré en vrai navigateur (04/11) : un ACCORD sur la carte (« ok pour la tâche de
 * relance Nivolex, je la valide tout à l'heure ») reprenait son sujet et la retirait en silence. Une carte ne se retire sur
 * un message que si ce message CHANGE quelque chose : il la contredit en tête (« non… », « pas Raihana… », « en fait… »),
 * dit qu'il revient dessus (« finalement », « plutôt », « au lieu de », « à la place de »), ou demande de la modifier
 * (« change », « modifie », « remplace », « corrige », « décale », « repousse », « reporte », « avance »). Le doute profite à
 * la CONSERVATION : une correction manquée laisse une carte que la personne voit et ignore d'un geste ; un retrait à tort
 * lui retire un bouton qu'elle attendait.
 */
export function estCorrection(message: string): boolean {
  const n = (message ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[’']/g, " ").trim();
  if (/^(?:(?:et|bon|ah|oh|euh|alors)[\s,]+)?(?:non|nan|pas |en fait|attends?)\b/.test(n)) return true;
  return /\b(?:finalement|plutot|au lieu d|a la place d|change[rsz]?|modifie[rsz]?|remplace[rsz]?|corrige[rsz]?|rectifie[rsz]?|decale[rsz]?|repousse[rsz]?|reporte[rsz]?|avance[rsz]?|c est pas|ce n est pas|ce sera pas)\b/.test(n);
}

/** L\'échappatoire d\'exploitation, comme pour les autres règles d\'écriture (§2 : la limite porte sa raison). */
export function retraitDesPerimeesDesactive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ADAM_PERIMEES_DISABLED === "1";
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CAS PIRE, ET CELUI QUE LE BANC A RÉELLEMENT TROUVÉ : AUCUNE NOUVELLE PROPOSITION.
 *
 * Le journal des intentions du tour fautif ne contient qu\'UNE ligne. Au tour 2 — « Non,
 * finalement pas Raihana : c\'est Amel Haddad, et l\'échéance c\'est lundi » — Adam a répondu en
 * TEXTE et n\'a rien proposé. Rien ne remplaçait donc rien, la carte du tour 1 est restée, et le
 * clic a créé la tâche annulée.
 *
 * `remplace` ne pouvait pas voir ce cas : il compare deux propositions, et il n\'y en avait
 * qu\'une. La règle ci-dessous compare la proposition en attente au MESSAGE de la personne.
 *
 * ── LE RAISONNEMENT, ET POURQUOI IL N\'EST PAS UNE LISTE DE PHRASES ──────────────────────
 *
 * On ne cherche ni « non », ni « finalement », ni « plutôt » : ces mots manquent à « Amel plutôt,
 * et lundi » comme à « c\'est Amel qui s\'en charge ». On regarde une seule chose, structurelle :
 * la personne PARLE-T-ELLE ENCORE DE CETTE ACTION ? Si son message reprend le sujet de la carte
 * en attente et que le tour n\'a rien reproposé, alors ce qui est affiché ne correspond plus à ce
 * qu\'elle vient de dire — et un clic exécuterait l\'avant-dernière version de sa pensée.
 *
 * Le défaut inverse est borné par la même mesure : un message qui parle d\'autre chose (« au fait,
 * où en est Nivolex ? ») ne partage pas le sujet, et la carte survit intacte.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function messageRendCaduque(enAttente: PropositionComparable, message: string): boolean {
  if (estQuestionOuRappel(message)) return false;
  // C1 (décision 0068) : reparler d'une carte n'est pas la corriger. « Ok pour la tâche de relance Nivolex, je la valide
  // tout à l'heure » partageait le sujet — la carte était retirée en silence, et Adam répondait qu'elle attendait encore.
  if (!estCorrection(message)) return false;
  // Le MESSAGE se juge sur tout ce que la carte affiche (la personne corrige souvent un destinataire, une date du résumé).
  const sujet = sujetDe(enAttente, false);
  if (sujet.length === 0) return false; // une carte sans sujet identifiable ne se juge pas ainsi
  const mots = motsDistinctifs(message);
  const communs = sujet.filter((m) => mots.includes(m)).length;
  // Le même seuil que `remplace`, et pour la même raison : un mot commun rapproche deux sujets
  // voisins, deux mots communs désignent la même chose.
  return communs >= Math.min(MOTS_COMMUNS_MIN, sujet.length);
}

/**
 * LES CARTES QU\'UN NOUVEAU MESSAGE REND CADUQUES, quand le tour n\'a rien reproposé.
 *
 * `dejaRemplacees` sont celles dont on s\'occupe déjà par `propositionsPerimees` : les compter
 * deux fois ne changerait rien, mais l\'appelant lit une liste et doit pouvoir la croire.
 */
export function caduquesParMessage(
  enAttente: PropositionComparable[],
  message: string,
  dejaRemplacees: string[] = [],
): string[] {
  const vues = new Set(dejaRemplacees);
  return enAttente.filter((p) => !vues.has(p.id) && messageRendCaduque(p, message)).map((p) => p.id);
}

/**
 * F2 (banc réel du 02/11, AN-ANNULER-03) — « ANNULE CETTE DEMANDE », DIT À UNE CARTE QUI ATTEND. L'assistant répondait « si
 * vous ne l'avez pas confirmée, fermez-la » : c'était à la personne de retirer la carte. Un ordre d'annulation COURT, sans
 * autre objet (« annule », « annule cette demande », « laisse tomber », « non, oublie »), vise la DERNIÈRE carte proposée :
 * le serveur la retire lui-même. Un ordre qui nomme autre chose (« annule le mail envoyé à Karim ») n'est pas lu ici.
 */
export function annuleLaCarte(message: string): boolean {
  const n = (message ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[’']/g, " ").replace(/[.!…]+\s*$/, "").trim();
  if (n.split(/\s+/).length > 7) return false;
  return /^(?:(?:non|bon|finalement|en fait)[\s,]+)?(?:annule[sz]?|annuler|laisse tomber|oublie|on oublie|abandonne|ne fais rien|n en fais rien|retire)(?:[\s-]+(?:la|le|ca|cela|tout|la demande|cette demande|cette carte|la carte|cette tache|ce mail|ce message|stp|s il te plait|s il vous plait|finalement))*$/.test(n);
}
