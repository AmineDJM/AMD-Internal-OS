/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BUDGET MARKETING — LA DÉPENSE D'UN POSTE AD & PRO : À IMPUTER → ENGAGÉE → CONSOMMÉE → PAYÉE (ou ANNULÉE).
 *
 * « On sépare absolument une dépense engagée d'une dépense payée. La source de vérité : après signature du bon de
 * commande d'un poste Ad & Pro, la Direction Marketing peut imputer cette dépense à un de ses budgets → elle s'affiche
 * ENGAGÉE. Ensuite on clique CONSOMMER, avec upload de la facture facultatif, et là c'est envoyé aux Finances, ou bien
 * ça suit le circuit classique (Direction Générale puis Finances). » (Direction, 10/2026 — maquette validée.)
 *
 * ── LES ÉTATS, ET OÙ CHACUN SE LIT ───────────────────────────────────────────────────────────
 *
 *   • À IMPUTER — le poste est accordé et TOUS ses bons de commande vivants sont signés (signé ⇔ `signedAt` posé : c'est
 *     la première règle de `etapeBC`, `bons-de-commande/regle.ts`), mais la Direction Marketing ne l'a pas encore imputé
 *     (`AdProItem.depenseImputeeLe` nul). Il ne pèse PAS sur le budget : « un poste n'entre au budget qu'une fois ses
 *     bons de commande signés et son imputation faite ».
 *   • ENGAGÉE — imputé (`depenseImputeeLe` + `budgetCategoryId` sur une catégorie d'une enveloppe MARKETING). Le montant
 *     engagé est la SOMME DE SES BC SIGNÉS.
 *   • CONSOMMÉE — un ORDRE DE DÉPENSE vivant existe pour le poste (posé par « Consommer », ou par la demande de paiement
 *     de la fiche du poste) et n'est pas entièrement réglé. Le montant consommé est celui de l'ordre (≤ l'engagé : la
 *     différence est rendue au budget). Rien n'est recopié : l'état se lit sur l'ordre lui-même.
 *   • PAYÉE — tous les ordres vivants du poste sont réglés (`PAID`) par les Finances.
 *   • ANNULÉE — la Direction Marketing a libéré l'engagement (`depenseAnnuleeLe`, motif facultatif). Refusé dès qu'un
 *     ordre vivant existe : on n'annule pas ce qui est parti en paiement.
 *
 * ── « CHEZ LA DG » : LE VRAI CIRCUIT, PAS UN CIRCUIT PARALLÈLE ────────────────────────────────
 *
 * La maquette faisait passer « au-dessus du seuil Ad & Pro » par la Direction Générale, sinon directement aux Finances.
 * Mesuré dans le code, ce n'est pas le circuit de l'argent :
 *   • le seuil Ad & Pro (`porteDgRequise`, `seuils/ad-pro.ts`) garde la DEMANDE (étape `dg` du circuit, centre de
 *     validation Ad & Pro) et le visa du BC — il a déjà joué quand le poste arrive ici, BC signés ;
 *   • le PAIEMENT, lui, passe TOUJOURS par le centre de paiement (§118.176, « guichet unique ») — tenu par le PDG, le DG et le
 *     Super Admin, sans seuil ni exemption (`payments/authorization.ts`) — puis par les Finances, qui règlent.
 * « Consommer » emprunte donc le chemin de paiement d'un poste (un ordre de dépense via `createExpenseOrder`, né
 * `AWAITING` au centre de paiement) et l'étape se nomme par l'endroit où l'ordre attend VRAIMENT :
 *   centre de paiement (`centralStatus` AWAITING) · réponse attendue du demandeur (CHANGES_REQUESTED / INFO_REQUESTED,
 *   dossiers d'avant le 02/09) · refusée au centre (REFUSED) · chez les Finances (APPROVED, ou NOT_REQUIRED historique,
 *   ordre non réglé) — puis Payée.
 *
 * ── LES TOTAUX — LES MÊMES DÉFINITIONS PARTOUT ───────────────────────────────────────────────
 *
 * La vue d'ensemble parle « payé » et « engagé, pas encore payé » ; l'onglet Dépenses coupe le second en deux :
 *   engagé (imputé, pas encore consommé) + consommé en circuit (ordres émis, pas réglés).
 * Consommé = payé + en circuit ; Disponible = budget − engagé − consommé = budget − payé − non payé : le même chiffre
 * dans les deux écrans (`tuilesDepenses`). Un poste à imputer ne pèse rien ; un poste annulé, rien non plus.
 *
 * Module PUR, sans aucun import : lu par les requêtes, les actions ET l'écran client.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const ETATS_DEPENSE = ["A_IMPUTER", "ENGAGEE", "CONSOMMEE", "PAYEE", "ANNULEE"] as const;
