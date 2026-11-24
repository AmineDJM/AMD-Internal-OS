/**
 * LE CENTRE DE PAIEMENT — la règle unique qui décide si un décaissement peut partir.
 *
 * Le principe : AUCUN paiement de la société ne quitte les Finances sans être passé par le centre,
 * tenu par la Direction générale (le Directeur Général et le Super Admin). **Sans exception, et quel que soit le montant.**
 *
 * ── POURQUOI LE SEUIL A DISPARU ────────────────────────────────────────────────────────────────
 *
 * Il existait un seuil de 50 000 DZD et une exemption pour les moyens généraux : au-dessous, l'ordre
 * filait directement aux Finances. L'intention était bonne — ne pas faire viser une facture de
 * 3 000 DZD par le PDG. L'effet ne l'était pas : le centre n'avait AUCUNE vue de ce que la société
 * décaissait réellement, et la question « combien sort ce mois-ci » n'avait de réponse que dans
 * l'écran de celui qui paie. Une porte qui laisse passer la moitié du flux n'est pas une porte.
 *
 * Le seuil survit comme un MARQUEUR (`isHighValue`), pas comme un filtre : il sert à trier la file
 * du centre, pas à la contourner. Si le volume devient un problème, la réponse sera une voie
 * rapide EXPLICITE et tracée — jamais une exemption silencieuse, qui est précisément ce qu'on
 * vient de retirer.
 *
 * Le centre AUTORISE, il ne paie pas : la comptabilité exécute ensuite le virement. Séparer les
 * deux gestes est ce qui rend le contrôle réel — celui qui autorise n'est pas celui qui décaisse.
 *
 * Module PUR — testé, sans base ni session. C'est délibéré : cette règle décide du départ de
 * l'argent de l'entreprise, elle doit pouvoir être lue et vérifiée sans rien exécuter.
 */

import { accesOuvertParLaConsole, type AccesStructurel } from "@/lib/rbac/acces-structurel";

/**
 * Le montant à partir duquel un paiement est dit IMPORTANT. Ce n'est plus un filtre — tout passe
 * par le centre — mais un repère : la file du centre met ces dossiers en tête.
 */
export const CENTRAL_AUTH_THRESHOLD_DZD = 50_000;

/** Ce paiement est-il de ceux qu'on regarde en premier ? Un montant illisible compte comme tel. */
export function isHighValue(amount: number): boolean {
  return !Number.isFinite(amount) || amount >= CENTRAL_AUTH_THRESHOLD_DZD;
}

/**
 * L'état d'un paiement vis-à-vis du centre.
 *
 * `NOT_REQUIRED` est désormais un état HISTORIQUE : il porte les ordres émis quand le seuil
 * existait encore et qui sont déjà réglés. Plus aucun ordre ne naît dans cet état. On le garde
 * parce qu'effacer le passé rendrait illisible tout ce qui a été payé avant la règle actuelle.
 */
export type CentralStatus =
  | "NOT_REQUIRED"      // HISTORIQUE : émis sous l'ancienne règle du seuil — plus aucun ordre n'y naît
  | "AWAITING_PROOF"    // AVANT le centre : le justificatif manque (facture, proforma, état de paie…) — `domaine/justificatif.ts`
  | "AWAITING"          // en attente d'une décision du centre
  | "CHANGES_REQUESTED" // le centre demande une révision du montant
  | "INFO_REQUESTED"    // le centre demande une argumentation
  | "APPROVED"
  | "REFUSED";

/** Ce que le centre peut décider. Quatre issues, pas deux : un refus sec bloque le travail. */
export type CentralDecision = "APPROVE" | "REFUSE" | "REQUEST_CHANGES" | "REQUEST_INFO";

export const CENTRAL_STATUS_LABEL: Record<CentralStatus, string> = {
  NOT_REQUIRED: "Sans autorisation requise",
  AWAITING_PROOF: "En attente du justificatif",
  AWAITING: "En attente du centre de paiement",
  CHANGES_REQUESTED: "Révision du montant demandée",
  INFO_REQUESTED: "Argumentation demandée",
  APPROVED: "Autorisé",
  REFUSED: "Refusé",
};

export const CENTRAL_DECISION_LABEL: Record<CentralDecision, string> = {
  APPROVE: "Autoriser le paiement",
  REFUSE: "Refuser",
  REQUEST_CHANGES: "Demander une révision du montant",
  REQUEST_INFO: "Demander une argumentation",
};

