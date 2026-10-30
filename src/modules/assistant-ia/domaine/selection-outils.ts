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
  search_everything: "cherche trouve recherche partout erp reference",
  read_calendar: "agenda calendrier rendez vous reunion planning semaine demain aujourd hui disponibilite",
  search_drive: "drive fichier dossier chemin nom",
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
  mes_routines: "mes routines programmees briefing",
  web_research: "web internet actualite marche externe prix public congres etranger concurrent",
  create_task: "cree tache assigne rappelle moi todo a faire pour",
  update_task: "modifie tache reassigne echeance priorite statut terminee",
  send_message: "envoie message ecris dis previens collegue",
  create_hr_request: "demande rh note frais avance conge absence attestation pour moi",
  create_admin_request: "demande administrative deplacement billet courrier signature achat devis paiement reservation salle",
  update_regulatory_product: "modifie dossier reglementaire champ change",
  assign_regulatory_responsible: "confie dossier charge responsable assigne reglementaire",
  set_regulatory_step: "etape anpp processus avance dossier reglementaire",
  request_regulatory_status_update: "relance mise a jour statut dossier reglementaire",
  regulatory_operation: "cree nouveau dossier reglementaire produit dci ouvre enregistrement",
  hr_operation: "rh employe fiche cree conge deposer decider remuneration contrat",
  task_operation: "tache rappel repondre demande tache avancer",
  drive_operation: "drive deplace renomme partage dossier fichier supprime",
  request_operation: "demande administrative valider traiter secretariat",
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
  lancer_un_travail: "analyse toutes rapport complet annee travail long lot chaque plusieurs etapes synthese demande a attends sa reponse relance escalade echeance",
  chercher_documents: "document retrouve cherche note compte rendu parle contenu bibliotheque piece qui mentionne",
  ouvrir_documents: "ouvre affiche montre document lis texte",
  faits_confirmes: "faits confirmes fiche referentiel organisation fournisseur adresse identite verifie",
  // J3 — l'Atelier : les mots d'une personne qui veut voir ou retoucher SON document (joint, renvoyé, trouvé).
  ouvrir_dans_l_atelier: "atelier ouvre affiche montre document word powerpoint presentation diapositive excel classeur pdf piece jointe modifie modifier remplace mets change corrige",
  modifier_document: "modifie modifier remplace mets change corrige reecris ajoute supprime diapositive slide titre paragraphe cellule tableau periode clause article synthese en place document",
  convertir_document: "convertis convertir conversion pdf word excel exporte transforme en",
  enregistrer_document: "enregistre sauvegarde nouvelle version garde valide document atelier",
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
  const m = mot.length > 3 ? mot.replace(/(s|x)$/, "") : mot;
  return m.slice(0, 6);
}

export function termes(t: string): string[] {
  return plier(t).replace(/_/g, " ").split(" ").filter((m) => m.length > 1 && !MOTS_VIDES.has(m)).map(racine);
}

const POIDS = { cles: 3, nom: 2, libelle: 2, description: 1 } as const;

/** Les verbes d'un GESTE : ils poussent les outils qui préparent une carte. */
const GESTE = /\b(cree|creer|prepare|preparer|ajoute|ajouter|envoie|envoyer|programme|planifie|organise|redige|remplis|modifie|depose|relance|confie|ouvre un|lance)\b/;
const estGeste = (nom: string) => /^(preparer_|create_|update_|send_|assign_|set_|request_regulatory|programmer_|gerer_)|_operation$/.test(nom);

interface Index {
  fiches: { nom: string; poids: Map<string, number> }[];
  idf: Map<string, number>;
}

export function indexer(fiches: readonly FicheOutil[]): Index {
  const df = new Map<string, number>();
  const out = fiches.map((f) => {
    const poids = new Map<string, number>();
    const poser = (texte: string, p: number) => {
      for (const m of termes(texte)) poids.set(m, Math.max(poids.get(m) ?? 0, p));
    };
    poser(f.description, POIDS.description);
    poser(f.libelle, POIDS.libelle);
    poser(f.nom, POIDS.nom);
    poser(MOTS_CLES[f.nom] ?? "", POIDS.cles);
    for (const m of poids.keys()) df.set(m, (df.get(m) ?? 0) + 1);
    return { nom: f.nom, poids };
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
  return idx.fiches
    .map((f) => {
      let s = 0;
      for (const m of q) s += (f.poids.get(m) ?? 0) * (idx.idf.get(m) ?? 0);
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
export function preselectionner(demande: string, fiches: readonly FicheOutil[], k = PRESELECTION_MAX, precedente = ""): string[] {
  const disponibles = new Set(fiches.map((f) => f.nom));
  const herites = precedente ? classer(precedente, fiches, HERITES_MAX).map((c) => c.nom) : [];
  return ordonnerActifs([...SOCLE_OUTILS, ...classer(demande, fiches, k).map((c) => c.nom), ...herites], disponibles);
}

/** Ce que le contexte dit au modèle de cette mécanique (une ligne, stable). */
export const CONSIGNE_SELECTION =
  "OUTILS : tu ne vois qu'une partie de tes outils. Si aucun outil visible ne couvre la demande, appelle d'abord "
  + `${OUTIL_TROUVER} avec l'intention en quelques mots (« lire le salaire d'une personne », « créer un dossier réglementaire ») : `
  + "les outils trouvés deviennent disponibles à l'étape suivante. Ne dis jamais qu'un outil te manque sans l'avoir cherché.";
