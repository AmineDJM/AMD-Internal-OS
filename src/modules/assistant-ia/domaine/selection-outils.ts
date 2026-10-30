/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES OUTILS CHOISIS À LA DEMANDE (lot J4, décision 0018) — règle PURE, zéro import.
 *
 * MESURÉ (banc Jarvis, 29/10) : les définitions des 65 outils du Super Admin pèsent ~18 700 jetons, renvoyés à
 * CHAQUE étape — l'entrée d'un appel est passée de ~10 k à ~23 k jetons, le premier mot de 4,2 s à 5,5 s (P50).
 * Le modèle n'a besoin, pour une demande, que de quelques-uns d'entre eux.
 *
 *   • un SOCLE toujours offert (≈ 10 outils légers : l'annuaire, la recherche, la Bibliothèque, ce qui m'attend,
 *     la mémoire, et `trouver_outil`) ;
 *   • une PRÉSÉLECTION par la demande elle-même (plein texte français, 0 ms — un modèle léger coûtait 1 à 2,5 s
 *     mesurées pour le même classement) ;
 *   • `trouver_outil(intention)` : le modèle cherche lui-même dans les fiches quand rien de visible ne couvre la
 *     demande ; les outils trouvés s'ajoutent pour la suite du tour.
 *
 * TOUT SE CHERCHE DANS LES FICHES DÉJÀ FILTRÉES PAR LES DROITS (`allowed`, configuration du rôle) : un outil hors
 * droits n'est pas une fiche, il ne peut être ni présélectionné ni trouvé. Les familles de la console restent
 * jugées à l'exécution (l'outil refuse en nommant la famille) — rien de la garde ne change.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface FicheOutil {
  nom: string;
  libelle: string;
  description: string;
  /** Les mots d'une CAPACITÉ (J6, dérivés : libellé, module, synonymes) — pesés comme un libellé. */
  mots?: string;
  /** Son contexte (fichier, champs) — pesé comme une description : il départage, il ne désigne pas. */
  contexte?: string;
}

export interface OutilClasse {
  nom: string;
  score: number;
}

export const OUTIL_TROUVER = "trouver_outil";

/** Toujours offerts (s'ils sont dans les droits) — dans CET ordre, pour un préfixe stable d'un appel à l'autre. */
export const SOCLE_OUTILS: readonly string[] = [
  OUTIL_TROUVER, "directory_lookup", "search_everything", "chercher_documents", "ouvrir_documents",
  "list_pending_decisions", "my_overview", "list_my_tasks", "lire_document", "proposer_memoire",
];

/** La présélection par la demande ; `trouver_outil` en rend au plus `TROUVES_MAX`. */
export const PRESELECTION_MAX = 6;
export const TROUVES_MAX = 8;

/**
 * LES MOTS DE LA PERSONNE, outil par outil — ce que les descriptions (écrites pour le modèle) ne disent pas avec les
 * mots d'une demande. Pondérés plus fort que la description.
 */