/**
 * Ce paiement doit-il être autorisé par le centre ? OUI — toujours.
 *
 * La signature garde ses paramètres : les appelants les passent déjà, et le jour où une voie
 * rapide sera décidée, elle se posera ICI, en un seul endroit, avec sa raison écrite. Une
 * fonction qui rend toujours vrai est plus honnête qu'un appelant qui aurait cessé de demander.
 */
export function needsCentralAuthorization(_input: { amount: number; module?: string | null }): boolean {
  return true;
}

/**
 * L'état d'un paiement au moment où il est émis : il attend le centre, sans exception — S'IL EST JUSTIFIÉ.
 *
 * JUSTIFICATIF OBLIGATOIRE (Super Admin, 24/11/2026) : « tant qu'il n'y a pas de justificatif, ça ne va même pas au centre
 * de paiement, donc pas aux Finances ». Sans pièce reconnue (`domaine/justificatif.ts`), l'ordre naît AVANT le centre,
 * `AWAITING_PROOF` : ni le centre ni les Finances ne le voient, et il y entre seul dès la pièce jointe
 * (`statutApresJustificatif`). `justifie` absent vaut « justifié » : seul `createExpenseOrder` émet, et il le passe toujours.
 */
export function initialCentralStatus(input: { amount: number; module?: string | null; justifie?: boolean }): CentralStatus {
  if (input.justifie === false) return "AWAITING_PROOF";
  return needsCentralAuthorization(input) ? "AWAITING" : "NOT_REQUIRED";
}

/**
 * LA PIÈCE EST LÀ : l'ordre entre au centre. Rend le nouvel état, ou `null` s'il n'y a rien à changer — un ordre qui
 * n'attendait pas son justificatif ne bouge pas, et une pièce RETIRÉE ne fait jamais ressortir un ordre déjà au centre
 * (on ne retire pas un dossier à celui qui décide en train de le lire).
 */
export function statutApresJustificatif(courant: CentralStatus, justifie: boolean): CentralStatus | null {
  return courant === "AWAITING_PROOF" && justifie ? "AWAITING" : null;
}

/** L'ordre attend-il son justificatif (donc PAS ENCORE au centre) ? */
export function attendJustificatif(status: string | null | undefined): boolean {
  return status === "AWAITING_PROOF";
}

/** Les états qui ne sont PAS au centre de paiement : l'historique d'avant le centre, et l'ordre sans justificatif. */
export const HORS_DU_CENTRE: readonly CentralStatus[] = ["NOT_REQUIRED", "AWAITING_PROOF"];

/**
 * LE VERROU. La comptabilité peut-elle exécuter ce décaissement ?
 *
 * C'est la seule fonction que les chemins de règlement doivent appeler. Tout le reste — seuil,
 * exemption, allers-retours — est déjà tranché dans l'état.
 */
export function canDisburse(status: CentralStatus): boolean {
  // `NOT_REQUIRED` reste payable : il ne porte plus que des ordres ANCIENS, émis sous la règle du
  // seuil et déjà autorisés par leur circuit d'alors. Les bloquer rétroactivement gèlerait des
  // dossiers clos ; aucun ordre neuf ne peut plus naître dans cet état.
  return status === "NOT_REQUIRED" || status === "APPROVED";
}

/**
 * Le paiement est-il visible des Finances ? SEULEMENT s'il est payable : autorisé par le centre (ou dispensé, pour
 * les ordres anciens). C'est `canDisburse`, et rien d'autre.
 *
 * Un REFUSÉ restait visible « pour savoir qu'il ne faut pas payer » (Super Admin, 24/11/2026 : défaut) — or le refus
 * laisse l'ordre « à régler » : il s'affichait dans la file avec un bouton « Payé », et comptait dans les montants. Ce
 * que le centre refuse n'arrive pas aux Finances ; le demandeur, lui, l'apprend du centre.
 */
export function visibleToFinance(status: CentralStatus): boolean {
  // Seuls les ordres PAYABLES (autorisés ou sans centre) : ni refusé, ni au centre, ni en attente de justificatif (24/11/2026).
  return canDisburse(status);
}

/**
 * UN ORDRE ANNULÉ N'EST PLUS AU CENTRE (Direction, 19/10/2026) — ni listé, ni compté, ni autorisable.
 *
 * Retirer sa demande de paiement annule son ordre (`annulerOrdreNonRegle` : `status = CANCELLED`) sans toucher à
 * l'autorisation, qui reste « en attente » — elle n'a jamais été rendue. Or le centre ne lisait QUE l'autorisation :
 * la demande retirée y restait listée, comptée dans « en attente », et un siège pouvait encore l'autoriser. Chaque
 * lecture du centre porte donc ce filtre, et chaque décision cette garde.
 */
