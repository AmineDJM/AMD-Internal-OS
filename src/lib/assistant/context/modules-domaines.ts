import { MODULE_LABELS } from "@/lib/labels";

import type { Domain } from "@/lib/assistant/context/router";

/**
 * LA CLÉ D'UN MODULE SE LIT SUR LE CATALOGUE, PAS SUR LE RBAC.
 *
 * `Module` est déclaré dans `src/lib/rbac.ts`, que la frontière Adam ↔ ERP compte comme une
 * traversée — et le plafond de `boundary.test.ts` est à marge ZÉRO. `MODULE_LABELS` est typé
 * `Record<Module, string>`, donc `keyof typeof MODULE_LABELS` EST `Module` : on obtient
 * l'exhaustivité sans la traversée, en lisant le catalogue qui est déjà au socle (§118.128).
 */
type CleModule = keyof typeof MODULE_LABELS;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES 43 MODULES DE L'ERP, ET LE DOMAINE D'OUTILS QUI LES SERT.
 *
 * ── LA PLAINTE, ET SA MESURE ──────────────────────────────────────────────────────────────
 *
 * « Il a pas accès à tout l'ERP » (le dirigeant). Mesuré en formant la question depuis le
 * LIBELLÉ CANONIQUE de chaque module : **29 modules sur 43 ne faisaient reconnaître AUCUN
 * domaine**. Le résolveur ouvre alors « tous les domaines » et laisse le plafond du niveau
 * borner — mais le rang se calcule sur la POSITION du domaine dans une liste FIGÉE, et le
 * premier de cette liste est `MAIL`. En pratique, « ouvrir tout » valait donc « ouvrir les neuf
 * premiers d'une liste figée » : `combien de visites terrain ce mois-ci ?` et `quel est l'état
 * des stocks à l'hôpital Mustapha ?` recevaient `gmail_search` et `gmail_read_thread`, avec
 * **213 outils sur 227 écartés**.
 *
 * ── LE MANQUE EST DE ROUTAGE, PAS DE CAPACITÉ ─────────────────────────────────────────────
 *
 * Les outils EXISTENT : `field_report_operation`, `sales_operation`, `stock_operation`,
 * `logistics_operation`, `care_operation`, `medical_info_operation`, `bd_operation`,
 * `promo_operation`, `consulting_operation`, `validation_operation`, `directive_operation`,
 * `support_operation`… Ranger l'un dans l'autre envoie la dette au mauvais endroit (§118.31).
 *
 * ── POURQUOI CETTE TABLE EXISTE PLUTÔT QU'UN MOT DE PLUS DANS `DOMAIN_SIGNALS` ────────────
 *
 * Ce défaut a DÉJÀ été payé quatre fois, mot par mot, et le fichier du routeur le raconte :
 * « TÂCHE manquait, et c'est le mot le plus courant pour la chose » ; « les outils Teach étaient
 * classés GENERAL, et GENERAL n'est JAMAIS servi » ; « `source_map` était classé GENERAL — donc
 * jamais servi, comme les outils Teach avant lui » ; « l'appel d'offres PCH ne menait qu'à
 * DRIVE ». Chaque fois : un banc trouve un mot manquant, on l'ajoute, et le trou suivant reste
 * invisible. Quand un défaut se répète, on cherche l'endroit où TOUTES les instances passent
 * (§118.58) — ici, c'est la LISTE DES MODULES, que l'ERP déclare déjà.
 *
 * ── CE QUI EST DÉRIVÉ ET CE QUI EST DÉCIDÉ ────────────────────────────────────────────────
 *
 * Le LIBELLÉ est dérivé : il vient de `MODULE_LABELS` et entre automatiquement dans le
 * vocabulaire, donc un module ne peut JAMAIS être moins bien servi que son propre nom, et un
 * renommage suit sans que personne y pense (§118.73). Le DOMAINE, lui, est une DÉCISION : quel
 * jeu d'outils lit ce module. Elle est déclarée ici, exhaustivement — `Record<Module, …>` fait
 * qu'un module ajouté demain NE COMPILE PAS tant que personne n'a dit qui le sert (§118.72).
 * Les MOTS supplémentaires sont la part irréductiblement humaine : ce qu'une personne dit pour
 * parler de ce module sans employer son nom d'écran. Ils vivent À CÔTÉ du module et non dispersés
 * dans quinze regex de domaine, parce que dans une regex de domaine un trou est invisible.
 *
 * ── LA RÈGLE QUI REND CE LOT SANS RISQUE ──────────────────────────────────────────────────
 *
 * Cette couche ne parle QUE lorsque le vocabulaire écrit à la main n'a RIEN reconnu. Elle
 * n'arbitre donc jamais contre lui, aucun corpus de routage existant ne change de verdict, et
 * l'empreinte réelle ne dépasse pas l'empreinte demandée (§118.16). Et se tromper ici coûte des
 * SCHÉMAS, pas la réponse : **le domaine OUVRE, le raccourci FERME** — c'est l'asymétrie mesurée
 * au lot de la porte de l'annuaire (§118.129).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export interface ServiceDuModule {
  /** Les domaines d'outils qui lisent ce module. VIDE = aucun outil dédié, et on le DIT. */
  readonly domaines: readonly Domain[];
  /**
   * Ce qu'une personne dit pour parler de ce module SANS employer son nom d'écran. Le libellé
   * du module y est ajouté automatiquement : ne rien mettre ici n'est jamais une lacune muette.
   */
  readonly mots?: readonly string[];
  /**
   * LES OUTILS QUI SERVENT CE MODULE, ET POURQUOI LE DOMAINE NE SUFFIT PAS.
   *
   * Mesuré après avoir ouvert le bon domaine : « quel est l'état des stocks à l'hôpital
   * Mustapha ? » ouvre REGULATORY — qui porte QUARANTE-SIX outils pour QUINZE places au niveau
   * A — et `read_stock` comme `stock_operation` tombaient sous le plafond, au profit d'outils
   * simplement plus tôt dans le registre. Le domaine est une maille trop grosse : ouvrir le bon
   * ne suffit pas, il faut que l'outil DU module passe devant les autres du même domaine.
   *
   * C'est le mécanisme de §118.122 appliqué au même fait : ce que le tour NOMME passe. Une
   * personne qui nomme son module l'a nommé aussi sûrement qu'une consigne nomme son outil.
   *
   * Une liste écrite à la main serait fausse au premier renommage, EN SILENCE — d'où le cliquet :
   * chaque nom doit exister dans le parc, sinon le banc tombe en nommant le module fautif. Et le
   * filtre des ÉCRITURES continue de s'appliquer : nommer un module n'ouvre pas ses gestes à une
   * question qui ne fait que lire.
   */
  readonly outils?: readonly string[];
}