const MOTS_CLES: Record<string, string> = {
  directory_lookup: "qui est personne collegue telephone email mail coordonnees poste fonction manager responsable joindre numero contact",
  directory_list: "liste collaborateurs salaries equipe service departement effectif membres annuaire tous",
  regulatory_knowledge: "cadre reglementaire anpp droits enregistrement bordereau loi decret procedure tarif redevance",
  regulatory_workload: "charge dossiers combien gere porte qui assigne portefeuille personne regulatory",
  regulatory_portfolio: "portefeuille partenaire laboratoire produits statuts regulatory kwality",
  list_my_tasks: "mes taches todo a faire rappels en cours retard",
  search_products: "produit dci marque catalogue regulatory recherche medicament molecule",
  read_workflow: "circuit validation etapes qui valide sponsoring congres evenement ad pro processus",
  list_my_requests: "mes demandes administratives deplacement courrier signature achat",
  my_overview: "apercu resume espace travail tableau de bord synthese journee",
  read_hr_overview: "situation rh effectif masse salariale conges absences ressources humaines",
  search_everything: "cherche trouve recherche partout erp reference drive fichier dossier chemin nom",
  read_calendar: "agenda calendrier rendez vous reunion planning semaine demain aujourd hui disponibilite",
  read_budget: "budget enveloppe reste restant consomme alloue disponible",
  finance_totals: "total paye encaisse depenses montant finances combien argent somme paiements",
  list_pending_decisions: "attend validation decision a valider en attente ma signature approuver trancher",
  lire_fiche_rh: "fiche rh poste contrat responsable manager anciennete embauche conges solde n+1 superieur",
  lire_paie: "salaire paie remuneration brut net bulletin cout employeur gagne",
  documents_rh: "contrat travail avenant attestation bulletins documents rh dossier rh telecharger word",
  demandes_adpro: "demandes ad pro sponsoring prises en charge evenements materiel annee rapport analyse toutes",
  etat_dossier_reglementaire: "ou en est dossier reglementaire etat statut reserves echeance anpp avancement",
  mes_conversations: "conversations messages messagerie non lus discussion",
  mes_demandes_en_attente: "mes demandes en attente validation relance depuis quand",
  mes_brouillons: "brouillons commence pas fini inacheve",
  lire_devis_facture: "devis facture bon commande lire montant fournisseur ttc",
  lire_document: "lire resume resumer document pdf word excel image contenu dit",
  comparer_versions: "comparer versions difference changements deux",
  lire_formulaire_pdf: "formulaire pdf champs remplir",
  lire_dossier_depose: "dossier depose classe classer fichiers module ctd pieces manquent manquantes section dossier glisse lecture",
  mes_routines: "mes routines programmees briefing",
  web_research: "web internet actualite marche externe prix public congres etranger concurrent",
  send_message: "envoie message ecris dis previens collegue",
  preparer_sponsoring: "sponsoring sponsoriser medecin congres demande",
  preparer_prise_en_charge: "prise en charge congres national international medecin inscription",
  preparer_evenement: "evenement seminaire soiree organiser ad pro",
  preparer_materiel_promo: "materiel promotionnel goodies stylos kits objets",
  preparer_demande_autre: "demande ad pro autre achat kits",
  preparer_poste: "poste cout stand hotellerie billetterie traiteur salle imprimerie ajoute",
  preparer_bon_de_commande: "bon commande bc validation fournisseur",
  preparer_bc_depuis_devis: "bon commande depuis devis lignes composer",
  preparer_voyageur_passeport: "passeport voyageur billet billetterie ajoute",
  preparer_relance: "relance validateur relancer rappeler",
  preparer_depot_piece: "depose piece justificatif joindre demande",
  preparer_rendez_vous: "rendez vous reunion agenda planifie fixe invite",
  preparer_reponse_message: "repondre message reponse conversation",
  preparer_document: "lettre note compte rendu word redige prepare remerciement courrier",
  preparer_traduction: "traduis traduction anglais arabe francais",
  preparer_formulaire_pdf: "remplis formulaire pdf",
  // J8 (décision 0023) : la délégation des travaux, côté de la personne sollicitée.
  mes_demandes_recues: "demandes recues on me demande collegue attend ma reponse question piece a fournir delegation travail echeance",
  preparer_reponse_demande: "repondre demande collegue reponse envoyer piece fournir joindre delegation travail",
  programmer_routine: "chaque tous les matins dimanche lundi semaine mois heure programme routine regulierement",
  gerer_routine: "pause reprends supprime routine execute",
  proposer_memoire: "retiens souviens memoire rappelle toi",
  // Décision 0027 — la mémoire des conversations passées (« comme on avait dit pour le congrès d'Oran »).
  chercher_conversations: "conversation precedente passee avait dit discute evoque parle derniere fois semaine derniere comme on avait convenu",
  lancer_un_travail: "analyse toutes rapport complet annee travail long lot chaque plusieurs etapes synthese demande a attends sa reponse relance escalade echeance",
  chercher_documents: "document retrouve cherche note compte rendu parle contenu bibliotheque piece qui mentionne",
  ouvrir_documents: "ouvre affiche montre document lis texte",
  faits_confirmes: "faits confirmes fiche referentiel organisation fournisseur adresse identite verifie",
  // J9 — le graphe de l'entreprise et les faits datés (fiches, pas socle : la sélection les trouve à la demande).
  explorer_relations: "depend dependent relie lien liens relation relations graphe reseau chemin qui travaille travaillent sur fournisseur dossier tombe impacte touche quels documents parlent concernent mentionnent lies a autour",
  etat_a_une_date: "etat date epoque etait a l epoque au moment le historique avant ancienne ancien valeur passee autrefois quelle etait qui etait responsable en mars janvier capital forme juridique siege raison sociale actuelle actuel aujourd hui",
  d_ou_vient: "d ou vient provenance source origine qui a confirme justifie piece prouve preuve vient cette information ce chiffre fiable",
  // J10 — les recettes de la maison (fiche, pas socle) : « comment on fait chez nous » un circuit, et le plan qui en est tiré.
  recette_pour: "comment fait on chez nous recette procedure processus habitude habituellement etapes circuit qui valide pieces faut combien temps delai prise charge sponsoring evenement recrutement validation plan lance prepare organise",
  // J3 — l'Atelier : les mots d'une personne qui veut voir ou retoucher SON document (joint, renvoyé, trouvé).
  ouvrir_dans_l_atelier: "atelier ouvre affiche montre document word powerpoint presentation diapositive excel classeur pdf piece jointe modifie modifier remplace mets change corrige",
  modifier_document: "modifie modifier remplace mets change corrige reecris ajoute supprime diapositive slide titre paragraphe cellule tableau periode clause article synthese en place document",
  convertir_document: "convertis convertir conversion pdf word excel exporte transforme en",
  enregistrer_document: "enregistre sauvegarde nouvelle version garde valide document atelier",
  // J13 (décision 0025) — le terrain : les mots d'un délégué qui sort d'une visite.
  terrain_compte_rendu: "compte rendu visite rapport terrain medecin docteur dr pr cabinet chu hopital clinique vu rencontre presente interesse objection",
  terrain_demande_materiel: "echantillons echantillon boites materiel promotionnel brochures magasin demande stock delegue",
  terrain_tournee_demain: "tournee demain revoir repasser plan de tournee visite prevue ajoute medecin",
  terrain_piece_visite: "photo rattache joins piece compte rendu visite ordonnance presentoir carte de visite",
  // « Mes notes » (décision 0026) — le bloc-notes privé : offert seulement quand la demande en parle.
  lire_notes: "notes note bloc liste reste faire semaine page pages relis lis mes notes todo cases cochees noter",
  ajouter_note: "ajoute note notes noter liste bloc ligne puce case inscris rajoute semaine page ma page dans",
  modifier_note: "modifie corrige change remplace reecris ligne note notes liste",
  cocher_note: "coche cocher decoche fait termine barre case ligne note notes liste page",
  deplacer_note: "deplace bouge remonte descend range ligne note notes liste section",
  supprimer_note: "supprime retire efface enleve raye ligne note notes liste page",
  creer_page: "page nouvelle cree fais notes bloc",
  renommer_page: "renomme page nom appelle notes",
};

