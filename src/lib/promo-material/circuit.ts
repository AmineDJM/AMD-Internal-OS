/**
 * LE CIRCUIT DU MATÉRIEL PROMOTIONNEL — deux versions, une seule chaîne de code.
 *
 * L'ancien circuit enchaînait seize statuts en file indienne : prospection, devis, choix d'agence,
 * bon de commande, validation finances, envoi, bordereau, paiement, production, conformité, visa,
 * BAT, matériel final, facture, règlement. Chacun attendait le précédent. Un poster mettait deux
 * mois à sortir, et personne ne savait jamais chez qui il dormait.
 *
 * ── CIRCUIT 1 (le circuit court, 09/2026) — celui des dossiers déjà en vol ──────────────────
 *
 *   Devis demandé → 1. demandeur → 2. Direction Marketing → 3. Directeur Général (au-dessus du
 *   seuil) → 4. PDG ou Super Admin → 5. Information médicale → [ BC ‖ paiement ‖ visa ] → terminé
 *
 * ── CIRCUIT 2 (§118.152) — celui des demandes nouvelles ──────────────────────────────────
 *
 * « Le demandeur crée la demande ; elle est validée — la directrice marketing pour quelqu'un du
 * marketing, sinon le N+1, jamais au-delà du directeur des opérations. Il clique sur « demander
 * les devis », qui partent à l'assistante de direction ; elle les retranscrit ligne à ligne. Le
 * demandeur valide un devis complet ou des lignes de plusieurs devis ; la Direction Marketing
 * valide — sauf si c'est elle qui demande ; au-delà du seuil Ad&Pro, le Directeur Général. Puis
 * les bons de commande sont générés par la plateforme, une facture par BC est obligatoire pour
 * demander un paiement, et chaque paiement part avec sa demande de visa ou de déclaration à
 * l'information médicale. »
 *
 *   0. validation de la demande → devis à demander → devis demandés (retranscription) →
 *   1. choix du demandeur → 2. Direction Marketing → 3. Directeur Général (au-dessus du seuil) →
 *   [ BC générés ‖ factures et paiements ‖ visas / déclarations ] → terminé
 *
 * Plus d'étape « PDG ou Super Admin », plus de validation de l'information médicale AVANT
 * l'exécution : la Direction a décrit le circuit entier, et l'information médicale y vient APRÈS
 * chaque paiement. Les dossiers du circuit 1 gardent pourtant leurs deux étapes : une demande en
 * vol garde la chaîne qui lui a été PROMISE (§118.142) — la lui retirer ferait sortir de l'argent
 * sans une validation que son demandeur savait devoir obtenir.
 *
 * ── POURQUOI UNE SEULE LISTE D'ÉTAPES ─────────────────────────────────────────────────────
 *
 * Les deux circuits sont deux TAMIS de la même colonne (§118.142) : l'ordre est le même, et
 * c'est `etapeApplicable` qui dit, selon la version, lesquelles ont lieu. Deux listes auraient
 * fait deux vérités sur l'ordre des étapes, et la seconde aurait pris du retard au premier ajout.
 *
 * LE SLUG `REVIEW_MANAGER` NE CHANGE PAS DE NOM : il est écrit en base sur tous les dossiers en
 * cours (§118.107). C'est la validation de la Direction Marketing.
 *
 * Module PUR — testé, sans base de données.
 */

import { porteDgRequise } from "@/lib/seuils/ad-pro";
import { ROLE_DIRECTION_MARKETING } from "@/lib/personnes/roles-vente";

/** Les étapes, dans L'ORDRE. Chaque version n'en traverse qu'une partie (`etapeApplicable`). */
export const PROMO_STEPS = [
  "REVIEW_REQUEST",      // 0. (v2) la DEMANDE est validée — N+1 plafonné, ou directrice marketing
  "QUOTE_TO_REQUEST",    //    (v2) le demandeur demande les devis au secrétariat
  "QUOTE_REQUESTED",     //    devis demandés — (v2) l'assistante les retranscrit
  "REVIEW_REQUESTER",    // 1. le demandeur valide (v2 : retient des lignes)
  "REVIEW_MANAGER",      // 2. la DIRECTION MARKETING valide (slug historique)
  "REVIEW_DG",           // 3. le Directeur Général AU-DESSUS DU SEUIL
  "REVIEW_EXECUTIVE",    // 4. (v1) le PDG OU le Super Admin
  "REVIEW_MEDICAL_INFO", // 5. (v1) l'information médicale
  "IN_EXECUTION",        // les trois chantiers parallèles courent
  "COMPLETED",
] as const;