export const SERVICE_DU_MODULE: Record<CleModule, ServiceDuModule> = {
  // ── Ce que le vocabulaire écrit à la main reconnaît DÉJÀ : pas un mot de plus ────────────
  LEGAL: { domaines: ["LEGAL"] },
  MAIL_REGISTER: { domaines: ["LEGAL"], mots: ["courrier entrant", "courrier sortant"] },
  MESSAGING: { domaines: ["MAIL"] },
  REGULATORY: { domaines: ["REGULATORY"] },
  // Le pipeline (dossiers verrouillés) — module à part de Regulatory depuis le 08/10, même service.
  REGULATORY_PIPELINE: { domaines: ["REGULATORY"] },
  BUDGETS: { domaines: ["FINANCE"] },
  // Budget Marketing (08/10) — les mêmes enveloppes que Budgets, bornées à la Direction Marketing.
  BUDGET_MARKETING: { domaines: ["FINANCE"], mots: ["budget marketing", "enveloppe marketing", "enveloppe ad pro"] },
  // Budget Regulatory et Budget Operations & Sales (08/10) — mêmes enveloppes, bornées à leur pôle.
  BUDGET_REGULATORY: { domaines: ["FINANCE"], mots: ["budget regulatory", "budget reglementaire", "bv 25", "bv 75", "frais enregistrement"] },
  BUDGET_OPERATIONS: { domaines: ["FINANCE"], mots: ["budget operations", "masse salariale force de vente", "budget force de vente"] },
  // Campagne budgétaire (10/2026) — propositions des pôles, revue, arbitrage. Aucun outil d'Adam : gestes d'écran.
  BUDGET_CAMPAIGN: { domaines: ["FINANCE"], mots: ["campagne budgetaire", "budget 2027", "budgets 2027", "proposition budgetaire", "arbitrage budgetaire"] },
  FINANCES: { domaines: ["FINANCE"] },
  RH: { domaines: ["HR"] },
  RECRUITMENT: { domaines: ["HR"] },
  EMPLOYEES: { domaines: ["HR"], mots: ["employes", "equipe", "consultants", "departements", "fiche salarie"] },
  HR_REQUESTS: { domaines: ["HR"], mots: ["demandes rh", "attestation", "ordre de mission", "conge", "absence", "arret maladie"] },
  TRAINING: { domaines: ["HR"], mots: ["formation", "formations", "seminaire"] },
  PHARMACOVIGILANCE: { domaines: ["REGULATORY"], mots: ["pharmacovigilance", "effet indesirable", "cas pv", "signalement"] },
  DOCUMENTS: { domaines: ["DRIVE"] },
  DRIVE: { domaines: ["DRIVE"] },
  // Direction artistique (10/2026) — papeterie par entité. Aucun outil d'Adam : gestes d'écran.
  ART_DIRECTION: { domaines: ["DRIVE"], mots: ["direction artistique", "papier en-tete", "papier entete", "modele de bon de commande", "charte graphique"] },
  ADMIN: { domaines: ["ADMIN"] },
  PCH: { domaines: ["REGULATORY"], outils: ["pch_operation", "pch_market_status"] },
  PRODUCT_EXPLORER: { domaines: ["REGULATORY"] },

  // ── Les 29 que rien ne reconnaissait ────────────────────────────────────────────────────
  // La force de vente. `field_report_operation` et `sales_operation` vivent dans DIRECTORY (ils
  // lisent des personnes et des médecins) ; `planning_operation` dans CALENDAR.
  FIELD_REPORTS: { domaines: ["DIRECTORY", "CALENDAR"], mots: ["visite", "visites", "tournee", "tournees", "compte rendu de visite"], outils: ["field_report_operation"] },
  SALES_PLANNING: { domaines: ["DIRECTORY", "CALENDAR", "DATA"], mots: ["force de vente", "kam", "secteur", "secteurs", "plan de tournee"], outils: ["sales_operation", "planning_operation"] },
  // Le montage de la force de vente (Direction, 08/10) : BU, territoires, paramètres SFE — les ops de `planning_operation`.
  BUSINESS_UNITS: { domaines: ["DIRECTORY", "DATA"], mots: ["business unit", "business units", "territoire", "territoires", "parametres sfe"], outils: ["planning_operation"] },
  SALES: { domaines: ["DIRECTORY", "FINANCE", "DATA"], mots: ["vente", "ventes", "chiffre d affaires", "ca de ville", "vente de ville"], outils: ["sales_operation"] },
  MEDICAL: { domaines: ["DIRECTORY", "REGULATORY"], mots: ["medecin", "medecins", "praticien", "praticiens", "promotion medicale", "specialite", "specialites"], outils: ["medical_operation", "search_doctors"] },
  MEDICAL_INFO: { domaines: ["REGULATORY"], mots: ["information medicale", "declaration medicale", "pharmacovigilance"], outils: ["medical_info_operation"] },
  // Les hôpitaux et le stock. `read_stock`, `stock_operation`, `search_hospitals`,
  // `supply_operation` et `logistics_operation` sont tous classés REGULATORY.
  STOCKS: { domaines: ["REGULATORY", "DATA"], mots: ["stock", "stocks", "rupture", "ruptures", "hopital", "hopitaux", "chu", "eph", "peremption"], outils: ["read_stock", "stock_operation", "search_hospitals", "supply_operation"] },
  LOGISTICS: { domaines: ["REGULATORY"], mots: ["logistique", "livraison", "livraisons", "approvisionnement", "transport", "entrepot", "entrepots", "depot", "depots"], outils: ["logistics_operation", "supply_operation"] },
  // Ad & Pro. Les demandes sont des OBJETS DE MISSION (création, suivi, validation) et leur
  // argent est de la FINANCE.
  SPONSORING: { domaines: ["MISSION", "FINANCE"], mots: ["sponsoring", "parrainage", "prise en charge"], outils: ["adpro_operation", "create_sponsoring_request"] },
  CONGRESS_NATIONAL: { domaines: ["MISSION", "CALENDAR", "FINANCE"], mots: ["congres", "prise en charge", "prises en charge"], outils: ["care_operation", "create_congress_request"] },
  CONGRESS_INTERNATIONAL: { domaines: ["MISSION", "CALENDAR", "FINANCE"], mots: ["congres international", "prise en charge internationale"], outils: ["care_operation", "create_congress_request"] },
  EVENTS: { domaines: ["CALENDAR", "MISSION", "FINANCE"], mots: ["evenement", "evenements", "manifestation", "manifestations"], outils: ["event_operation", "search_events", "create_event_request"] },
  PROMO_MATERIAL: { domaines: ["MISSION", "LEGAL"], mots: ["materiel promotionnel", "support promotionnel", "brochure", "brochures", "echantillon", "echantillons"], outils: ["promo_operation", "create_promo_material_request"] },
  // Le STOCK et le CATALOGUE promotionnels (§118.164) n'ont AUCUNE capacité Adam, par décision :
  // chaque geste de stock atteste un fait PHYSIQUE (« je l'ai reçu », « je l'ai compté », « je
  // l'ai perdu ») qu'un modèle ne peut pas voir, et Adam est en pause de développement.
  PROMO_STOCK: { domaines: [], mots: ["stock promotionnel", "stock promo", "magasin central", "dotation", "dotations", "fiche posologique", "fiches posologiques"] },
  PROMO_CATALOG: { domaines: [], mots: ["catalogue promotionnel", "catalogue du materiel promotionnel"] },
  CONSULTING: { domaines: ["MISSION", "FINANCE"], mots: ["consulting", "prestation", "prestations", "consultant", "consultants"], outils: ["consulting_operation"] },
  AD_PRO_OTHER: { domaines: ["MISSION", "FINANCE"], mots: ["ad pro", "ad et pro", "ad & pro"], outils: ["adpro_operation"] },
  // Les circuits de validation. `validation_operation` et `advance_workflow` sont MISSION/ADMIN.
  VALIDATIONS: { domaines: ["MISSION", "ADMIN"], mots: ["demande de validation", "demandes de validation", "a valider", "circuit"], outils: ["validation_operation", "read_workflow"] },
  VALIDATION_CENTRE: { domaines: ["MISSION", "ADMIN"], mots: ["centre de validation", "file de validation"], outils: ["validation_operation", "read_workflow"] },
  AD_PRO_CENTRE: { domaines: ["FINANCE", "MISSION"], mots: ["centre de validation ad pro", "seuil ad pro", "arbitrage ad pro"], outils: ["adpro_operation", "read_workflow"] },
  PAYMENT_CENTRE: { domaines: ["FINANCE"], mots: ["centre de paiement", "a payer", "echeancier"], outils: ["decide_payment", "request_treasury_update"] },
  // Les BONS DE COMMANDE (§118.176) : des pièces du registre Legal, que les outils de Legal lisent.
  // La SIGNATURE n'a aucune capacité Adam, par décision : c'est une attestation (§118.15).
  PURCHASE_ORDERS: { domaines: ["LEGAL"], mots: ["bc a signer", "bons de commande a signer", "signature des bons de commande"] },
  MARKETING_COCKPIT: { domaines: ["DIRECTORY"], mots: ["marketing cockpit", "messages marketing", "message promotionnel", "specialites medicales"], outils: ["planning_operation"] },
  SEGMENTATION: { domaines: ["DIRECTORY"], mots: ["segmentation", "segment a b c d", "potentiel patients", "affinite produit", "decideur h", "priorite p1"] },
  // Le DROIT de forcer une lettre (Direction, 07/10) : les mêmes lectures que la segmentation, aucun geste d'Adam.
  SEGMENTATION_POTENTIEL: { domaines: ["DIRECTORY"], mots: ["potentiel force", "forcer le potentiel"] },
  CONSUMPTION: { domaines: ["DIRECTORY"], mots: ["consommation hospitaliere", "consumption intelligence", "affinite etablissement", "fichier de consommation"] },
  // Ventes PCH (08/10) — les fichiers de la PCH (ventes des DR, réceptions centrales). Aucun outil d'Adam : gestes d'écran.
  PCH_VENTES: { domaines: ["DATA"], mots: ["ventes pch", "vente dr", "demande non servie", "rupture pch", "receptions pch", "part de marche pch", "sell-in", "sell-out"] },
  // Cockpit Opérations (08/10) — une lecture transverse (ventes PCH, marchés, chaîne, force de vente) : les mêmes données.
  COCKPIT_OPERATIONS: { domaines: ["DATA"], mots: ["cockpit operations", "cockpit des operations", "execution des marches", "ruptures a 60 jours", "couverture chaine"] },
  PRODUCTS: { domaines: ["DIRECTORY"], mots: ["produit canonique", "referentiel produits", "vue 360 produit", "fiche produit"] },
  // Les demandes internes. `create_admin_request`, `support_operation`, `directive_operation`.
  ADMIN_REQUESTS: { domaines: ["ADMIN", "MISSION"], mots: ["secretariat", "demande administrative", "attestation", "ordre de mission"], outils: ["create_admin_request"] },
  SUPPORT: { domaines: ["ADMIN", "MISSION"], mots: ["support", "ticket", "tickets", "incident", "incidents", "panne"], outils: ["support_operation"] },
  DIRECTIVES: { domaines: ["ADMIN", "TEACH"], mots: ["directive", "directives", "note de service", "circulaire"], outils: ["directive_operation"] },
  // Les projets et le pôle marché. `dossier_operation` est REGULATORY, `bd_operation` DIRECTORY.
  // « Sujets » (Pilotage, anciennement « Projets ») : le mot d'avant reste compris.
  DOSSIERS: { domaines: ["REGULATORY", "MISSION"], mots: ["sujet", "sujets", "projet", "projets"], outils: ["dossier_operation"] },
  BUSINESS_DEVELOPMENT: { domaines: ["DIRECTORY", "REGULATORY", "DATA"], mots: ["market intelligence", "veille", "concurrence", "part de marche", "parts de marche"], outils: ["bd_operation"] },
  // Le registre des projets BD (§118.163) : des étiquettes par lesquelles on classe les dossiers
  // réglementaires — c'est donc Regulatory qui le lit, et `bd_operation` qui l'écrit.
  BD_PROJECTS: { domaines: ["REGULATORY", "DIRECTORY"], mots: ["registre des projets", "projet bd", "projets bd", "classement par projet"], outils: ["bd_operation"] },
  // Mon espace et mon équipe. `my_overview`, `list_my_tasks`, `list_my_requests` ; `read_employee`.
  WORKSPACE: { domaines: ["MISSION"], mots: ["mon espace", "mes taches", "mes demandes", "mon tableau de bord"], outils: ["my_overview", "list_my_tasks", "list_my_requests"] },
  MY_TEAM: { domaines: ["HR", "DIRECTORY"], mots: ["mon equipe", "mes collaborateurs", "mes subordonnes"], outils: ["org_operation"] },
  // Le concentrateur des annuaires : les personnes, les praticiens et les hôpitaux vivent tous
  // dans DIRECTORY ; les établissements se cherchent par `search_hospitals`.
  DIRECTORIES: { domaines: ["DIRECTORY"], mots: ["annuaires", "annuaire des partenaires", "annuaire des medecins", "annuaire des pharmaciens", "annuaire des etablissements", "carnet d adresses"], outils: ["directory_list", "directory_lookup", "search_hospitals"] },
  // Le bureau d'Adam lui-même et ce qu'il porte.
  CHIEF_OF_STAFF: { domaines: ["MISSION"], mots: ["chief of staff", "chef de cabinet"], outils: ["mission_status"] },
  NOTIFICATIONS: { domaines: ["MISSION"], mots: ["notification", "notifications", "alerte", "alertes"], outils: ["create_notification"] },
  PROCESS_INTELLIGENCE: { domaines: ["DATA", "ADMIN"], mots: ["process intelligence", "goulot", "goulots", "delai de traitement"], outils: ["process_insights"] },
  ADVENTUM_BRAIN: { domaines: ["REGULATORY", "SOURCES"], mots: ["adventum brain", "corpus", "arrete", "arretes", "journal officiel", "texte reglementaire", "textes reglementaires"], outils: ["search_knowledge_corpus", "read_corpus_document", "list_corpus_sources"] },
  // Les moyens généraux et le retour d'expérience : AUCUN outil dédié, et on le DIT. Une liste
  // vide n'est pas un oubli — c'est ce qui distingue « pas de capacité » de « capacité mal
  // routée » (§118.31), et le cliquet du banc la compte.
  GENERAL_MEANS: { domaines: [], mots: ["moyens generaux", "fourniture", "fournitures", "vehicule", "vehicules"] },
  FEEDBACK: { domaines: [], mots: ["feedback", "suggestion", "suggestions"] },
  // KPI & bilans (KPI sans code, Direction 08/10) : AUCUN outil d'Adam, par décision — noter une personne, signer sa
  // revue, valider ce qu'elle déclare sont des attestations d'un manager (§118.15), pas des gestes d'un modèle.
  KPI: { domaines: [], mots: ["kpi", "indicateur", "indicateurs", "bilan", "revue mensuelle", "score pondere", "objectifs"] },
  // Le site public (§118.158) : aucun outil d'Adam — publier sur le site public est un geste
  // d'écran, décidé par une personne (parité EXCLUDED, raison écrite dans `action-registry.ts`).
  SITE_WEB: { domaines: [], mots: ["site web", "site internet", "blog", "article de blog", "offre d emploi", "offres d emploi"] },
};

