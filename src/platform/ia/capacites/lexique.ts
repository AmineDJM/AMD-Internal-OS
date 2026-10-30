/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE LEXIQUE DES CAPACITÉS (lot J6, décision 0020) — de l'identifiant d'une action à des mots français.
 *
 * Module PUR, zéro import. Le contrat des actions (`contrat.genere.json`) nomme chaque action par son
 * identifiant de code, en anglais (`createTask`, `updateRegulatoryProduct`) ou en français (`enregistrerDevisPromo`).
 * Une personne, elle, écrit « crée une tâche », « modifie le dossier réglementaire ». Ce lexique est un
 * VOCABULAIRE (mot → mot), pas une table d'actions : aucune action n'y est déclarée, une action ajoutée
 * demain se lit avec les mots qu'il connaît déjà. Un mot inconnu passe tel quel — il reste cherchable.
 *
 *   • `MOTS` : le mot de code (plié) → son équivalent français, accents compris (le libellé se lit) ;
 *   • `VERBES` : les mots qui ouvrent un libellé (« Créer », « Supprimer ») — l'infinitif français ;
 *   • `SYNONYMES` : les autres mots d'une personne pour le même geste (« nouveau », « ajoute ») — ils servent
 *     la RECHERCHE seulement, jamais le libellé envoyé au modèle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les verbes : le mot de code → l'infinitif français (le premier mot du libellé). */
