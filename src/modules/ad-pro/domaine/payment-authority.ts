/**
 * QUI DOIT VALIDER, ET QUI AUTORISE LE PAIEMENT.
 *
 * Deux idées que l'ancien circuit confondait, et dont tout le reste découle :
 *
 *   • VALIDATION MÉTIER ≠ AUTORISATION DE PAIEMENT. Le superviseur national et le chef de
 *     produit disent si une demande a du SENS ; la direction des opérations — puis la direction
 *     générale au-delà du seuil — engage l'ARGENT. Confondre les deux, c'est soit faire signer
 *     des dépenses à qui n'en répond pas, soit demander un avis métier à qui n'en a pas la
 *     compétence.
 *
 *   • AVIS ≠ VALIDATION. On peut consulter dix personnes sans fabriquer dix étapes. Un avis est
 *     tracé, notifié, lisible — et **ne bloque rien**. C'est ce qui permet de supprimer la
 *     bureaucratie sans perdre la consultation.
 *
 * RÈGLE CENTRALE : les finances ne peuvent jamais payer tant qu'une étape obligatoire de cette
 * chaîne n'est pas franchie. La chaîne se recalcule côté serveur à partir du MONTANT RÉEL — pas
 * de celui qu'un écran a affiché.
 *
 * Module PUR — testé. Le seuil est un paramètre, jamais une constante codée en dur.
 */

/** Nature de la dépense — c'est elle qui décide s'il y a un circuit, et lequel. */
export type PaymentDomain =
  /** Bordereau de versement Regulatory (ANPP). Circuit court : les finances, et elles seules. */
  | "REGULATORY_BV"
  /** Dépense d'exécution Ad & Pro : hôtel, visa, chambre, transport… */
  | "AD_PRO_EXECUTION"
  /** Fourniture, achat, moyens généraux, demande administrative. */
  | "SUPPLIES_ADMIN"
  /** Toute autre dépense hors Regulatory. */
  | "OTHER";

/** Qui a lancé la demande — la première validation en dépend, pas la dernière. */
export type InitiatorProfile =
  /** Délégué médical / KAM : sa demande passe d'abord par sa ligne métier. */
  | "FIELD_REP"
  /** Direction Marketing : il EST la ligne métier, il ne se valide pas lui-même deux fois. */
  | "PRODUCT_MANAGER"
  /** Ressources humaines / moyens généraux. */
  | "HR_SUPPLIES"
  | "OTHER";

export type Authority =
  | "NATIONAL_SUPERVISOR"
  | "PRODUCT_MANAGER"
  | "HR"
  | "OPERATIONS"
  | "GENERAL_MANAGEMENT"
  | "FINANCE";

/** Une étape VALIDE-t-elle le fond, ou ENGAGE-t-elle l'argent ? */
export type StepKind = "BUSINESS" | "PAYMENT";

export const AUTHORITY_LABEL: Record<Authority, string> = {
  NATIONAL_SUPERVISOR: "Superviseur national",
  PRODUCT_MANAGER: "Direction Marketing",
  HR: "Ressources humaines",
  OPERATIONS: "Direction des opérations",
  GENERAL_MANAGEMENT: "Direction générale",
  FINANCE: "Finances",
};

export interface ChainStep {
  order: number;
  authority: Authority;
  kind: StepKind;
  label: string;
  /** Pourquoi cette étape existe — un refus doit pouvoir s'expliquer sans lire le code. */
  reason: string;
  /**
   * Cette étape peut-elle être TRANSFÉRÉE à quelqu'un d'autre ? Seule la direction générale
   * l'est : elle délègue nominativement, et le transfert est daté et audité.
   */
  transferable: boolean;
}

export interface ChainInput {
  domain: PaymentDomain;
  initiator: InitiatorProfile;
  /** Montant réel engagé, en DZD. */
  amount: number;
}

/**
 * Seuil par défaut au-delà duquel la direction générale entre dans la chaîne.
 *
 * Valeur de DÉMARRAGE, pas une règle gravée : elle se règle en Console d'Administration. Un
 * seuil codé en dur oblige à livrer une version du logiciel pour changer un chiffre de gestion.
 */