export type EtatDepense = (typeof ETATS_DEPENSE)[number];

/** Où attend une dépense consommée — le vrai guichet, lu sur l'ordre de dépense. */
export type LieuConsommation = "CENTRE_PAIEMENT" | "REPONSE_DEMANDEE" | "REFUSEE" | "FINANCES";

/**
 * Les statuts d'un ordre qui attend encore son règlement. Les MÊMES que `STATUTS_ORDRE_ENGAGES` (`budget/engage.ts`) —
 * recopiés pour garder ce module sans import, et un test vérifie qu'ils ne divergent pas.
 */
export const STATUTS_EN_CIRCUIT = ["PENDING", "REVISION_REQUESTED"] as const;

export interface BcDeLaDepense {
  id: string;
  montant: number | null;
  signe: boolean;
  annule: boolean;
}

export interface OrdreDeLaDepense {
  id: string;
  montant: number;
  /** `ExpenseOrder.status` : PENDING | REVISION_REQUESTED | PAID | CANCELLED. */
  statut: string;
  /** `ExpenseOrder.centralStatus` : l'autorisation du centre de paiement. */
  centralStatus: string | null;
}

export interface FaitsDepensePoste {
  /** Le poste est accordé (`status = APPROVED`). */
  accorde: boolean;
  bcs: readonly BcDeLaDepense[];
  montantAccorde: number | null;
  imputeeLe: string | Date | null;
  annuleeLe: string | Date | null;
  /** Les ordres de dépense du poste (son ordre, ceux qui le désignent, ceux de ses factures). */
  ordres: readonly OrdreDeLaDepense[];
}

export interface DepensePoste {
  /** `null` : le poste n'a pas sa place à l'écran (BC pas tous signés, poste non accordé). */
  etat: EtatDepense | null;
  lieu: LieuConsommation | null;
  /** La somme des BC signés — ce que l'imputation engage. */
  montantEngage: number;
  /** Ce qui pèse comme ENGAGÉ sur le budget (seulement à l'état Engagée). */
  engage: number;
  /** Ordres émis, pas encore réglés. */
  enCircuit: number;
  /** Ordres réglés. */
  paye: number;
  /** Consommé = en circuit + payé. */
  consomme: number;
}

const positif = (n: number | null | undefined): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);
const arrondi = (n: number): number => Math.round(n * 100) / 100;

/** En circuit : émis, pas réglé, pas annulé — et pas refusé par le centre (ARGENT-07 : un refus ne paiera jamais). */
export function ordreEnCircuit(statut: string | null | undefined, centralStatus?: string | null): boolean {
  return statut != null && (STATUTS_EN_CIRCUIT as readonly string[]).includes(statut) && centralStatus !== "REFUSED";
}

/** Les BC qui comptent : vivants (non annulés). */
export const bcsVivants = (bcs: readonly BcDeLaDepense[]): BcDeLaDepense[] => bcs.filter((b) => !b.annule);

/** Tous les BC vivants du poste sont-ils signés (et y en a-t-il au moins un) ? */
export function tousBcSignes(bcs: readonly BcDeLaDepense[]): boolean {
  const v = bcsVivants(bcs);
  return v.length > 0 && v.every((b) => b.signe);
}

/**
 * LE MONTANT ENGAGÉ = la somme des BC signés. Un BC sans montant lisible ne compte pour rien, sauf quand AUCUN n'en a :
 * le poste vaut alors son montant accordé — une donnée du poste, jamais une estimation (la règle de `budget-sources`).
 * Sans BC vivant (versement direct), le montant accordé.
 */
export function montantEngageDuPoste(bcs: readonly BcDeLaDepense[], montantAccorde: number | null): number {
  const v = bcsVivants(bcs);
  if (v.length === 0) return positif(montantAccorde);
  const signes = v.filter((b) => b.signe);
  if (signes.length === 0) return 0;
  if (signes.every((b) => b.montant == null)) return positif(montantAccorde);
  return arrondi(signes.reduce((a, b) => a + positif(b.montant), 0));
}

export function lieuDeLOrdre(o: Pick<OrdreDeLaDepense, "centralStatus">): LieuConsommation {
  switch (o.centralStatus) {
    case "AWAITING": return "CENTRE_PAIEMENT";
    case "CHANGES_REQUESTED":
    case "INFO_REQUESTED": return "REPONSE_DEMANDEE";
    case "REFUSED": return "REFUSEE";
    default: return "FINANCES";
  }
}