export const VERBES: Readonly<Record<string, string>> = {
  // anglais
  create: "créer", update: "modifier", delete: "supprimer", set: "définir", add: "ajouter", save: "enregistrer",
  remove: "retirer", cancel: "annuler", submit: "soumettre", toggle: "basculer", decide: "décider", send: "envoyer",
  assign: "attribuer", move: "déplacer", mark: "marquer", upsert: "enregistrer", approve: "approuver", reject: "rejeter",
  validate: "valider", confirm: "confirmer", close: "clôturer", reopen: "rouvrir", restore: "restaurer", archive: "archiver",
  rename: "renommer", share: "partager", unshare: "retirer le partage de", attach: "joindre", link: "lier", unlink: "délier",
  import: "importer", generate: "générer", analyze: "analyser", enrich: "enrichir", review: "revoir", respond: "répondre à",
  answer: "répondre à", publish: "publier", resend: "renvoyer", revoke: "révoquer", reset: "réinitialiser", start: "démarrer",
  stop: "arrêter", run: "exécuter", execute: "exécuter", complete: "terminer", finish: "terminer", accept: "accepter",
  refuse: "refuser", claim: "réclamer", settle: "régler", open: "ouvrir", connect: "connecter", disconnect: "déconnecter",
  deliver: "livrer", fulfill: "honorer", declare: "déclarer", skip: "passer", defer: "reporter", register: "inscrire",
  invite: "inviter", upload: "téléverser", convert: "convertir", copy: "copier", browse: "parcourir", check: "vérifier",
  get: "lire", list: "lister", read: "lire", search: "chercher", preview: "prévisualiser", remember: "mémoriser",
  forget: "oublier", ensure: "garantir", duplicate: "dupliquer", sign: "signer", nudge: "relancer", renew: "renouveler",
  prefill: "préremplir", regenerate: "régénérer", log: "journaliser", change: "changer", ack: "accuser réception de",
  deactivate: "désactiver", attribute: "attribuer", transfer: "transférer", request: "demander", edit: "modifier",
  apply: "appliquer", process: "traiter", refresh: "rafraîchir", trash: "mettre à la corbeille", purge: "purger",
  destroy: "détruire", withdraw: "retirer", dismiss: "écarter", pin: "épingler", mute: "mettre en sourdine",
  snooze: "reporter", track: "suivre", summarize: "résumer", initiate: "lancer", choose: "choisir", clear: "vider",
  cleanup: "nettoyer", forward: "transférer", lock: "verrouiller", unlock: "déverrouiller", unmark: "démarquer",
  join: "rejoindre", take: "prendre", broadcast: "diffuser", authenticate: "authentifier", onboard: "intégrer",
  spend: "dépenser", end: "terminer", post: "publier", ask: "demander", allot: "doter", carry: "reporter",
  // français (pliés) → avec accents
  enregistrer: "enregistrer", retirer: "retirer", annuler: "annuler", modifier: "modifier", demander: "demander",
  ajouter: "ajouter", supprimer: "supprimer", rattacher: "rattacher", relancer: "relancer", decider: "décider",
  lire: "lire", deposer: "déposer", proposer: "proposer", changer: "changer", creer: "créer", valider: "valider",
  envoyer: "envoyer", generer: "générer", resoumettre: "resoumettre", confirmer: "confirmer", corriger: "corriger",
  commenter: "commenter", ouvrir: "ouvrir", lister: "lister", previsualiser: "prévisualiser", marquer: "marquer",
  basculer: "basculer", reprendre: "reprendre", renvoyer: "renvoyer", joindre: "joindre", importer: "importer",
  renommer: "renommer", verifier: "vérifier", imputer: "imputer", saisir: "saisir", classer: "classer",
  definir: "définir", appliquer: "appliquer", fusionner: "fusionner", repondre: "répondre", imprimer: "imprimer",
  repartir: "repartir", regler: "régler", chercher: "chercher", regenerer: "régénérer", approuver: "approuver",
  executer: "exécuter", accepter: "accepter", signer: "signer", lancer: "lancer", soumettre: "soumettre",
  transferer: "transférer", clore: "clore", televerser: "téléverser", emettre: "émettre", reviser: "réviser",
  archiver: "archiver", adresser: "adresser", choisir: "choisir", cloturer: "clôturer", remplacer: "remplacer",
  arreter: "arrêter", mettre: "mettre", suspendre: "suspendre", aligner: "aligner", defaire: "défaire",
  ecarter: "écarter", signaler: "signaler", planifier: "planifier", poser: "poser", refuser: "refuser",
  publier: "publier", lever: "lever", rediger: "rédiger", reexaminer: "réexaminer", conseiller: "conseiller",
  detacher: "détacher", agir: "agir", colorer: "colorer", pauser: "mettre en pause", comparer: "comparer",
  convertir: "convertir", fermer: "fermer", relire: "relire", revoir: "revoir", autoriser: "autoriser",
  preremplir: "préremplir", voter: "voter", consommer: "consommer", completer: "compléter", reallouer: "réallouer",
  remettre: "remettre", trier: "trier", finaliser: "finaliser", ignorer: "ignorer", prolonger: "prolonger",
  reaffecter: "réaffecter", rejeter: "rejeter", trancher: "trancher", restaurer: "restaurer", relier: "relier",
  affecter: "affecter", abandonner: "abandonner", designer: "désigner", doter: "doter", entrer: "entrer",
  escalader: "escalader", faire: "faire", forcer: "forcer", fournir: "fournir", integrer: "intégrer",
  partager: "partager", prendre: "prendre", preparer: "préparer", prevoir: "prévoir", ranger: "ranger",
  rapporter: "rapporter", rapprocher: "rapprocher", reattribuer: "réattribuer", receptionner: "réceptionner",
  redemander: "redemander", rendre: "rendre", replanifier: "replanifier", retenir: "retenir", revenir: "revenir",
  rouvrir: "rouvrir", servir: "servir", statuer: "statuer", synchroniser: "synchroniser", terminer: "terminer",
  tester: "tester", cibler: "cibler", compter: "compter", dire: "dire", effacer: "effacer", apercu: "aperçu de",
  bilan: "bilan de", catalogue: "catalogue de", origine: "origine de",
};