export const ORDRE_NON_ANNULE = { status: { not: "CANCELLED" as const } };

/** Pourquoi le centre ne décide PAS sur cet ordre — `null` s'il le peut (son état d'exécution, pas son autorisation). */
export function refusOrdreFerme(status: string, reference?: string | null): string | null {
  const ref = reference ? ` ${reference}` : "";
  if (status === "CANCELLED") return `Le paiement${ref} a été annulé (demande retirée ou refusée) : il n'y a plus rien à autoriser.`;
  if (status === "PAID") return `Le paiement${ref} est déjà réglé : l'argent est parti.`;
  return null;
}

/** Le paiement attend-il une action DU CENTRE (par opposition à une action du demandeur) ? */
export function awaitsCentre(status: CentralStatus): boolean {
  return status === "AWAITING";
}

/** Le paiement attend-il une action DU DEMANDEUR ? */
export function awaitsRequester(status: CentralStatus): boolean {
  return status === "CHANGES_REQUESTED" || status === "INFO_REQUESTED";
}

/**
 * QUI SIÈGE AU CENTRE DE PAIEMENT — la Direction générale, et elle seule (Super Admin, 24/11/2026).
 *
 * « Centre de paiement : AUCUN siège par pôle. Il est réservé à la Direction générale = Super Admin + Directeur général
 * uniquement. » La décision précède la délégation de pouvoirs aux directeurs : l'argent doit avoir ses garde-fous AVANT que
 * d'autres mains n'engagent la société.
 *
 * Ce qui en sort, et pourquoi :
 *   • le PDG (`DIRECTION`) — le même rôle approuvait la demande, l'autorisait au centre et la réglait (ARGENT-06) : trois
 *     gestes, une personne. Il demande et approuve en amont ; il n'autorise plus ;
 *   • le SIÈGE NOMMÉ (`PaymentCentreSeat`) — les lignes restent en base (on n'efface rien), elles n'ouvrent plus rien ;
 *   • l'ACCÈS DONNÉ PAR LA CONSOLE à un autre rôle — la clé `PAYMENT_CENTRE` ne fait plus siéger qui n'est pas de la
 *     Direction générale. Elle garde un seul pouvoir : BLOQUER le Directeur Général (« un bloqué ne voit ni ne décide »).
 *
 * Le rôle SECONDAIRE compte (15/11/2026) : un Directeur Général porté en « autre rôle » est le Directeur Général. L'intérim,
 * lui, ne prête aucun rôle (`hr/stand-in.ts`) : ce siège ne se délègue pas.
 */
export interface PaymentCentreMember {
  role: string;
  /** L'« autre rôle » cumulé — un DG porté en rôle secondaire siège aussi. */
  secondaryRole?: string | null;
  /** L'accès effectif de la session — un BLOCAGE de la clé `PAYMENT_CENTRE` par la console y est résolu par `getAccess`. */
  access?: AccesStructurel;
}

/**
 * LES RÔLES DE LA DIRECTION GÉNÉRALE, qui siègent au centre — et qui sont prévenus quand un paiement l'attend : un siège
 * qu'on ne prévient pas ne siège qu'à moitié.
 */
export const ROLES_CENTRE_DE_PAIEMENT = ["GENERAL_MANAGER", "SUPER_ADMIN"] as const;

/**
 * SIÈGE-T-IL AU CENTRE ? Le rôle de Direction générale (principal ou secondaire), sauf blocage de la console.
 *
 * LE SUPER ADMIN, en rôle principal, siège toujours : c'est lui qui règle la console — se bloquer par mégarde fermerait le
 * centre à la seule personne qui peut le rouvrir. Sans accès résolu (règle appelée hors session, avec un simple
 * `{ role }`), on lit le rôle seul.
 */
export function sitsOnPaymentCentre(user: PaymentCentreMember): boolean {
  if (user.role === "SUPER_ADMIN") return true;
  const directionGenerale = [user.role, user.secondaryRole]
    .some((r) => r != null && (ROLES_CENTRE_DE_PAIEMENT as readonly string[]).includes(r));
  if (!directionGenerale) return false;
  // La console peut FERMER le centre au Directeur Général ; elle ne l'ouvre plus à personne d'autre.
  return accesOuvertParLaConsole(user.access, "PAYMENT_CENTRE", "VIEW") !== false;
}