const MOTS_VIDES = new Set((
  "a au aux avec ce ces cet cette d de des du elle en est et il ils je j l la le les leur leurs lui ma me mes moi mon "
  + "n ne nous on ou par pas pour qu que quel quelle quels quelles qui sa se ses si son sur ta te tes toi ton tu un une "
  + "vos votre vous y s t c m est sont ai as avez avons ont fait faire peux peut veux voudrais donne donner moi stp svp "
  + "merci bonjour dans sans plus tout tous toute toutes the"
).split(" "));

/** Minuscules, sans accents, sans ponctuation — « Règlement » et « reglement » se rejoignent. */
export function plier(t: string): string {
  return t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9+]+/g, " ").trim();
}

/** La racine : six lettres au plus, le pluriel ôté — « salaires » et « salaire » donnent « salair ». */
export function racine(mot: string): string {
  // Les verbes en -yer (« renvoie » / « renvoyer », « envoie » / « envoyer ») se rejoignent sur leur radical.
  const m0 = mot.length > 3 ? mot.replace(/(s|x)$/, "") : mot;
  const m = m0.replace(/oie$/, "oye").replace(/(?<=.{4})ir$/, "i");
  // L'infinitif et l'impératif se rejoignent (« créer » / « crée », « supprimer » / « supprime ») — J6 : les libellés des
  // capacités sont à l'infinitif, les demandes à l'impératif.
  return (m.length > 4 && m.endsWith("er") ? m.slice(0, -1) : m).slice(0, 6);
}

export function termes(t: string): string[] {
  return plier(t).replace(/_/g, " ").split(" ").filter((m) => m.length > 1 && !MOTS_VIDES.has(m)).map(racine);
}