/** Les autres mots du code → le français (noms, qualificatifs). Un mot absent reste tel quel. */
export const MOTS: Readonly<Record<string, string>> = {
  // Un verbe employé comme NOM, en fin d'identifiant (`requestRegulatoryStatusUpdate`).
  update: "mise à jour", invite: "invitation",
  // Les mots des CHAMPS (la carte les montre) : `assignedToId` → « attribué à », `dueDate` → « échéance date ».
  assigned: "attribué à", due: "échéance", title: "titre", name: "nom", body: "texte", amount: "montant",
  description: "description", reason: "motif", motif: "motif", start: "début", end: "fin",
  estimated: "estimé", expected: "prévu", minutes: "minutes", address: "adresse", phone: "téléphone",
  label: "libellé", kind: "nature", type: "type", recipient: "destinataire", value: "valeur", submission: "soumission", classification: "classification",
  opinion: "avis", appeal: "appel", award: "attribution", checklist: "liste de contrôle", definition: "définition",
  task: "tâche", tasks: "tâches", tache: "tâche", taches: "tâches", message: "message", messaging: "messagerie",
  conversation: "conversation", thread: "fil", threads: "fils", channel: "canal", member: "membre", members: "membres",
  regulatory: "réglementaire", product: "produit", products: "produits", dossier: "dossier", dossiers: "dossiers",
  step: "étape", etape: "étape", status: "statut", statut: "statut", timeline: "chronologie", ctd: "CTD",
  responsible: "responsable", responsable: "responsable", reminder: "rappel", reminders: "rappels", remind: "rappel",
  request: "demande", requests: "demandes", demande: "demande", admin: "administration", administrative: "administrative",
  hr: "RH", rh: "RH", employee: "salarié", employees: "salariés", salaries: "salariés", leave: "congé", conge: "congé",
  payroll: "paie", paie: "paie", salary: "salaire", slip: "bulletin", slips: "bulletins", advance: "avance",
  contract: "contrat", amendment: "avenant", attestation: "attestation", training: "formation", formation: "formation",
  onboarding: "intégration", recruitment: "recrutement", recrutement: "recrutement", candidate: "candidat",
  candidates: "candidats", candidature: "candidature", candidatures: "candidatures", offre: "offre", offres: "offres",
  emploi: "emploi", embauche: "embauche", coaching: "coaching", team: "équipe", equipe: "équipe", manager: "manager",
  budget: "budget", envelope: "enveloppe", line: "ligne", lines: "lignes", ligne: "ligne", lignes: "lignes",
  category: "catégorie", categories: "catégories", categorie: "catégorie", pole: "pôle", campagne: "campagne",
  proposal: "proposition", proposition: "proposition", expense: "dépense", depense: "dépense", depenses: "dépenses",
  order: "ordre", orders: "ordres", ordre: "ordre", payment: "paiement", paiement: "paiement", paid: "payé",
  invoice: "facture", facture: "facture", factures: "factures", avoir: "avoir", petty: "petite", cash: "caisse",
  caisse: "caisse", treasury: "trésorerie", tresorerie: "trésorerie", transaction: "transaction",
  transactions: "transactions", account: "compte", compte: "compte", balance: "solde", soldes: "soldes",
  income: "recette", finance: "finances", settlement: "règlement", recharge: "recharge", frais: "frais",
  ecriture: "écriture", rapprochement: "rapprochement", rapprochements: "rapprochements", doublon: "doublon",
  doublons: "doublons", centre: "centre", center: "centre", seat: "siège", threshold: "seuil", thresholds: "seuils",
  drive: "Drive", node: "élément du Drive", nodes: "éléments du Drive", folder: "dossier", folders: "dossiers",
  file: "fichier", files: "fichiers", fichier: "fichier", fichiers: "fichiers", space: "espace", document: "document",
  documents: "documents", doc: "document", version: "version", versions: "versions", comment: "commentaire",
  comments: "commentaires", commentaire: "commentaire", shares: "partages", storage: "stockage", bibliotheque: "Bibliothèque",
  knowledge: "connaissance", letterhead: "papier en-tête", lettre: "lettre", modele: "modèle", modeles: "modèles",
  legal: "juridique", mail: "courrier", email: "e-mail", mailbox: "boîte mail", boite: "boîte", draft: "brouillon",
  brouillon: "brouillon", microsoft: "Microsoft", google: "Google", registre: "registre", register: "registre",
  meeting: "réunion", calendar: "agenda", event: "événement", invitation: "invitation", participant: "participant",
  participants: "participants", participation: "participation", congress: "congrès", sponsoring: "sponsoring",
  care: "prise en charge", prise: "prise", charge: "charge", beneficiary: "bénéficiaire", hebergement: "hébergement",
  hotel: "hôtel", billet: "billet", billetterie: "billetterie", voyageur: "voyageur", agence: "agence", agency: "agence",
  reservation: "réservation", ad: "Ad", pro: "Pro", adpro: "Ad & Pro", poste: "poste", postes: "postes", item: "poste",
  devis: "devis", quote: "devis", quotes: "devis", bc: "bon de commande", bon: "bon", bons: "bons",
  commande: "commande", purchase: "achat", supplier: "fournisseur", fournisseur: "fournisseur",
  fournisseurs: "fournisseurs", portal: "portail", promo: "promotionnel", material: "matériel", materiel: "matériel",
  stock: "stock", stocks: "stocks", comptage: "comptage", inventaire: "inventaire", mouvement: "mouvement",
  transfert: "transfert", reception: "réception", lot: "lot", tender: "appel d'offres", pch: "PCH", vente: "vente",
  ventes: "ventes", sales: "ventes", sale: "vente", planning: "planification", plan: "plan", tour: "tournée",
  tournee: "tournée", visit: "visite", visite: "visite", visites: "visites", field: "terrain", terrain: "terrain",
  report: "rapport", reports: "rapports", rapport: "rapport", kam: "KAM", sector: "secteur", secteur: "secteur",
  territoire: "territoire", wilaya: "wilaya", medical: "médical", medicale: "médicale", medecin: "médecin",
  medecins: "médecins", doctor: "médecin", doctors: "médecins", praticiens: "praticiens", directory: "annuaire",
  annuaire: "annuaire", institution: "établissement", etablissement: "établissement", etablissements: "établissements",
  hospital: "hôpital", specialty: "spécialité", specialite: "spécialité", specialites: "spécialités", info: "information",
  declaration: "déclaration", pharmacovigilance: "pharmacovigilance", pv: "pharmacovigilance", cas: "cas",
  segmentation: "segmentation", segments: "segments", potentiel: "potentiel", strategie: "stratégie", panel: "panel",
  market: "marché", research: "étude", molecule: "molécule", presentation: "présentation", brand: "marque",
  marque: "marque", logo: "logo", site: "site", web: "web", article: "article", directive: "note de service",
  directives: "notes de service", validation: "validation", validator: "validateur", workflow: "circuit",
  circuit: "circuit", approval: "approbation", decision: "décision", visa: "visa", dg: "DG", direction: "direction",
  mission: "mission", missions: "missions", consulting: "consulting", project: "projet", bd: "BD",
  business: "business", unit: "unité", units: "unités", bu: "BU", company: "société", societe: "société",
  department: "département", departement: "département", org: "organisation", organisation: "organisation",
  organisations: "organisations", organigramme: "organigramme", user: "utilisateur", people: "personnes",
  personne: "personne", personnes: "personnes", contact: "contact", support: "support", feedback: "retour",
  notification: "notification", notifications: "notifications", kpi: "KPI", kpis: "KPI", objectif: "objectif",
  general: "généraux", means: "moyens", moyens: "moyens", generaux: "généraux", supply: "fourniture",
  office: "bureau", secretariat: "secrétariat", piece: "pièce", pieces: "pièces", justificatif: "justificatif",
  scan: "scan", link: "lien", lien: "lien", record: "fiche", fiche: "fiche", fiches: "fiches", entity: "fiche",
  entite: "entité", custom: "personnalisé", element: "élément", row: "ligne", cell: "cellule", cellules: "cellules",
  column: "colonne", columns: "colonnes", sheet: "feuille", classeur: "classeur", rule: "règle", regles: "règles",
  settings: "réglages", reglages: "réglages", note: "note", total: "total", prix: "prix", produit: "produit",
  produits: "produits", canonique: "canonique", alias: "alias", catalog: "catalogue", range: "gamme", ranges: "gammes",
  routine: "routine", routines: "routines", memory: "mémoire", memoire: "mémoire", travail: "travail",
  travaux: "travaux", atelier: "Atelier", onglet: "onglet", recurrence: "récurrence", snapshot: "relevé",
  releve: "relevé", annex: "annexe", import: "import", integration: "intégration", enrichissement: "enrichissement",
  refonte: "refonte", reprise: "reprise", numero: "numéro", numerotation: "numérotation", reference: "référence",
  references: "références", date: "date", dates: "dates", delai: "délai", priorite: "priorité", priority: "priorité",
  niveau: "niveau", level: "niveau", risk: "risque", risque: "risque", frequence: "fréquence", evaluation: "évaluation",
  examen: "examen", revue: "revue", revision: "révision", correction: "correction", rectificatif: "rectificatif",
  suppression: "suppression", derogation: "dérogation", blocage: "blocage", conflit: "conflit", cle: "clé",
  besoin: "besoin", besoins: "besoins", service: "service", services: "services", lieux: "lieux", stand: "stand",
  outcome: "issue", result: "résultat", summary: "résumé", resume: "résumé", text: "texte", texte: "texte",
  my: "mes", mes: "mes", mon: "mon", ma: "ma", own: "propre",
  all: "tous", many: "plusieurs", other: "autre", direct: "direct", final: "final", finale: "finale",
  public: "public", internal: "interne", update_: "mise à jour", new: "nouveau", double: "double", registration: "inscription",
  transcript: "transcription", password: "mot de passe", granted: "accordé", briefing: "briefing", agenda: "agenda",
 visibility: "visibilité", opening: "ouverture", activity: "activité", stage: "étape",
  state: "état", outbound: "sortant", inbound: "entrant", policy: "politique", watch: "veille", review: "revue",
  delivery: "livraison", arrival: "arrivée", receipt: "reçu", received: "reçu", issue: "anomalie", author: "auteur",
  call: "appel", chart: "graphique", group: "groupe", hidden: "masqué", ideas: "idées", input: "saisie",
  matrix: "matrice", module: "module", modules: "modules", owner: "propriétaire", player: "acteur", position: "position",
  target: "cible", time: "temps", unlocked: "déverrouillé", values: "valeurs", viewers: "lecteurs", readers: "lecteurs",
  work: "travail", conformity: "conformité", enrollment: "inscription", forecast: "prévision", endpoint: "point d'accès",
};