/** Les mots d'un libellé qui portent son identité — ni articles, ni ponctuation, ni « demandes ». */
const MOTS_VIDES_LIBELLE = new Set(["de", "du", "des", "la", "le", "les", "et", "en", "aux", "au", "my", "demandes", "demande", "centre", "bureau"]);

const plier = (s: string): string =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * LA PHRASE ENTIÈRE DU LIBELLÉ, PAS SES MOTS PRIS UN PAR UN.
 *
 * « Rapports terrain » découpé en mots ferait de « le rapport d'analyse CTD » une question de
 * force de vente. On exige donc TOUS les mots porteurs du libellé — c'est ce qui distingue le
 * nom d'un module d'un mot qu'il contient. Un libellé d'UN seul mot (« Legal », « Drive »,
 * « Sponsoring », « Consulting ») se reconnaît à ce mot, qui EST son nom.
 */
export function motsDuLibelle(libelle: string): string[] {
  return plier(libelle).split(" ").filter((m) => m.length >= 3 && !MOTS_VIDES_LIBELLE.has(m));
}

/** Le motif d'une expression : chaque mot au singulier ou au pluriel, dans l'ordre. */
const contient = (texte: string, expression: string): boolean => {
  const mots = plier(expression).split(" ").filter(Boolean);
  if (mots.length === 0) return false;
  const motif = mots.map((m) => `${m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?`).join("\\s+");
  return new RegExp(`\\b${motif}\\b`).test(texte);
};