export const DEFAULT_DG_THRESHOLD_DZD = 500_000;

/**
 * La chaîne de validation d'une dépense.
 *
 * Se lit de haut en bas : chaque étape doit être franchie dans l'ordre, et les finances ne
 * paient qu'après la dernière.
 */
export function buildPaymentChain(input: ChainInput, threshold = DEFAULT_DG_THRESHOLD_DZD): ChainStep[] {
  const steps: Omit<ChainStep, "order">[] = [];

  // ─── REGULATORY : circuit court, et c'est délibéré ───
  // Un bordereau de versement paie un droit réglementaire à l'ANPP : le montant n'est pas
  // négociable, l'opportunité non plus. Y ajouter la direction ne déciderait rien et ne ferait
  // que retarder un dépôt de dossier.
  if (input.domain === "REGULATORY_BV") {
    return [{
      order: 1,
      authority: "FINANCE",
      kind: "PAYMENT",
      label: "Paiement du bordereau de versement",
      reason: "Bordereau de versement Regulatory : montant réglementaire non négociable — les finances paient sur demande, sans validation hiérarchique.",
      transferable: false,
    }];
  }

  // ─── VALIDATION MÉTIER — elle dépend de QUI DEMANDE, jamais du montant ───
  if (input.initiator === "FIELD_REP") {
    // Une demande de terrain se juge d'abord sur sa pertinence commerciale, puis scientifique.
    steps.push({
      authority: "NATIONAL_SUPERVISOR",
      kind: "BUSINESS",
      label: "Validation du superviseur national",
      reason: "Demande émise par un délégué / KAM : sa ligne hiérarchique juge la pertinence terrain.",
      transferable: false,
    });
    steps.push({
      authority: "PRODUCT_MANAGER",
      kind: "BUSINESS",
      label: "Validation de la Direction Marketing",
      reason: "Demande émise par un délégué / KAM : la Direction Marketing juge la pertinence produit.",
      transferable: false,
    });
  } else if (input.initiator === "HR_SUPPLIES" || input.domain === "SUPPLIES_ADMIN") {
    steps.push({
      authority: "HR",
      kind: "BUSINESS",
      label: "Validation des ressources humaines",
      reason: "Fourniture / demande administrative : les ressources humaines jugent le besoin.",
      transferable: false,
    });
  }
  // La Direction Marketing qui demande lui-même ne repasse pas par une validation métier : il EST
  // la ligne métier. Le faire valider par lui-même serait un clic pour rien.

  // ─── AUTORISATION DE PAIEMENT — elle, dépend du MONTANT ───
  steps.push({
    authority: "OPERATIONS",
    kind: "PAYMENT",
    label: "Autorisation de la direction des opérations",
    reason: "Toute dépense hors Regulatory engage l'entreprise : la direction des opérations autorise l'engagement financier.",
    transferable: false,
  });

  if (input.amount > threshold) {
    steps.push({
      authority: "GENERAL_MANAGEMENT",
      kind: "PAYMENT",
      label: "Autorisation de la direction générale",
      reason: `Montant supérieur au seuil de ${threshold.toLocaleString("fr-FR")} DZD : la direction générale autorise en plus.`,
      transferable: true,
    });
  }

  return steps.map((s, i) => ({ ...s, order: i + 1 }));
}

/** Une décision déjà prise sur une étape. */
export interface ChainApproval {
  authority: Authority;
  decidedById: string;
  decidedAt: string;
  /** Renseigné quand la direction générale a transféré son autorisation à quelqu'un d'autre. */
  transferredFromUserId?: string | null;
  note?: string | null;
}

export interface ChainState {
  steps: ChainStep[];
  approvals: ChainApproval[];
  /** L'étape qui attend maintenant, ou null si la chaîne est complète. */
  current: ChainStep | null;
  done: ChainStep[];
  pending: ChainStep[];
  complete: boolean;
}