export type PromoStep = (typeof PROMO_STEPS)[number];
export type PromoState = PromoStep | "REFUSED";
export type VersionCircuit = 1 | 2;

export const PROMO_STEP_LABEL: Record<PromoState, string> = {
  REVIEW_REQUEST: "Validation de la demande",
  QUOTE_TO_REQUEST: "Devis à demander",
  QUOTE_REQUESTED: "Devis demandés",
  REVIEW_REQUESTER: "Validation du demandeur",
  REVIEW_MANAGER: "Validation de la Direction Marketing",
  REVIEW_DG: "Validation du Directeur Général",
  REVIEW_EXECUTIVE: "Validation PDG / Super Admin",
  REVIEW_MEDICAL_INFO: "Validation information médicale",
  IN_EXECUTION: "En exécution (BC · paiement · visa)",
  COMPLETED: "Terminé",
  REFUSED: "Refusé",
};

/**
 * Les libellés que le CIRCUIT 2 affiche là où le sens a changé : au circuit 2, « devis demandés »
 * est la retranscription par l'assistante, et le demandeur ne « valide » pas un devis, il RETIENT
 * des lignes.
 */
const LIBELLE_V2: Partial<Record<PromoState, string>> = {
  QUOTE_REQUESTED: "Devis demandés — retranscription par l'assistante",
  REVIEW_REQUESTER: "Choix des lignes par le demandeur",
  IN_EXECUTION: "En exécution (BC · factures et paiements · visas)",
};

/** Le libellé d'une étape POUR la version du dossier. */
export function libelleEtape(state: PromoState, version: VersionCircuit): string {
  return (version === 2 ? LIBELLE_V2[state] : undefined) ?? PROMO_STEP_LABEL[state];
}

/** Les libellés COURTS de la frise — une étape par pastille ; le sens du circuit 2, en moins de mots. */
const COURT_V2: Partial<Record<PromoState, string>> = {
  QUOTE_REQUESTED: "Retranscription des devis",
  REVIEW_REQUESTER: "Choix des lignes",
  IN_EXECUTION: "Exécution",
};

export function libelleCourt(state: PromoState, version: VersionCircuit): string {
  return (version === 2 ? COURT_V2[state] : undefined) ?? PROMO_STEP_LABEL[state];
}

/** Les trois chantiers qui avancent EN PARALLÈLE une fois toutes les validations obtenues. */
export const PROMO_TRACKS = ["PURCHASE_ORDER", "PAYMENT", "AD_VISA"] as const;
export type PromoTrack = (typeof PROMO_TRACKS)[number];

export const PROMO_TRACK_LABEL: Record<PromoTrack, string> = {
  PURCHASE_ORDER: "Bon de commande",
  PAYMENT: "Demande de paiement",
  AD_VISA: "Demande de visa publicitaire",
};

/** Les chantiers du circuit 2 : un BC par devis, une facture par BC, une demande à l'IM par paiement. */
const TRACK_V2: Record<PromoTrack, string> = {
  PURCHASE_ORDER: "Bons de commande",
  PAYMENT: "Factures et paiements",
  AD_VISA: "Visa publicitaire ou déclaration à l'ANPP",
};

export function libelleChantier(t: PromoTrack, version: VersionCircuit): string {
  return version === 2 ? TRACK_V2[t] : PROMO_TRACK_LABEL[t];
}

/** Le rôle attendu à chaque étape de validation. */
export type Actor = "REQUEST_VALIDATOR" | "REQUESTER" | "DIRECTION_MARKETING" | "GENERAL_MANAGER" | "EXECUTIVE" | "MEDICAL_INFO";