/**
 * LES DOMAINES DES MODULES QUE LA PHRASE NOMME — avec la POSITION du mot, comme les autres
 * signaux, parce que c'est elle qui décide du domaine principal (« en français, le sujet de la
 * demande précède ses compléments »).
 *
 * Le texte reçu est DÉJÀ normalisé par l'appelant (`normalizeUtterance`) : le replier ici
 * changerait les positions, et une position fausse choisirait le mauvais domaine principal.
 */
export function signauxDesModules(texteNormalise: string): { domain: Domain; at: number }[] {
  const hits: { domain: Domain; at: number }[] = [];
  for (const [cle, service] of Object.entries(SERVICE_DU_MODULE) as [CleModule, ServiceDuModule][]) {
    if (service.domaines.length === 0) continue;
    const expressions = [MODULE_LABELS[cle], ...(service.mots ?? [])];
    let at = -1;
    for (const expression of expressions) {
      const mots = cle === "ADMIN" ? [] : motsDuLibelle(expression);
      const cible = expression === MODULE_LABELS[cle] ? mots.join(" ") : expression;
      if (!cible || !contient(texteNormalise, cible)) continue;
      const premier = plier(cible).split(" ")[0];
      const trouve = texteNormalise.search(new RegExp(`\\b${premier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      at = at < 0 ? Math.max(trouve, 0) : Math.min(at, Math.max(trouve, 0));
    }
    if (at < 0) continue;
    for (const d of service.domaines) hits.push({ domain: d, at });
  }
  return hits;
}

/**
 * LES OUTILS DES MODULES QUE LA PHRASE NOMME.
 *
 * Contrairement à `signauxDesModules`, cette lecture ne dépend PAS de l'échec du vocabulaire
 * écrit à la main : « quel est l'état des stocks ? » peut très bien faire reconnaître REGULATORY
 * par le mot « produit » et rester privée de `read_stock` — c'est exactement ce qui a été mesuré.
 * Deux questions, deux lectures : l'une dit QUEL DOMAINE ouvrir quand rien n'est reconnu, l'autre
 * dit QUEL OUTIL fait passer devant, et les confondre rendrait la seconde inutile là où elle sert.
 */
export function outilsDesModulesNommes(texteNormalise: string): string[] {
  const out = new Set<string>();
  for (const [cle, service] of Object.entries(SERVICE_DU_MODULE) as [CleModule, ServiceDuModule][]) {
    const outils = service.outils ?? [];
    if (outils.length === 0) continue;
    const expressions = [motsDuLibelle(MODULE_LABELS[cle]).join(" "), ...(service.mots ?? [])];
    if (!expressions.some((e) => e && contient(texteNormalise, e))) continue;
    for (const o of outils) out.add(o);
  }
  return [...out];
}