/**
 * LE REFUS, ÉCRIT UNE SEULE FOIS — écran, action, assistant disent la même phrase, qui nomme qui siège et ce qu'il reste à
 * faire (§118.30).
 */
export const PAYMENT_CENTRE_REFUSAL =
  "Le centre de paiement est réservé à la Direction générale : seuls le Directeur Général et le Super Admin y voient la file "
  + "et y décident. Pour faire autoriser un paiement, déposez la demande : elle leur arrive d'elle-même, et vous la suivez "
  + "depuis son dossier.";

/**
 * LES MOTIFS DE REFUS QU'ON PROPOSE EN UN CLIC (Direction, 10/2026) — « refusé pour “non prioritaire” ou
 * autre commentaire ». Ce sont des RACCOURCIS d'écriture, pas une liste fermée : le motif reste un texte
 * libre, exigé par `decidePayment`, et le centre peut compléter ou écrire le sien.
 */
export const MOTIFS_REFUS_RAPIDES: readonly string[] = [
  "Non prioritaire",
  "Trésorerie insuffisante pour le moment",
  "Pièces justificatives insuffisantes",
  "Montant à justifier",
];

/**
 * L'état qui suit une décision.
 *
 * Le centre ne rend plus que DEUX décisions, autoriser ou refuser (décision de la Direction,
 * 02/09/2026 : le montant et sa justification appartiennent à la demande, pas à l'autorisation —
 * `isDecision` dans l'action). La règle garde les quatre transitions parce que des dossiers d'avant
 * portent encore « révision » ou « argumentation » : leur demandeur répond et le dossier revient au
 * centre (`applyResubmission`) — rien ne reste bloqué.
 *
 * Rend `null` si la transition n'a pas de sens (décision sur un dossier déjà clos) : l'appelant
 * doit alors refuser plutôt que d'écrire un état incohérent.
 */
export function applyDecision(current: CentralStatus, decision: CentralDecision): CentralStatus | null {
  // On ne décide pas d'un paiement qui n'avait pas à passer par le centre — ni d'un paiement qui n'y est pas
  // encore entré faute de justificatif (24/11/2026) : décider sans la pièce, c'est ce que la règle interdit.
  if (current === "NOT_REQUIRED" || current === "AWAITING_PROOF") return null;
  // Une décision rendue ne se rejoue pas — un refus se reprend par un nouvel envoi de la pièce
  // (la facture repart, audit 360° I8) : sans cette règle, deux administrateurs pourraient se
  // contredire sans trace.
  if (current === "APPROVED" || current === "REFUSED") return null;

  switch (decision) {
    case "APPROVE": return "APPROVED";
    case "REFUSE": return "REFUSED";
    case "REQUEST_CHANGES": return "CHANGES_REQUESTED";
    case "REQUEST_INFO": return "INFO_REQUESTED";
  }
}

/**
 * LE MONTANT D'UN ORDRE CHANGE APRÈS SA SOUMISSION — que devient son autorisation ? (§118.148)
 *
 * Le centre autorise un MONTANT, pas un dossier. Mesuré : le budget accordé d'un congrès se
 * modifie après la validation définitive, et l'action répercutait le nouveau montant sur l'ordre
 * de dépense sans toucher à son autorisation — un ordre autorisé à 500 000 DZD partait payé à
 * 900 000 aux Finances, et le centre n'avait jamais vu les 400 000 de plus. « Tous les paiements
 * passent par le centre » ne vaut rien si le montant qui part n'est pas celui qui y est passé.
 *
 * La règle, dans l'ordre :
 *   • BAISSER ne rouvre rien — c'est un geste qui RÉDUIT l'engagement, et le centre a déjà
 *     autorisé davantage ;
 *   • RELEVER un montant AUTORISÉ (ou d'un ordre HISTORIQUE non encore payé) le renvoie au centre :
 *     l'empreinte réelle d'un paiement ne dépasse jamais l'empreinte autorisée (§118.16) ;
 *   • en attente du centre, la balle y est déjà : il décidera sur le nouveau montant ;
 *   • révision ou argumentation demandée : la balle est au demandeur, sa resoumission ramènera le
 *     dossier au centre, qui verra alors le nouveau montant ;
 *   • REFUSÉ reste refusé : relever un montant refusé ne le rend pas acceptable, et un refus ne se
 *     contourne pas en retouchant le chiffre.
 *
 * Un montant ILLISIBLE compte comme une hausse — le sens sûr, comme `isHighValue`.
 */