/** Où en est la chaîne : ce qui est fait, ce qui attend, ce qui reste. */
export function chainState(steps: ChainStep[], approvals: ChainApproval[]): ChainState {
  const approvedAuthorities = new Set(approvals.map((a) => a.authority));
  const done = steps.filter((s) => approvedAuthorities.has(s.authority));
  const pending = steps.filter((s) => !approvedAuthorities.has(s.authority));
  return {
    steps,
    approvals,
    done,
    pending,
    current: pending[0] ?? null,
    complete: pending.length === 0,
  };
}

export interface PayGate {
  ok: boolean;
  /** Ce qui manque, dit clairement — « non autorisé » n'indique à personne quoi faire. */
  reason?: string;
  missing: Authority[];
}

/**
 * LA GARDE DE PAIEMENT — le point d'étranglement unique.
 *
 * Les finances ne paient que si TOUTES les étapes obligatoires sont franchies. Cette fonction
 * est appelée côté serveur avant toute émission d'ordre de dépense : un écran, une URL forgée
 * ou un appel direct ne peuvent pas la contourner, puisque ce n'est pas l'écran qui décide.
 */
export function canPay(state: ChainState): PayGate {
  if (state.complete) return { ok: true, missing: [] };
  const missing = state.pending.map((s) => s.authority);
  return {
    ok: false,
    missing,
    reason: `Paiement impossible : il manque ${state.pending.map((s) => AUTHORITY_LABEL[s.authority]).join(", puis ")}.`,
  };
}

/**
 * Cette personne peut-elle franchir l'étape courante ?
 *
 * Trois conditions, et la troisième compte autant que les deux autres : c'est bien SON tour.
 * Autoriser une étape en avance viderait l'ordre de la chaîne de son sens — on pourrait faire
 * signer la direction générale avant que les opérations aient regardé.
 */
export function canDecideStep(
  state: ChainState,
  authoritiesOfUser: readonly Authority[],
  step: ChainStep | null = state.current,
): { ok: boolean; reason?: string } {
  if (!step) return { ok: false, reason: "La chaîne est déjà complète : il n'y a plus rien à valider." };
  if (state.current?.order !== step.order) {
    return { ok: false, reason: `Ce n'est pas encore le tour de « ${AUTHORITY_LABEL[step.authority]} » : ${AUTHORITY_LABEL[state.current!.authority]} doit se prononcer avant.` };
  }
  if (!authoritiesOfUser.includes(step.authority)) {
    return { ok: false, reason: `Cette étape revient à « ${AUTHORITY_LABEL[step.authority]} ».` };
  }
  return { ok: true };
}

/**
 * TRANSFERT D'UNE AUTORISATION — la direction générale, et elle seule.
 *
 * Le transfert est NOMINATIF : on désigne une personne, pas un rôle. Une autorisation qu'on
 * délègue à « la direction » ne se retrouve dans aucun journal, et personne n'en répond.
 */
export function canTransfer(
  step: ChainStep | null,
  authoritiesOfUser: readonly Authority[],
  targetUserId: string | null,
): { ok: boolean; reason?: string } {
  if (!step) return { ok: false, reason: "Aucune étape en attente." };
  if (!step.transferable) {
    return { ok: false, reason: `L'autorisation « ${AUTHORITY_LABEL[step.authority]} » ne se transfère pas.` };
  }
  if (!authoritiesOfUser.includes(step.authority)) {
    return { ok: false, reason: "Seul le titulaire de cette autorisation peut la transférer." };
  }
  if (!targetUserId) return { ok: false, reason: "Désignez la personne à qui vous transférez cette autorisation." };
  return { ok: true };
}

/**
 * UN AVIS — consultatif, tracé, et surtout NON BLOQUANT.
 *
 * C'est la soupape qui rend la simplification possible : la direction des opérations peut
 * consulter la Direction Marketing, ou n'importe qui d'autre, sans transformer cette consultation
 * en une étape de plus. L'avis est enregistré et visible ; la chaîne, elle, ne l'attend pas.
 */
export interface Advice {
  askedToUserId: string;
  askedById: string;
  askedAt: string;
  answeredAt?: string | null;
  opinion?: "FAVORABLE" | "UNFAVORABLE" | "RESERVED" | null;
  note?: string | null;
}

/** Un avis ne retient jamais un paiement — par construction, et c'est testé. */
export function adviceBlocksPayment(): false {
  return false;
}