const POIDS = { cles: 3, nom: 2, libelle: 2, description: 1 } as const;
/** Le premier mot de la demande, et le verbe du libellé qui lui répond (J6, réglés sur les deux corpus de référence). */
const PREMIER_MOT = 1.4;
const MEME_VERBE = 1.2;

/** Les verbes d'un GESTE : ils poussent les outils qui préparent une carte. */
const GESTE = /\b(cree|creer|prepare|preparer|ajoute|ajouter|envoie|envoyer|programme|planifie|organise|redige|remplis|modifie|depose|relance|confie|ouvre un|lance)\b/;
// Un geste : un outil qui prépare une carte — ou une CAPACITÉ (J6, `fichier__fonction`) qui n'est pas une lecture.
// « Mes notes » (décision 0026) : ajouter, cocher… une note est un geste (proposé, puis accepté par la personne).
const estGeste = (nom: string) => /^(preparer_|create_|update_|send_|assign_|set_|request_regulatory|programmer_|gerer_)|_operation$|^(ajouter|modifier|cocher|deplacer|supprimer)_note$|^(creer|renommer)_page$/.test(nom)
  || /__(?!(get|list|lister|lire|read|search|chercher|apercu|preview|previsualiser|verifier|check|compter|browse))/.test(nom);

interface Index {
  /** `tete` : le premier mot du libellé — le verbe d'une capacité (« Créer », « Supprimer »). */
  fiches: { nom: string; poids: Map<string, number>; tete: string | undefined }[];
  idf: Map<string, number>;
}

/**
 * LES POIDS D'UNE FICHE, gardés d'un tour à l'autre (J6) : avec les capacités, un catalogue compte ~1 000 fiches, et les
 * découper à chaque tour coûtait ~150 ms avant le premier mot. Une fiche est un texte fixe — la clé est ce texte, pas
 * la personne : deux personnes qui ont la même fiche ont les mêmes poids (les droits décident de la LISTE, pas des poids).
 */
const POIDS_DES_FICHES = new Map<string, { poids: Map<string, number>; tete: string | undefined }>();
const POIDS_MAX_GARDES = 5_000;

function poidsDe(f: FicheOutil): { poids: Map<string, number>; tete: string | undefined } {
  const cle = `${f.nom}\u0000${f.libelle}\u0000${f.description}\u0000${f.mots ?? ""}\u0000${f.contexte ?? ""}`;
  const garde = POIDS_DES_FICHES.get(cle);
  if (garde) return garde;
  const poids = new Map<string, number>();
  const poser = (texte: string, p: number) => {
    for (const m of termes(texte)) poids.set(m, Math.max(poids.get(m) ?? 0, p));
  };
  poser(f.description, POIDS.description);
  poser(f.libelle, POIDS.libelle);
  poser(f.nom, POIDS.nom);
  poser(f.contexte ?? "", POIDS.description);
  poser(f.mots ?? "", POIDS.libelle);
  poser(MOTS_CLES[f.nom] ?? "", POIDS.cles);
  const lu = { poids, tete: termes(f.libelle)[0] };
  if (POIDS_DES_FICHES.size >= POIDS_MAX_GARDES) POIDS_DES_FICHES.clear();
  POIDS_DES_FICHES.set(cle, lu);
  return lu;
}

export function indexer(fiches: readonly FicheOutil[]): Index {
  const df = new Map<string, number>();
  const out = fiches.map((f) => {
    const { poids, tete } = poidsDe(f);
    for (const m of poids.keys()) df.set(m, (df.get(m) ?? 0) + 1);
    return { nom: f.nom, poids, tete };
  });
  const n = Math.max(1, fiches.length);
  const idf = new Map([...df].map(([m, d]) => [m, Math.log(1 + n / d)]));
  return { fiches: out, idf };
}