export function statutApresNouveauMontant(input: {
  courant: CentralStatus; avant: number; apres: number;
}): CentralStatus {
  const { courant, avant, apres } = input;
  const monte = !Number.isFinite(avant) || !Number.isFinite(apres) || apres > avant;
  if (!monte) return courant;
  if (courant === "APPROVED" || courant === "NOT_REQUIRED") return "AWAITING";
  return courant;
}

/**
 * DEUX NOMS DÉSIGNENT-ILS LE MÊME BÉNÉFICIAIRE ? Casse, accents et espaces mis à part — rien de plus.
 *
 * « SARL Atlas » devenu « sarl  atlas » n'est pas un autre bénéficiaire : rouvrir l'autorisation pour
 * une coquille ferait re-décider le centre pour rien, et une garde qui crie pour rien cesse d'être lue
 * (§118.32). Mais on ne rapproche RIEN d'autre : « Atlas » et « SARL Atlas » peuvent être deux sociétés,
 * et deviner l'identité de celui qui reçoit l'argent est exactement ce que le centre existe pour éviter.
 */
export function memeBeneficiaire(a: string | null | undefined, b: string | null | undefined): boolean {
  const plie = (s: string | null | undefined) =>
    (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().replace(/\s+/g, " ").toLocaleLowerCase("fr");
  return plie(a) === plie(b);
}

/**
 * L'AUTORISATION APRÈS UNE RÉVISION DE L'ORDRE — le montant ET le bénéficiaire (§118.191, audit 360° R04).
 *
 * Le centre autorise un paiement : une somme, à quelqu'un. `statutApresNouveauMontant` tenait la somme ;
 * depuis que la demande de paiement se corrige, le BÉNÉFICIAIRE aussi, et l'argent partirait à un autre
 * que celui que le centre a vu. Changer de bénéficiaire rouvre donc une autorisation DONNÉE, exactement
 * comme une hausse — et ne rouvre rien d'autre : en attente, la balle est déjà au centre, qui verra le
 * nouveau nom ; refusé reste refusé (un refus ne se contourne pas en retouchant le dossier).
 */
export function statutApresRevision(input: {
  courant: CentralStatus; avant: number; apres: number;
  beneficiaireAvant: string | null | undefined; beneficiaireApres: string | null | undefined;
}): CentralStatus {
  const parMontant = statutApresNouveauMontant(input);
  if (parMontant !== input.courant) return parMontant;
  const autreBeneficiaire = !memeBeneficiaire(input.beneficiaireAvant, input.beneficiaireApres);
  if (autreBeneficiaire && (input.courant === "APPROVED" || input.courant === "NOT_REQUIRED")) return "AWAITING";
  return input.courant;
}

/**
 * Le demandeur peut-il resoumettre ? Seulement si le centre lui a rendu la main.
 *
 * Resoumettre depuis « en attente » permettrait de relancer indéfiniment un dossier que le centre
 * n'a pas encore regardé.
 */
export function canResubmit(status: CentralStatus): boolean {
  return awaitsRequester(status);
}

/** L'état après une nouvelle soumission du demandeur : la balle repasse au centre. */
export function applyResubmission(current: CentralStatus): CentralStatus | null {
  return canResubmit(current) ? "AWAITING" : null;
}

/**
 * La phrase qui explique à la comptabilité pourquoi elle ne peut pas payer.
 *
 * « Non autorisé » sans motif fait ouvrir un ticket ; en nommant l'état, le comptable sait s'il
 * doit attendre le centre, relancer le demandeur, ou classer le dossier.
 */
export function blockedReason(status: CentralStatus): string | null {
  switch (status) {
    case "AWAITING_PROOF": return "Ce paiement attend son justificatif (facture, proforma, état de paie…) : il n'est pas encore entré au centre de paiement.";
    case "AWAITING": return "Ce paiement attend l'autorisation du centre de paiement — tout décaissement y passe.";
    case "CHANGES_REQUESTED": return "Le centre de paiement a demandé une révision du montant : le demandeur doit corriger et resoumettre.";
    case "INFO_REQUESTED": return "Le centre de paiement a demandé une argumentation : le demandeur doit répondre et resoumettre.";
    case "REFUSED": return "Ce paiement a été refusé par le centre de paiement.";
    default: return null;
  }
}