/** L'ÉTAT DE LA DÉPENSE D'UN POSTE, et ce qu'elle pèse — la seule lecture, pour l'écran comme pour les totaux. */
export function depenseDuPoste(f: FaitsDepensePoste): DepensePoste {
  const montantEngage = montantEngageDuPoste(f.bcs, f.montantAccorde);
  const vivants = f.ordres.filter((o) => o.statut !== "CANCELLED");
  const paye = arrondi(vivants.filter((o) => o.statut === "PAID").reduce((a, o) => a + positif(o.montant), 0));
  const attente = vivants.filter((o) => ordreEnCircuit(o.statut, o.centralStatus));
  // REFUSÉ PAR LE CENTRE (ARGENT-07) : l'ordre reste visible — la dépense se dit « refusée au centre de paiement » —
  // mais il ne pèse plus : ni en circuit, ni consommé. Il ne paiera jamais.
  const refuses = vivants.filter((o) => o.statut !== "PAID" && o.centralStatus === "REFUSED");
  const enCircuit = arrondi(attente.reduce((a, o) => a + positif(o.montant), 0));
  const base = { montantEngage, engage: 0, enCircuit, paye, consomme: arrondi(paye + enCircuit) };

  // L'argent est parti : l'ordre fait foi, quelle que soit l'imputation (un poste payé par sa fiche reste payé).
  if (vivants.length > 0) {
    if (attente.length > 0) return { ...base, etat: "CONSOMMEE", lieu: lieuDeLOrdre(attente[0]) };
    if (refuses.length > 0 && paye === 0) return { ...base, etat: "CONSOMMEE", lieu: "REFUSEE" };
    return { ...base, etat: "PAYEE", lieu: null };
  }
  if (f.annuleeLe) return { ...base, etat: "ANNULEE", lieu: null };
  if (f.imputeeLe) return { ...base, etat: "ENGAGEE", lieu: null, engage: montantEngage };
  if (f.accorde && tousBcSignes(f.bcs)) return { ...base, etat: "A_IMPUTER", lieu: null };
  return { ...base, etat: null, lieu: null };
}

// ───────────────────────────── Les libellés ─────────────────────────────

export const LIBELLE_LIEU: Record<LieuConsommation, string> = {
  CENTRE_PAIEMENT: "au centre de paiement",
  REPONSE_DEMANDEE: "réponse attendue au centre de paiement",
  REFUSEE: "refusée au centre de paiement",
  FINANCES: "chez les Finances",
};

export function libelleEtat(etat: EtatDepense, lieu: LieuConsommation | null): string {
  switch (etat) {
    case "A_IMPUTER": return "À imputer";
    case "ENGAGEE": return "Engagée";
    case "CONSOMMEE": return `Consommée · ${LIBELLE_LIEU[lieu ?? "CENTRE_PAIEMENT"]}`;
    case "PAYEE": return "Payée";
    case "ANNULEE": return "Annulée";
  }
}

/** Les étapes que suit une dépense consommée — toujours les mêmes : le centre de paiement, puis les Finances. */
export const ROUTE_CONSOMMATION = ["Consommée", "Centre de paiement (Direction Générale)", "Finances", "Payée"] as const;

export const PHRASE_ROUTE =
  "Comme tout paiement de la société, la dépense passe d'abord au centre de paiement, où la Direction Générale l'autorise ; "
  + "les Finances la règlent ensuite.";

// ───────────────────────────── Les filtres ─────────────────────────────

export const FILTRES_DEPENSE = [
  { cle: "TOUT", libelle: "Toutes" },
  { cle: "A_IMPUTER", libelle: "À imputer" },
  { cle: "ENGAGEE", libelle: "Engagées" },
  { cle: "CONSOMMEE", libelle: "Consommées" },
  { cle: "PAYEE", libelle: "Payées" },
  { cle: "ANNULEE", libelle: "Annulées" },
] as const;
export type CleFiltreDepense = (typeof FILTRES_DEPENSE)[number]["cle"];

export function passeLeFiltre(etat: EtatDepense, filtre: CleFiltreDepense): boolean {
  return filtre === "TOUT" || etat === filtre;
}

export function compterParFiltre(etats: readonly EtatDepense[]): Record<CleFiltreDepense, number> {
  const out = { TOUT: etats.length, A_IMPUTER: 0, ENGAGEE: 0, CONSOMMEE: 0, PAYEE: 0, ANNULEE: 0 } as Record<CleFiltreDepense, number>;
  for (const e of etats) out[e] += 1;
  return out;
}

// ───────────────────────────── Les gestes, et ce qui les refuse ─────────────────────────────