/** Les mots d'une personne pour un même sens — RECHERCHE seulement (ils ne partent jamais au modèle). */
export const SYNONYMES: Readonly<Record<string, string>> = {
  créer: "crée cree nouveau nouvelle ajoute ouvre enregistre saisis", ajouter: "ajoute crée nouveau mets",
  modifier: "modifie change corrige mets à jour actualise remplace", supprimer: "supprime efface enlève retire détruis",
  retirer: "retire enlève supprime", annuler: "annule abandonne", définir: "définis fixe règle mets change",
  enregistrer: "enregistre sauvegarde crée saisis", envoyer: "envoie écris adresse transmets", soumettre: "soumets envoie dépose",
  valider: "valide approuve accepte signe", approuver: "approuve valide accepte", décider: "décide tranche valide refuse accepte",
  rejeter: "rejette refuse", refuser: "refuse rejette", attribuer: "attribue assigne confie", déplacer: "déplace range bouge",
  renommer: "renomme appelle", partager: "partage donne accès", déposer: "dépose joins ajoute téléverse",
  joindre: "joins attache ajoute", relancer: "relance rappelle presse", clôturer: "clôture ferme termine", rouvrir: "rouvre reprends",
  archiver: "archive range", lister: "liste montre affiche quels", lire: "lis montre affiche consulte",
  chercher: "cherche trouve recherche", prévisualiser: "aperçu prévisualise montre", régler: "règle paie paye solde",
  commenter: "commente note remarque", importer: "importe charge", générer: "génère produis crée", publier: "publie diffuse",
  tâche: "todo à faire rappel", message: "écris dis préviens", salarié: "employé collaborateur collègue personne",
  congé: "congés vacances absence repos", paie: "salaire bulletin", demande: "requête", réunion: "rendez-vous rdv meeting",
  agenda: "calendrier planning rendez-vous rdv", produit: "médicament molécule DCI", réglementaire: "regulatory ANPP enregistrement AMM REG",
  dossier: "fiche", dépense: "achat frais", facture: "factures", paiement: "règlement payer", fournisseur: "prestataire",
  médecin: "docteur praticien Dr", responsable: "confie charge assigne responsable", "mise à jour": "relance actualise",
  "élément du Drive": "fichier dossier document", "éléments du Drive": "fichiers dossiers documents", annuaire: "liste contacts", établissement: "hôpital clinique CHU", budget: "enveloppe",
  enveloppe: "budget", "bon de commande": "BC", devis: "offre de prix proforma", courrier: "lettre mail",
  "e-mail": "mail courriel", Drive: "fichiers documents", document: "fichier pièce", "note de service": "directive circulaire",
  "prise en charge": "PEC inscription congrès", sponsoring: "sponsoriser parrainage", congrès: "congres séminaire",
  événement: "evenement soirée séminaire", tournée: "itinéraire plan de visite", visite: "rendez-vous terrain",
  rapport: "compte rendu CR", stock: "inventaire quantités", formation: "training", recrutement: "embauche poste offre",
  candidat: "candidature CV", pharmacovigilance: "effet indésirable PV", circuit: "workflow validation",
  validation: "valider approbation", projet: "project", société: "entreprise entité", département: "service",
  notification: "alerte", statut: "terminée terminé fait en cours", mission: "déplacement ordre de mission", avance: "acompte", caisse: "petite caisse",
};