/** Les outils, du plus utile au moins utile pour CETTE demande — score nul écarté. */
export function classer(demande: string, fiches: readonly FicheOutil[] | Index, k = TROUVES_MAX): OutilClasse[] {
  const idx = Array.isArray(fiches) ? indexer(fiches) : (fiches as Index);
  const q = [...new Set(termes(demande))];
  if (!q.length) return [];
  const geste = GESTE.test(plier(demande));
  // LE PREMIER MOT est le plus souvent le geste demandé (« Crée une tâche pour Walid : relancer le fournisseur… ») :
  // il pèse plus que les mots du CONTENU qui le suivent (J6 — mesuré sur le corpus des capacités).
  const premier = q[0];
  return idx.fiches
    .map((f) => {
      let s = 0;
      for (const m of q) s += (f.poids.get(m) ?? 0) * (idx.idf.get(m) ?? 0) * (m === premier ? PREMIER_MOT : 1);
      // Le geste demandé EST le verbe du libellé (« Crée une tâche… » → « Créer tâche ») : la capacité qui le porte passe devant.
      if (s > 0 && f.tete && f.tete === premier) s *= MEME_VERBE;
      if (s > 0 && geste && estGeste(f.nom)) s *= 1.35;
      if (s > 0 && !geste && estGeste(f.nom)) s *= 0.8;
      return { nom: f.nom, score: Math.round(s * 100) / 100 };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.nom.localeCompare(b.nom))
    .slice(0, k);
}

/**
 * LES OUTILS ACTIFS d'une étape : le socle (dans son ordre), puis les autres dans l'ordre alphabétique — la liste ne
 * dépend pas de l'ordre où ils ont été trouvés. (Le SDK, lui, les envoie dans l'ordre où ils sont ENREGISTRÉS — le
 * catalogue, stable aussi : deux tours qui offrent les mêmes outils envoient le même préfixe.)
 */
export function ordonnerActifs(actifs: Iterable<string>, disponibles: ReadonlySet<string>): string[] {
  const a = new Set([...actifs].filter((n) => disponibles.has(n)));
  const socle = SOCLE_OUTILS.filter((n) => a.has(n));
  return [...socle, ...[...a].filter((n) => !SOCLE_OUTILS.includes(n)).sort()];
}

/** Ce que la question PRÉCÉDENTE apporte à la présélection : une relance courte (« au nom d'Adventum ») n'a pas de mot du métier. */
export const HERITES_MAX = 3;

/**
 * La présélection d'un tour : le socle disponible, les meilleurs outils pour la demande, et quelques-uns de ceux de la
 * question précédente (MESURÉ au banc : sans eux, « Au nom d'Adventum Pharma. » passait par `trouver_outil`, une étape de plus).
 */
export function preselectionner(
  demande: string, fiches: readonly FicheOutil[], k = PRESELECTION_MAX, precedente = "", poids?: (nom: string) => number,
): string[] {
  const disponibles = new Set(fiches.map((f) => f.nom));
  const herites = precedente ? classer(precedente, fiches, HERITES_MAX).map((c) => c.nom) : [];
  const candidats = [...classer(demande, fiches, k).map((c) => c.nom), ...herites];
  const retenus = poids ? dansLeBudget(SOCLE_OUTILS.filter((n) => disponibles.has(n)), candidats, poids) : candidats;
  return ordonnerActifs([...SOCLE_OUTILS, ...retenus], disponibles);
}

/**
 * LE BUDGET FIXE D'UNE ÉTAPE (J6, décision 0020 : ≤ 4 000 jetons d'outils, `trouver_outil` compris — d'où la marge).
 * Le socle passe toujours ; les candidats entrent dans l'ordre du classement tant qu'ils tiennent — un schéma trop
 * lourd cède sa place au suivant, et reste à portée de `trouver_outil`. Mesuré : quatre pièces commerciales et une
 * facture (≈ 700 jetons chacune) dépassaient le budget sur « émets une facture ».
 */
export const BUDGET_JETONS_FIXES = 3_800;

function dansLeBudget(socle: readonly string[], candidats: readonly string[], poids: (nom: string) => number): string[] {
  let total = socle.reduce((s, n) => s + poids(n), 0);
  const retenus: string[] = [];
  for (const n of candidats) {
    if (socle.includes(n) || retenus.includes(n)) continue;
    const p = poids(n);
    if (total + p > BUDGET_JETONS_FIXES) continue;
    total += p;
    retenus.push(n);
  }
  return retenus;
}

/** Ce que le contexte dit au modèle de cette mécanique (une ligne, stable). */
export const CONSIGNE_SELECTION =
  "OUTILS : tu ne vois qu'une partie de tes outils. Si aucun outil visible ne couvre la demande, appelle d'abord "
  + `${OUTIL_TROUVER} avec l'intention en quelques mots (« lire le salaire d'une personne », « créer un dossier réglementaire ») : `
  + "les outils trouvés deviennent disponibles à l'étape suivante. Ne dis jamais qu'un outil te manque sans l'avoir cherché.";