/** Le geste d'imputation : la première (À imputer → Engagée) ou un changement de budget. */
export type GesteImputation = "IMPUTER" | "CHANGER";

export function gesteImputation(etat: EtatDepense): GesteImputation | null {
  if (etat === "A_IMPUTER") return "IMPUTER";
  if (etat === "ENGAGEE" || etat === "CONSOMMEE" || etat === "PAYEE") return "CHANGER";
  return null;
}

/**
 * IMPUTER OU CHANGER DE BUDGET — `null` quand c'est permis. La cible est une catégorie d'une enveloppe MARKETING ; le
 * premier geste exige l'état « À imputer », le changement se fait à tout moment d'une dépense engagée, consommée ou payée.
 */
export function refusImputation(p: {
  etat: EtatDepense | null;
  geste: GesteImputation;
  cible: { id: string; domaine: string } | null;
  actuelleId: string | null;
}): string | null {
  if (!p.cible) return "Choisissez une catégorie du Budget Marketing.";
  if (p.cible.domaine !== "MARKETING") return "On n'impute une dépense Ad & Pro qu'à une catégorie d'une enveloppe du Budget Marketing.";
  if (p.etat === null) return "Ce poste n'a pas encore tous ses bons de commande signés : il ne s'impute qu'après la signature.";
  if (p.geste === "IMPUTER") {
    if (p.etat === "A_IMPUTER") return null;
    return p.etat === "ANNULEE" ? "Cette dépense est annulée." : "Cette dépense est déjà imputée : changez son budget.";
  }
  if (p.etat === "A_IMPUTER") return "Cette dépense n'est pas encore imputée : imputez-la d'abord.";
  if (p.etat === "ANNULEE") return "Une dépense annulée ne se range plus dans un budget.";
  if (p.cible.id === p.actuelleId) return "C'est déjà son budget.";
  return null;
}

/** Tolérance d'arrondi sur les montants (centimes). */
export const TOLERANCE = 0.005;

/** CONSOMMER — `null` quand c'est permis : une dépense engagée, un montant > 0 et ≤ l'engagé. */
export function refusConsommation(p: { etat: EtatDepense | null; montant: number | null | undefined; montantEngage: number }): string | null {
  if (p.etat === "CONSOMMEE" || p.etat === "PAYEE") return "Cette dépense est déjà consommée : son paiement est parti.";
  if (p.etat === "ANNULEE") return "Cette dépense est annulée.";
  if (p.etat !== "ENGAGEE") return "Seule une dépense engagée se consomme : imputez-la d'abord.";
  if (p.montant == null || !Number.isFinite(p.montant) || p.montant <= 0) return "Indiquez le montant consommé.";
  if (p.montant > p.montantEngage + TOLERANCE) return `Le montant consommé ne dépasse pas l'engagé (${Math.round(p.montantEngage).toLocaleString("fr-FR")} DZD).`;
  return null;
}

/** ANNULER — `null` quand c'est permis : seule une dépense engagée (pas encore consommée) s'annule. */
export function refusAnnulation(etat: EtatDepense | null): string | null {
  if (etat === "ENGAGEE") return null;
  if (etat === "CONSOMMEE" || etat === "PAYEE") return "Une dépense consommée ne s'annule plus : son paiement est parti au centre de paiement.";
  if (etat === "ANNULEE") return "Cette dépense est déjà annulée.";
  return "Seule une dépense engagée s'annule.";
}

/** Le motif d'annulation est facultatif ; on le borne. */
export const MOTIF_MAX = 500;

// ───────────────────────────── Les tuiles ─────────────────────────────

export interface Tuiles {
  budget: number;
  engage: number;
  consomme: number;
  paye: number;
  disponible: number;
}

/**
 * LES QUATRE TUILES à partir des totaux de l'enveloppe (`getBudgetOverview`) : `paye` = consommé réglé, `nonPaye` = ce
 * que la vue d'ensemble appelle « engagé, pas encore payé », `enCircuit` = la part de ce non-payé déjà consommée
 * (ordres émis). Disponible = budget − engagé − consommé — le même que celui de la vue d'ensemble.
 */
export function tuilesDepenses(t: { total: number; paye: number; nonPaye: number; enCircuit: number }): Tuiles {
  const enCircuit = Math.min(positif(t.enCircuit), positif(t.nonPaye));
  const engage = arrondi(positif(t.nonPaye) - enCircuit);
  const consomme = arrondi(positif(t.paye) + enCircuit);
  return { budget: t.total, engage, consomme, paye: positif(t.paye), disponible: arrondi(t.total - engage - consomme) };
}