/** Plie un texte : minuscules, sans accents, sans ponctuation (même règle que la sélection J4). */
export function plierMot(t: string): string {
  return t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Les mots d'un identifiant de code : `updateRegulatoryProduct` → update, regulatory, product. */
export function motsDuCode(nom: string): string[] {
  return (nom.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? []).map((m) => m.toLowerCase());
}

/** Les mots-outils d'un identifiant, sans objet dans un libellé (`spendFromPettyCash`, `sendCareToFinance`). */
const OUTILS_GRAMMATICAUX = new Set(["de", "du", "des", "la", "le", "les", "l", "from", "to", "with", "by", "for", "in", "of", "and", "et", "au", "a"]);

/** Les verbes anglais du code (la première ligne de `VERBES`). */
const VERBES_ANGLAIS = new Set(Object.keys(VERBES).slice(0, Object.keys(VERBES).indexOf("enregistrer")));

/** Un mot de code ANGLAIS : traduit autrement qu'à l'accent près (`legal` → « juridique », pas `piece` → « pièce »). */
const estAnglais = (m: string): boolean => {
  const fr = MOTS[m];
  return !!fr && plierMot(fr).replace(/[^a-z]/g, "") !== m;
};

/**
 * LE LIBELLÉ D'UNE ACTION, en français : le verbe à l'infinitif, puis l'objet. Les mots anglais qui SUIVENT le verbe
 * sont remis dans l'ordre français (le déterminant après le nom : `regulatoryProduct` → « produit réglementaire »).
 */
export function libelleDeFonction(fonction: string): string {
  const mots = motsDuCode(fonction);
  if (!mots.length) return fonction;
  const [premier, ...reste] = mots;
  const verbe = VERBES[premier!];
  const objet = verbe ? reste : mots;
  // Tous connus, et au moins un vraiment anglais (`document`, `budget` s'écrivent pareil dans les deux langues).
  // Un nom FRANÇAIS (`enregistrerDevisPromo`) garde son ordre : seul un verbe anglais annonce un nom anglais.
  const anglais = !!verbe && VERBES_ANGLAIS.has(premier!) && objet.length > 1 && objet.every((m) => MOTS[m] !== undefined) && objet.some(estAnglais);
  const ordonnes = anglais ? [...objet].reverse() : objet;
  const fr = ordonnes.filter((m) => !OUTILS_GRAMMATICAUX.has(m)).map((m) => MOTS[m] ?? VERBES[m] ?? m);
  const texte = [verbe, ...fr].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return texte.charAt(0).toUpperCase() + texte.slice(1);
}

/** Le premier mot du code, s'il est un verbe connu (plié) — la clé des règles de risque. */
export const verbeDuCode = (fonction: string): string | null => {
  const premier = motsDuCode(fonction)[0];
  return premier && VERBES[premier] ? premier : null;
};

/** Les synonymes de recherche d'un libellé : ceux de chacun de ses mots (et de ses expressions). */
export function synonymesDe(...textes: string[]): string {
  const out: string[] = [];
  const bas = textes.join(" ").toLowerCase();
  for (const [mot, syn] of Object.entries(SYNONYMES)) {
    const m = mot.toLowerCase();
    if (m.includes(" ") ? bas.includes(m) : bas.split(/[\s'’,()·-]+/).includes(m)) out.push(syn);
  }
  return out.join(" ");
}

/** Les mots d'un nom de FICHIER d'actions, en français (`promo-material-actions` → « promotionnel matériel »). */
export function motsDuFichier(fichier: string): string {
  return fichier.replace(/-actions$/, "").split("-").map((m) => MOTS[m] ?? m).join(" ");
}