const STEP_ACTOR: Partial<Record<PromoStep, Actor>> = {
  REVIEW_REQUEST: "REQUEST_VALIDATOR",
  REVIEW_REQUESTER: "REQUESTER",
  REVIEW_MANAGER: "DIRECTION_MARKETING",
  REVIEW_DG: "GENERAL_MANAGER",
  REVIEW_EXECUTIVE: "EXECUTIVE",
  REVIEW_MEDICAL_INFO: "MEDICAL_INFO",
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CONTEXTE D'UN DOSSIER — et pourquoi la règle se décide ICI, dans le module pur.
 *
 * Le contexte arrive du dehors (version, qui demande, combien, quel seuil) : ce module ne lit ni
 * la base ni les réglages, et c'est ce qui permet de l'éprouver sans décor. Mais la RÈGLE, elle,
 * vit ici — l'écrire chez l'appelant la ferait exister en deux exemplaires, un pour l'avance et un
 * pour l'affichage, et l'écran finirait par annoncer une étape que le circuit saute (§118.5).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export interface ContexteCircuit {
  /** La version du circuit du dossier — OBLIGATOIRE : un défaut ferait courir un dossier du
   *  circuit 2 sur les étapes du circuit 1 sans qu'une ligne ne le dise (§118.131). */
  version: VersionCircuit;
  /** Le DEMANDEUR est-il la cheffe de la Direction Marketing ? Alors elle ne valide pas sa propre
   *  demande (circuit 1 : porteuse du rôle ; circuit 2 : porteuse sans directrice au-dessus d'elle). */
  demandeurEstDirectionMarketing: boolean;
  /** (circuit 2) La demande exige-t-elle une validation hiérarchique (`validateurDeLaDemande`) ? */
  validationDemande?: boolean;
  /** Le montant engagé (circuit 2 : lignes retenues TTC ; circuit 1 : devis retenu, à défaut le
   *  budget global). `null` = inconnu. */
  montant: number | null;
  /** Le seuil au-delà duquel le Directeur Général valide. `null`/0 = aucune porte du DG. */
  seuilDg: number | null;
}

/** Les étapes que CETTE version traverse — la colonne, filtrée. */
const PROPRES_V1: readonly PromoStep[] = ["REVIEW_EXECUTIVE", "REVIEW_MEDICAL_INFO"];
const PROPRES_V2: readonly PromoStep[] = ["REVIEW_REQUEST", "QUOTE_TO_REQUEST"];

/**
 * CETTE ÉTAPE A-T-ELLE LIEU pour ce dossier ?
 *
 * Le défaut est OUI : une étape qu'on ne sait pas juger s'exécute. Sauter sur l'incertitude
 * retirerait une validation que personne n'a décidé de retirer.
 */
export function etapeApplicable(step: PromoStep, ctx: ContexteCircuit): boolean {
  if (ctx.version === 2 && PROPRES_V1.includes(step)) return false;
  if (ctx.version !== 2 && PROPRES_V2.includes(step)) return false;
  if (step === "REVIEW_REQUEST") return ctx.validationDemande !== false;
  if (step === "REVIEW_MANAGER") return !ctx.demandeurEstDirectionMarketing;
  if (step === "REVIEW_DG") {
    // LA RÈGLE VIENT DU SOCLE (`lib/seuils/ad-pro.ts`), lisible des deux domaines : la recopier
    // ici l'a fait diverger une fois déjà (§118.140) — le symptôme aurait été un matériel de
    // 1,2 M franchissant la porte qu'un sponsoring du même montant respecte.
    return porteDgRequise(ctx.montant, ctx.seuilDg);
  }
  return true;
}

/**
 * L'étape de départ.
 *
 * Circuit 2 : la validation de la demande si elle a lieu, sinon « devis à demander ».
 * Circuit 1 : un devis DÉJÀ en main saute la demande de devis.
 */
export function initialStep(input: { hasQuote: boolean } | { ctx: ContexteCircuit }): PromoStep {
  if ("ctx" in input) {
    if (input.ctx.version === 2) return etapeApplicable("REVIEW_REQUEST", input.ctx) ? "REVIEW_REQUEST" : "QUOTE_TO_REQUEST";
    return "QUOTE_REQUESTED";
  }
  return input.hasQuote ? "REVIEW_REQUESTER" : "QUOTE_REQUESTED";
}

/**
 * L'étape suivante dans la chaîne, ou `null` si l'on est au bout.
 *
 * Les étapes NON APPLICABLES sont franchies d'affilée : un dossier de la Direction Marketing
 * sous le seuil saute deux étapes d'un coup, et s'arrêter sur la première laisserait le dossier
 * posé sur une étape que personne ne peut valider — mort, sans une seule ligne d'échec.
 *
 * `ctx` est OBLIGATOIRE : lui donner une valeur par défaut ferait passer le prochain appelant
 * à côté des règles sans qu'une ligne ne le dise (§118.131).
 */
export function nextStep(current: PromoStep, ctx: ContexteCircuit): PromoStep | null {
  let i = PROMO_STEPS.indexOf(current);
  if (i < 0 || i >= PROMO_STEPS.length - 1) return null;
  for (i += 1; i < PROMO_STEPS.length; i += 1) {
    if (etapeApplicable(PROMO_STEPS[i], ctx)) return PROMO_STEPS[i];
  }
  return null;
}

/** Les étapes que CE dossier traverse, dans l'ordre — la frise de l'écran, la barre d'avancement. */
export function etapesDuDossier(ctx: ContexteCircuit): PromoStep[] {
  return PROMO_STEPS.filter((s) => etapeApplicable(s, ctx) || s === "IN_EXECUTION" || s === "COMPLETED");
}

/** Les personnes que la validation de CE dossier attend — lues par l'appelant, jamais devinées ici. */
export interface ValidateursDuDossier {
  requesterId: string | null;
  /** Circuit 1 : le N+1 figé à la création (historique — plus aucune étape ne le lit). */
  managerId?: string | null;
  /** Circuit 2, étape 0 : la personne figée. Nulle = la Direction des opérations (le plafond). */
  requestValidatorId?: string | null;
  /** Circuit 2, étape 2 : QUI valide le devis pour la Direction Marketing. `null`/absent = le rôle
   *  (toute porteuse, sauf le demandeur) — la conduite du circuit 1. */
  validateursMarketing?: readonly string[] | null;
  secondaryRole?: string | null;
}

/**
 * Qui peut valider CETTE étape ?
 *
 * Le Super Admin peut débloquer n'importe quelle étape : c'est ce qui évite qu'un circuit
 * s'arrête parce qu'une personne est absente, et c'est tracé au journal comme le reste. Personne
 * d'autre ne valide sa PROPRE demande au-delà du choix des lignes : un membre de la Direction
 * Marketing qui porte le rôle ne tranche pas son devis.
 */
export function canValidate(user: { id: string; role: string }, state: PromoState, ctx: ValidateursDuDossier): boolean {
  if (!estUneValidation(state)) return false;
  if (user.role === "SUPER_ADMIN") return true;
  return acteurDeLEtape(user, state, ctx);
}

/** L'étape est-elle une VALIDATION (un acteur la tranche) ? Les devis et l'exécution n'en sont pas. */
function estUneValidation(state: PromoState): boolean {
  if (state === "REFUSED" || state === "COMPLETED" || state === "IN_EXECUTION") return false;
  if (state === "QUOTE_REQUESTED" || state === "QUOTE_TO_REQUEST") return false; // ce ne sont pas des validations
  return STEP_ACTOR[state] !== undefined;
}

/**
 * CETTE PERSONNE EST-ELLE L'ACTEUR DÉSIGNÉ de l'étape — hors déblocage du Super Admin.
 *
 * `canValidate` répond « peut-elle valider ? », et le Super Admin le peut toujours : c'est ce qui
 * évite qu'un circuit s'arrête sur une absence. Mais « peut débloquer » n'est pas « c'est son
 * tour » : lister chez lui chaque dossier de chaque étape noierait sa file sous des suppléances,
 * exactement le bruit que le centre d'actions refuse ailleurs (une étape qui n'est pas encore à
 * vous n'est pas du travail à faire). Les deux questions lisent le MÊME aiguillage — une seconde
 * copie des acteurs finirait par désigner quelqu'un que l'action refuse (§118.5).
 */
export function acteurDeLEtape(user: { id: string; role: string }, state: PromoState, ctx: ValidateursDuDossier): boolean {
  if (!estUneValidation(state)) return false;
  const actor = STEP_ACTOR[state as PromoStep];
  if (!actor) return false;
  const porte = (r: string) => user.role === r || ctx.secondaryRole === r;
  switch (actor) {
    case "REQUEST_VALIDATOR":
      if (user.id === ctx.requesterId) return false;
      // Une personne NOMMÉE, figée à la création ; sinon le plafond — la Direction des opérations.
      return ctx.requestValidatorId ? user.id === ctx.requestValidatorId : porte("DIRECTION");
    case "REQUESTER": return user.id === ctx.requesterId;
    // LA DIRECTION MARKETING. Une liste nommée quand l'appelant l'a lue (la directrice du
    // demandeur, ou les cheffes) ; sinon le RÔLE — la décision de la Direction (09/2026). Le rôle
    // secondaire compte : refuser une casquette portée en plus bloquerait un circuit sur une
    // convention d'attribution de rôle.
    case "DIRECTION_MARKETING":
      if (user.id === ctx.requesterId) return false;
      if (ctx.validateursMarketing) return ctx.validateursMarketing.includes(user.id);
      return porte(ROLE_DIRECTION_MARKETING);
    case "GENERAL_MANAGER": return user.role === "GENERAL_MANAGER";
    // « PDG OU Super Admin » (circuit 1) : le Super Admin est ACTEUR NOMMÉ de cette étape, pas
    // seulement son débloqueur — son tour se lit donc ici aussi. Pour `canValidate` rien ne
    // change : il pouvait déjà tout débloquer.
    case "EXECUTIVE": return user.role === "DIRECTION" || user.role === "SUPER_ADMIN";
    case "MEDICAL_INFO": return user.role === "MEDICAL_INFO_PHARMACIST";
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUI FAIT QUOI SUR UN DOSSIER — les gestes qui ne sont PAS des validations (circuit 2, §118.152).
 *
 * Demander les devis, les retranscrire, choisir les lignes, piloter l'exécution : quatre règles
 * d'acteur, écrites UNE fois. La fiche les lit pour montrer un bouton, les actions pour refuser un
 * geste : deux lectures finiraient par montrer un bouton que l'action refuse (§118.5).
 * `vueGlobale` arrive tranché — la règle de la vue globale vit dans `rbac.ts`, qui lit la base.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export interface Acteur {
  id: string;
  role: string;
  secondaryRole?: string | null;
  /** `hasGlobalView(user.role)` — la Direction et le Super Admin. */
  vueGlobale: boolean;
}

const tientLeSecretariat = (u: Acteur) => u.role === "DIRECTION_ASSISTANT" || u.secondaryRole === "DIRECTION_ASSISTANT";

/** DEMANDER LES DEVIS au secrétariat — le demandeur, la Direction en suppléance. */
export function demandeLesDevis(u: Acteur, pm: { requesterId: string | null }): boolean {
  return u.id === pm.requesterId || u.vueGlobale;
}

/**
 * RETRANSCRIRE LES DEVIS — l'assistante nommée sur le dossier, toute assistante de direction (elle
 * tient le secrétariat), la Direction en suppléance. JAMAIS le demandeur, sauf le Super Admin en
 * déblocage : celui qui recopie les prix ne doit pas être celui qui les retient ensuite — c'est
 * toute la raison d'être d'une retranscription faite par quelqu'un d'autre.
 */
export function retranscritLesDevis(u: Acteur, pm: { requesterId: string | null; assistantId: string | null }): boolean {
  if (u.id === pm.requesterId && u.role !== "SUPER_ADMIN") return false;
  return u.id === pm.assistantId || tientLeSecretariat(u) || u.vueGlobale;
}

/** CHOISIR LES LIGNES (et demander une correction) — le demandeur ; le Super Admin en déblocage. */
export function choisitLesLignes(u: Acteur, pm: { requesterId: string | null }): boolean {
  return u.id === pm.requesterId || u.role === "SUPER_ADMIN";
}

/** PILOTER L'EXÉCUTION ET LES CHANTIERS — le demandeur, l'assistante de direction, la Direction. */
export function piloteLExecution(u: Acteur, pm: { requesterId: string | null }): boolean {
  return u.id === pm.requesterId || tientLeSecretariat(u) || u.vueGlobale;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * À QUI EST-CE LE TOUR ? — la question du centre d'actions, posée au circuit (§118.153).
 *
 * Le centre d'actions (« Validations à faire » de l'accueil, la boîte de décisions, et ce qu'Adam
 * répond à « qu'est-ce que j'ai à valider ? ») lisait le STATUT de l'ancien circuit. Un dossier à
 * circuit ne fait jamais avancer ce statut : il restait « Prospection demandée » pour toujours, si
 * bien que le dossier figurait chez TOUS les porteurs de la validation du module — le Directeur
 * Général le voyait encore « à valider » après l'avoir validé, la directrice marketing aussi — et
 * chez AUCUN de ceux dont c'était réellement le tour : le N+1 et l'assistante de direction n'ont
 * pas le module, donc la section ne s'ouvrait même pas pour eux. Mesuré en parcours réel.
 *
 * La règle vit ICI, à côté des gestes : `acteurDeLEtape` pour les validations (le même aiguillage
 * que `canValidate`), et les mêmes acteurs que les gestes non validants — deux lectures d'« à qui
 * revient ce dossier » finiraient par montrer un dossier à quelqu'un que l'action refuse (§118.5).
 *
 * Ce qui N'EST PAS un tour, délibérément :
 *   • la SUPPLÉANCE — la Direction peut demander les devis à la place du demandeur, le Super Admin
 *     peut débloquer toute étape : c'est un pouvoir, pas une file. Lister chez eux chaque dossier
 *     de chaque étape noierait ce qui leur revient vraiment ;
 *   • l'EXÉCUTION — les BC, factures et paiements ont leurs propres files (Finances, centres de
 *     validation et de paiement) ; un dossier en exécution n'est pas une décision qui attend.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export type TourPromo = "VALIDATION" | "GESTE";

export function tourDe(
  u: Acteur,
  state: PromoState,
  pm: { requesterId: string | null; assistantId: string | null; returnedAt: Date | string | null },
  validateurs: ValidateursDuDossier,
  version: VersionCircuit,
): TourPromo | null {
  // RENVOYÉE POUR CORRECTION à la validation de la demande (§118.190) : l'étape n'a pas changé, la
  // balle si — elle est chez le demandeur, qui corrige puis resoumet ; le validateur n'a rien à
  // trancher tant que la correction n'est pas revenue (son geste serait refusé).
  if (state === "REVIEW_REQUEST" && pm.returnedAt) return u.id === pm.requesterId ? "GESTE" : null;
  switch (state) {
    case "QUOTE_TO_REQUEST":
      return u.id === pm.requesterId ? "GESTE" : null;
    case "QUOTE_REQUESTED":
      // Circuit 2 : la RETRANSCRIPTION — l'assistante nommée, ou le secrétariat quand personne ne
      // l'est ; jamais le demandeur (il retient ensuite les prix qu'il aurait recopiés).
      if (version === 2) {
        if (u.id === pm.requesterId) return null;
        return (pm.assistantId ? u.id === pm.assistantId : tientLeSecretariat(u)) ? "GESTE" : null;
      }
      // Circuit 1 : on attend le devis de l'agence — l'assistante nommée le dépose, à défaut le demandeur.
      return u.id === (pm.assistantId ?? pm.requesterId) ? "GESTE" : null;
    default:
      // `secondaryRole` des validateurs est celui de la personne qui AGIT (convention de
      // `canValidate`) : c'est donc le sien qu'on passe, jamais celui d'un autre.
      return acteurDeLEtape(u, state, { ...validateurs, secondaryRole: u.secondaryRole ?? null }) ? "VALIDATION" : null;
  }
}

/**
 * QUI VOIT QUOI — et c'est la partie qui compte autant que le circuit lui-même.
 *
 * Le circuit COMPLET n'est visible que de l'administrateur et du PDG. Les autres voient l'étape
 * en cours et ce qui les concerne : un délégué n'a pas à savoir que la comptabilité a mis onze
 * jours à signer, et afficher toute la chaîne à tout le monde transforme un outil de travail en
 * tableau de surveillance mutuelle.
 */
export function seesFullCircuit(user: { role: string }): boolean {
  return user.role === "SUPER_ADMIN" || user.role === "DIRECTION";
}

/**
 * Les étapes qu'une personne donnée peut lire.
 *
 * Pour qui ne voit pas tout : l'étape en cours seulement — assez pour savoir où en est le dossier,
 * pas assez pour reconstituer qui a traîné.
 */
export function visibleSteps(user: { role: string }, state: PromoState, ctx?: ContexteCircuit): PromoState[] {
  if (seesFullCircuit(user)) return ctx ? etapesDuDossier(ctx) : [...PROMO_STEPS];
  return [state];
}

/** Les chemins parallèles sont-ils ouverts ? Seulement une fois TOUTES les validations obtenues. */
export function tracksOpen(state: PromoState): boolean {
  return state === "IN_EXECUTION";
}

/**
 * Le dossier est-il terminé ? Quand les trois chantiers sont clos.
 *
 * Ils avancent indépendamment : c'est tout l'intérêt. Mais le dossier n'est fini que lorsque le
 * dernier l'est — sans quoi on classerait une commande dont le visa n'est jamais arrivé.
 */
export function allTracksDone(done: readonly PromoTrack[]): boolean {
  return PROMO_TRACKS.every((t) => done.includes(t));
}

/** Ce qu'il reste à faire, nommé — « en exécution » tout seul ne dit pas quoi relancer. */
export function pendingTracks(done: readonly PromoTrack[]): PromoTrack[] {
  return PROMO_TRACKS.filter((t) => !done.includes(t));
}

/**
 * La progression, en pas franchis sur le total DES ÉTAPES DE CE DOSSIER — pour une barre honnête.
 *
 * Le total se compte sur les étapes que le dossier traverse, pas sur la colonne entière : un
 * dossier du circuit 2 qui en a fini avec ses validations serait sinon affiché « 6/10 », un
 * dénominateur qui ment (§118.51). Sans contexte, on retombe sur la colonne (lecture ancienne).
 *
 * `IN_EXECUTION` compte les chantiers clos : rester bloqué à « 5/7 » pendant trois semaines
 * pendant que deux chantiers sur trois sont finis donnerait une image fausse de l'avancement.
 */
export function progress(state: PromoState, done: readonly PromoTrack[], ctx?: ContexteCircuit): { step: number; total: number } {
  const etapes: readonly PromoStep[] = ctx ? etapesDuDossier(ctx) : PROMO_STEPS;
  const total = etapes.length;
  if (state === "REFUSED") return { step: 0, total };
  if (state === "COMPLETED") return { step: total, total };
  const i = Math.max(0, etapes.indexOf(state as PromoStep)) + 1;
  if (state !== "IN_EXECUTION") return { step: i, total };
  // Entre « en exécution » et « terminé », on répartit selon les chantiers clos.
  const share = done.length / PROMO_TRACKS.length;
  return { step: Math.round(i + share), total };
}

/** Le libellé de l'attente : « on attend qui ? », la seule question qu'on pose à un circuit. */
export function waitingOn(state: PromoState, done: readonly PromoTrack[], version: VersionCircuit = 1): string {
  if (state === "REFUSED") return "Dossier refusé";
  if (state === "COMPLETED") return "Rien — dossier terminé";
  if (state === "QUOTE_TO_REQUEST") return "Le demandeur — la demande de devis n'est pas partie : il l'envoie depuis « Articles demandés »";
  if (state === "QUOTE_REQUESTED") return version === 2 ? "L'assistante de direction — retranscription des devis" : "Le devis de l'agence";
  if (state === "IN_EXECUTION") {
    const rest = pendingTracks(done);
    return rest.length === 0 ? "Rien — clôture en cours" : rest.map((t) => libelleChantier(t, version)).join(" · ");
  }
  return libelleEtape(state, version);
}
