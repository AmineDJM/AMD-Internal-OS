import type { FamilleIa } from "../acces-regles";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES VEILLEURS DE L'ASSISTANT IA (J12, décision 0024) — ce qui mérite qu'on prévienne quelqu'un,
 * décidé par du CODE.
 *
 * Un veilleur est une RÈGLE sur les données de la personne (ses demandes, ses BC, ses échéances,
 * ses visites, ses collaborateurs directs) : « une demande Ad & Pro qui n'a pas bougé depuis 7 jours »,
 * « un budget consommé à 90 % ». Le modèle n'est jamais consulté pour décider s'il y a un problème —
 * la même situation donne toujours le même verdict, et l'écran peut dire pourquoi. Il n'est appelé
 * que pour RÉDIGER le point du matin (et l'écran a un texte de secours sans lui).
 *
 * ── LA SIGNATURE, OU POURQUOI UN PROBLÈME N'EST DIT QU'UNE FOIS ─────────────────────────
 *
 * Chaque constat porte une CLÉ stable : l'objet et l'état qui le rend problématique (le statut et
 * la date de son dernier changement, l'échéance, le palier de consommation). « Bloquée depuis 8
 * jours » puis « depuis 9 jours » est le MÊME constat : la clé ne bouge pas, rien n'est redit. Une
 * demande qui repart puis se bloque à nouveau change de date : c'est un constat neuf. Même motif
 * que les surveillances d'Adam (`missions/watch/rules.ts`), sans les importer : ce sont deux produits.
 *
 * Règles PURES (zéro import en valeur) : les lignes sont lues par `infra/proactivite/sources.ts`,
 * sous l'identité de la personne (ce qui est À ELLE), et l'horloge est un paramètre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const CODES_VEILLEUR = [
  "ADPRO_DEMANDE_BLOQUEE", "BUDGET_SEUIL", "BC_NON_SIGNE",
  "REG_ECHEANCE", "REG_RESERVE",
  "RH_FIN_ESSAI", "RH_CONTRAT_FIN",
  "FIN_PAIEMENT_RETARD", "FIN_DOUBLON_FACTURE",
  "TERRAIN_VISITE_NON_RAPPORTEE",
  "VALIDATION_EN_ATTENTE", "REUNION_PROCHE",
] as const;
export type CodeVeilleur = (typeof CODES_VEILLEUR)[number];
export const estCodeVeilleur = (v: unknown): v is CodeVeilleur => typeof v === "string" && (CODES_VEILLEUR as readonly string[]).includes(v);

export type Gravite = "INFO" | "ATTENTION" | "URGENT";
export const RANG_GRAVITE: Record<Gravite, number> = { INFO: 0, ATTENTION: 1, URGENT: 2 };

export type Pole = "AD_PRO" | "REGLEMENTAIRE" | "RH" | "FINANCES" | "TERRAIN" | "TOUS";
export const LIBELLE_POLE: Record<Pole, string> = {
  AD_PRO: "Ad & Pro", REGLEMENTAIRE: "Réglementaire", RH: "RH", FINANCES: "Finances", TERRAIN: "Terrain", TOUS: "Pour tous",
};

/** La fiche d'un veilleur — lue par l'écran « Ce que mon assistant surveille » et par la veille. */
export interface FicheVeilleur {
  code: CodeVeilleur;
  pole: Pole;
  libelle: string;
  /** Ce qu'il surveille, en une phrase lisible par la personne. */
  description: string;
  /** Les modules d'écran dont AU MOINS UN doit être ouvert (VIEW) — vide : la règle ne lit que ce qui est à la personne. */
  modules: string[];
  /** La famille de la console qui doit être ouverte à l'assistant pour cette personne. */
  famille: FamilleIa;
  /** Le seuil réglable (jours, pourcentage, minutes) et sa valeur par défaut. */
  seuil: { valeur: number; unite: "jours" | "%" | "minutes"; min: number; max: number };
  /** Actif par défaut quand la personne y a droit. */
  actifParDefaut: boolean;
}

export const VEILLEURS: readonly FicheVeilleur[] = [
  {
    code: "ADPRO_DEMANDE_BLOQUEE", pole: "AD_PRO", libelle: "Demande Ad & Pro bloquée",
    description: "Une de vos demandes (sponsoring, demande « autre ») n'a pas bougé depuis plus de N jours dans le circuit.",
    modules: ["SPONSORING", "AD_PRO_OTHER"], famille: "AD_PRO", seuil: { valeur: 7, unite: "jours", min: 2, max: 60 }, actifParDefaut: true,
  },
  {
    code: "BUDGET_SEUIL", pole: "AD_PRO", libelle: "Budget presque consommé",
    description: "Une ligne de budget dont vous êtes responsable atteint le seuil (90 % par défaut) — engagé compris.",
    modules: ["BUDGETS"], famille: "BUDGETS", seuil: { valeur: 90, unite: "%", min: 50, max: 100 }, actifParDefaut: true,
  },
  {
    code: "BC_NON_SIGNE", pole: "AD_PRO", libelle: "Bon de commande non signé",
    description: "Un bon de commande que vous avez émis attend sa signature depuis plus de N jours.",
    modules: ["PURCHASE_ORDERS", "LEGAL"], famille: "AD_PRO", seuil: { valeur: 3, unite: "jours", min: 1, max: 30 }, actifParDefaut: true,
  },
  {
    code: "REG_ECHEANCE", pole: "REGLEMENTAIRE", libelle: "Échéance réglementaire (ANPP)",
    description: "Une obligation d'un dossier que vous avez ouvert, ou l'échéance externe d'un produit dont vous êtes responsable, tombe dans N jours ou est dépassée.",
    modules: ["REGULATORY", "REGULATORY_PIPELINE"], famille: "REGLEMENTAIRE", seuil: { valeur: 14, unite: "jours", min: 1, max: 90 }, actifParDefaut: true,
  },
  {
    code: "REG_RESERVE", pole: "REGLEMENTAIRE", libelle: "Réserve non levée",
    description: "Un point de réserve ANPP qui vous est assigné reste ouvert plus de N jours après réception.",
    modules: ["REGULATORY", "REGULATORY_PIPELINE"], famille: "REGLEMENTAIRE", seuil: { valeur: 10, unite: "jours", min: 1, max: 90 }, actifParDefaut: true,
  },
  {
    code: "RH_FIN_ESSAI", pole: "RH", libelle: "Fin de période d'essai",
    description: "La période d'essai d'un de vos collaborateurs directs se termine dans N jours : confirmer, renouveler ou mettre fin.",
    modules: ["EMPLOYEES", "MY_TEAM"], famille: "FICHES", seuil: { valeur: 15, unite: "jours", min: 1, max: 60 }, actifParDefaut: true,
  },
  {
    code: "RH_CONTRAT_FIN", pole: "RH", libelle: "Contrat à renouveler",
    description: "Le CDD d'un de vos collaborateurs directs arrive à échéance dans N jours. Famille « Contrats RH » : ouverte par la Direction seulement.",
    modules: ["EMPLOYEES", "MY_TEAM"], famille: "CONTRATS_RH", seuil: { valeur: 30, unite: "jours", min: 1, max: 120 }, actifParDefaut: true,
  },
  {
    code: "FIN_PAIEMENT_RETARD", pole: "FINANCES", libelle: "Paiement en retard",
    description: "Une demande de paiement ou un ordre de dépense que vous avez émis a dépassé son échéance sans être payé.",
    modules: [], famille: "BUDGETS", seuil: { valeur: 0, unite: "jours", min: 0, max: 30 }, actifParDefaut: true,
  },
  {
    code: "FIN_DOUBLON_FACTURE", pole: "FINANCES", libelle: "Facture en double",
    description: "Deux factures enregistrées (N derniers jours) portent le même fournisseur et le même numéro, ou le même montant le même jour.",
    modules: ["LEGAL", "FINANCES"], famille: "BUDGETS", seuil: { valeur: 90, unite: "jours", min: 7, max: 365 }, actifParDefaut: true,
  },
  {
    code: "TERRAIN_VISITE_NON_RAPPORTEE", pole: "TERRAIN", libelle: "Visite non rapportée",
    description: "Une de vos visites planifiées est passée depuis plus de N jours sans compte rendu.",
    modules: ["MEDICAL", "FIELD_REPORTS", "SALES_PLANNING"], famille: "FICHES", seuil: { valeur: 1, unite: "jours", min: 0, max: 14 }, actifParDefaut: true,
  },
  {
    code: "VALIDATION_EN_ATTENTE", pole: "TOUS", libelle: "Validation qui traîne",
    description: "Une de vos demandes de validation attend le même validateur depuis plus de N jours. Peut être relancée sous mandat.",
    modules: ["VALIDATIONS"], famille: "ECRITURES", seuil: { valeur: 5, unite: "jours", min: 1, max: 60 }, actifParDefaut: true,
  },
  {
    code: "REUNION_PROCHE", pole: "TOUS", libelle: "Réunion dans l'heure",
    description: "Une réunion à laquelle vous participez commence dans environ N minutes : participants et points ouverts qui vous concernent.",
    modules: [], famille: "DRIVE", seuil: { valeur: 60, unite: "minutes", min: 15, max: 180 }, actifParDefaut: true,
  },
];

export const FICHE_VEILLEUR: ReadonlyMap<CodeVeilleur, FicheVeilleur> = new Map(VEILLEURS.map((v) => [v.code, v]));

/** Un constat — avant tout budget d'interruptions. */
export interface Constat {
  veilleur: CodeVeilleur;
  /** La signature : même clé = même constat, jamais redit. */
  cle: string;
  titre: string;
  detail: string;
  gravite: Gravite;
  lien: string | null;
  entite: { type: string; id: string } | null;
}

const JOUR_MS = 86_400_000;
const jours = (de: Date, a: Date): number => Math.floor((a.getTime() - de.getTime()) / JOUR_MS);
const ymd = (d: Date): string => d.toISOString().slice(0, 10);
const montant = (n: number): string => `${new Intl.NumberFormat("fr-FR").format(Math.round(n))} DZD`;
const pluriel = (n: number, mot: string): string => `${n} ${mot}${Math.abs(n) > 1 ? "s" : ""}`;

/**
 * LE SEUIL EFFECTIF : le seuil de la personne (ou celui par défaut), multiplié par le FACTEUR que ses
 * retours « pas utile » ont fait monter (un veilleur qui dérange trop attend plus longtemps avant de
 * parler). Borné par la fiche. Un pourcentage monte vers 100, il ne le dépasse pas.
 */
export function seuilEffectif(fiche: FicheVeilleur, seuilPersonne: number | null | undefined, facteur = 1): number {
  const base = typeof seuilPersonne === "number" && Number.isFinite(seuilPersonne) ? seuilPersonne : fiche.seuil.valeur;
  const f = Number.isFinite(facteur) && facteur > 0 ? facteur : 1;
  if (fiche.seuil.unite === "%") return Math.min(fiche.seuil.max, Math.max(fiche.seuil.min, Math.round(100 - (100 - base) / f)));
  if (fiche.seuil.unite === "minutes") return Math.min(fiche.seuil.max, Math.max(fiche.seuil.min, Math.round(base)));
  // Jours : un seuil de 0 (« dès le dépassement ») monte d'un jour par palier de facteur.
  return Math.min(fiche.seuil.max, Math.max(fiche.seuil.min, Math.round(base === 0 ? f - 1 : base * f)));
}

// ─────────────────────────────── Les lignes lues (infra) ───────────────────────────────

export interface LigneDemande { id: string; reference: string; nature: "SPONSORING" | "AUTRE"; titre: string; statut: string; majLe: Date; lien: string }
export interface LigneBudget { id: string; nom: string; initial: number; consomme: number; engage: number }
export interface LigneBc { id: string; reference: string; tiers: string | null; montant: number | null; circuitLe: Date }
export interface LigneEcheance { id: string; source: "OBLIGATION" | "PRODUIT"; titre: string; echeance: Date; lien: string }
export interface LigneReserve { id: string; titre: string; dossier: string; recueLe: Date; lien: string }
export interface LigneCollaborateur { id: string; nom: string; finEssai: Date | null; contrat: string | null; finContrat: Date | null }
export interface LignePaiement { id: string; source: "DEMANDE" | "ORDRE"; reference: string; beneficiaire: string | null; montant: number | null; echeance: Date; lien: string }
export interface LigneFacture { id: string; reference: string | null; fournisseur: string | null; montant: number | null; date: Date | null }
export interface LigneVisite { id: string; praticien: string; date: Date }
export interface LigneValidation { id: string; reference: string; titre: string; validateur: string | null; etapeId: string; depuis: Date }
export interface LigneReunion { id: string; source: "AGENDA" | "REUNION"; titre: string; debut: Date; participants: string[]; lien: string }

// ─────────────────────────────── Les règles ───────────────────────────────

export function demandesBloquees(lignes: readonly LigneDemande[], seuilJours: number, now: Date): Constat[] {
  return lignes.filter((l) => jours(l.majLe, now) > seuilJours).map((l) => {
    const n = jours(l.majLe, now);
    return {
      veilleur: "ADPRO_DEMANDE_BLOQUEE", cle: `${l.id}:${l.statut}:${l.majLe.toISOString()}`,
      titre: `${l.reference} n'a pas bougé depuis ${pluriel(n, "jour")}`,
      detail: `${l.nature === "SPONSORING" ? "Sponsoring" : "Demande Ad & Pro"} « ${l.titre} », au statut ${l.statut.toLowerCase().replace(/_/g, " ")}.`,
      gravite: n > seuilJours * 2 ? "URGENT" : "ATTENTION", lien: l.lien, entite: { type: l.nature === "SPONSORING" ? "SPONSORING" : "AD_PRO_OTHER", id: l.id },
    };
  });
}

/** Le palier de consommation (90, 100) entre dans la clé : franchir 100 % après 90 % est un constat neuf. */
export function budgetsAuSeuil(lignes: readonly LigneBudget[], seuilPct: number): Constat[] {
  const out: Constat[] = [];
  for (const l of lignes) {
    if (!(l.initial > 0)) continue;
    const pct = Math.round(((l.consomme + l.engage) / l.initial) * 100);
    if (pct < seuilPct) continue;
    const palier = pct >= 100 ? 100 : seuilPct;
    out.push({
      veilleur: "BUDGET_SEUIL", cle: `${l.id}:${palier}`,
      titre: pct >= 100 ? `Budget « ${l.nom} » dépassé (${pct} %)` : `Budget « ${l.nom} » consommé à ${pct} %`,
      detail: `${montant(l.consomme)} consommés et ${montant(l.engage)} engagés sur ${montant(l.initial)}.`,
      gravite: pct >= 100 ? "URGENT" : "ATTENTION", lien: "/budgets", entite: { type: "BUDGET_LINE", id: l.id },
    });
  }
  return out;
}

export function bcNonSignes(lignes: readonly LigneBc[], seuilJours: number, now: Date): Constat[] {
  return lignes.filter((l) => jours(l.circuitLe, now) > seuilJours).map((l) => ({
    veilleur: "BC_NON_SIGNE" as const, cle: `${l.id}:${l.circuitLe.toISOString()}`,
    titre: `BC ${l.reference} non signé depuis ${pluriel(jours(l.circuitLe, now), "jour")}`,
    detail: [l.tiers ? `Fournisseur : ${l.tiers}.` : null, l.montant ? `Montant : ${montant(l.montant)}.` : null].filter(Boolean).join(" ") || "En attente de signature.",
    gravite: "ATTENTION" as const, lien: `/bons-de-commande`, entite: { type: "LEGAL_DOCUMENT", id: l.id },
  }));
}

/** Deux paliers : « dans N jours » puis « dépassée » — chacun dit une fois. */
export function echeancesReglementaires(lignes: readonly LigneEcheance[], seuilJours: number, now: Date): Constat[] {
  const out: Constat[] = [];
  for (const l of lignes) {
    const reste = Math.ceil((l.echeance.getTime() - now.getTime()) / JOUR_MS);
    if (reste > seuilJours) continue;
    const depassee = reste < 0;
    out.push({
      veilleur: "REG_ECHEANCE", cle: `${l.source}:${l.id}:${ymd(l.echeance)}:${depassee ? "DEPASSEE" : "PROCHE"}`,
      titre: depassee ? `Échéance dépassée : ${l.titre}` : `Échéance ${reste === 0 ? "aujourd'hui" : `dans ${pluriel(reste, "jour")}`} : ${l.titre}`,
      detail: `Échéance du ${ymd(l.echeance)}.`, gravite: depassee || reste <= 2 ? "URGENT" : "ATTENTION",
      lien: l.lien, entite: { type: l.source === "OBLIGATION" ? "REGULATORY_OBLIGATION" : "REGULATORY_PRODUCT", id: l.id },
    });
  }
  return out;
}

export function reservesNonLevees(lignes: readonly LigneReserve[], seuilJours: number, now: Date): Constat[] {
  return lignes.filter((l) => jours(l.recueLe, now) > seuilJours).map((l) => ({
    veilleur: "REG_RESERVE" as const, cle: `${l.id}:${l.recueLe.toISOString()}`,
    titre: `Réserve ouverte depuis ${pluriel(jours(l.recueLe, now), "jour")} — ${l.dossier}`,
    detail: l.titre, gravite: "ATTENTION" as const, lien: l.lien, entite: { type: "REGULATORY_RESERVE_POINT", id: l.id },
  }));
}

export function finsDEssai(lignes: readonly LigneCollaborateur[], seuilJours: number, now: Date): Constat[] {
  const out: Constat[] = [];
  for (const l of lignes) {
    if (!l.finEssai) continue;
    const reste = Math.ceil((l.finEssai.getTime() - now.getTime()) / JOUR_MS);
    if (reste < 0 || reste > seuilJours) continue;
    out.push({
      veilleur: "RH_FIN_ESSAI", cle: `${l.id}:${ymd(l.finEssai)}`,
      titre: `Fin de période d'essai de ${l.nom} ${reste === 0 ? "aujourd'hui" : `dans ${pluriel(reste, "jour")}`}`,
      detail: `Le ${ymd(l.finEssai)} : confirmer, renouveler ou mettre fin, avec les RH.`,
      gravite: reste <= 3 ? "URGENT" : "ATTENTION", lien: "/mon-equipe", entite: { type: "EMPLOYEE", id: l.id },
    });
  }
  return out;
}

export function contratsAFin(lignes: readonly LigneCollaborateur[], seuilJours: number, now: Date): Constat[] {
  const out: Constat[] = [];
  for (const l of lignes) {
    if (l.contrat !== "CDD" || !l.finContrat) continue;
    const reste = Math.ceil((l.finContrat.getTime() - now.getTime()) / JOUR_MS);
    if (reste < 0 || reste > seuilJours) continue;
    out.push({
      veilleur: "RH_CONTRAT_FIN", cle: `${l.id}:${ymd(l.finContrat)}`,
      titre: `CDD de ${l.nom} : fin ${reste === 0 ? "aujourd'hui" : `dans ${pluriel(reste, "jour")}`}`,
      detail: `Échéance du contrat le ${ymd(l.finContrat)} : renouvellement à préparer avec les RH.`,
      gravite: reste <= 7 ? "URGENT" : "ATTENTION", lien: "/mon-equipe", entite: { type: "EMPLOYEE", id: l.id },
    });
  }
  return out;
}

export function paiementsEnRetard(lignes: readonly LignePaiement[], seuilJours: number, now: Date): Constat[] {
  return lignes.filter((l) => jours(l.echeance, now) > seuilJours).map((l) => {
    const n = jours(l.echeance, now);
    return {
      veilleur: "FIN_PAIEMENT_RETARD" as const, cle: `${l.source}:${l.id}:${ymd(l.echeance)}`,
      titre: `${l.reference} : paiement en retard de ${pluriel(n, "jour")}`,
      detail: [l.beneficiaire ? `Bénéficiaire : ${l.beneficiaire}.` : null, l.montant ? `Montant : ${montant(l.montant)}.` : null, `Échéance du ${ymd(l.echeance)}.`].filter(Boolean).join(" "),
      gravite: n > 15 ? "URGENT" as const : "ATTENTION" as const, lien: l.lien, entite: { type: l.source === "DEMANDE" ? "PAYMENT_REQUEST" : "EXPENSE_ORDER", id: l.id },
    };
  });
}

/** Un fournisseur ou un numéro ramené à sa forme comparable : casse, accents, espaces, tirets, zéros de tête. */
export const formeComparable = (s: string | null | undefined): string =>
  (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "").replace(/(^|[a-z])0+(?=\d)/g, "$1");

/**
 * LES DOUBLONS : même fournisseur ET (même numéro, ou même montant le même jour). La clé est la paire
 * triée : la même paire n'est dite qu'une fois, quel que soit l'ordre de lecture.
 */
export function doublonsDeFactures(lignes: readonly LigneFacture[]): Constat[] {
  const out: Constat[] = [];
  const vus = new Set<string>();
  const parFournisseur = new Map<string, LigneFacture[]>();
  for (const l of lignes) {
    const f = formeComparable(l.fournisseur);
    if (!f) continue;
    parFournisseur.set(f, [...(parFournisseur.get(f) ?? []), l]);
  }
  for (const groupe of parFournisseur.values()) {
    for (let i = 0; i < groupe.length; i++) {
      for (let j = i + 1; j < groupe.length; j++) {
        const a = groupe[i]!, b = groupe[j]!;
        const numero = formeComparable(a.reference) && formeComparable(a.reference) === formeComparable(b.reference);
        const montantJour = a.montant != null && a.montant === b.montant && a.date && b.date && ymd(a.date) === ymd(b.date);
        if (!numero && !montantJour) continue;
        const cle = [a.id, b.id].sort().join("+");
        if (vus.has(cle)) continue;
        vus.add(cle);
        out.push({
          veilleur: "FIN_DOUBLON_FACTURE", cle,
          titre: `Facture peut-être en double — ${a.fournisseur ?? "fournisseur"}`,
          detail: numero ? `Même numéro (${a.reference}) enregistré deux fois.` : `Même montant (${montant(a.montant ?? 0)}) le même jour, numéros ${a.reference ?? "?"} et ${b.reference ?? "?"}.`,
          gravite: numero ? "URGENT" : "ATTENTION", lien: "/legal", entite: { type: "LEGAL_DOCUMENT", id: a.id },
        });
      }
    }
  }
  return out;
}

export function visitesNonRapportees(lignes: readonly LigneVisite[], seuilJours: number, now: Date): Constat[] {
  return lignes.filter((l) => jours(l.date, now) > seuilJours).map((l) => ({
    veilleur: "TERRAIN_VISITE_NON_RAPPORTEE" as const, cle: `${l.id}:${ymd(l.date)}`,
    titre: `Visite du ${ymd(l.date)} sans compte rendu — ${l.praticien}`,
    detail: "Un vocal suffit : l'assistant en fait le compte rendu.", gravite: "INFO" as const,
    lien: "/field-reports", entite: { type: "MEDICAL_VISIT", id: l.id },
  }));
}

export function validationsEnAttente(lignes: readonly LigneValidation[], seuilJours: number, now: Date): Constat[] {
  return lignes.filter((l) => jours(l.depuis, now) > seuilJours).map((l) => ({
    veilleur: "VALIDATION_EN_ATTENTE" as const, cle: `${l.id}:${l.etapeId}`,
    titre: `${l.reference} attend ${l.validateur ?? "son validateur"} depuis ${pluriel(jours(l.depuis, now), "jour")}`,
    detail: `« ${l.titre} ».`, gravite: "ATTENTION" as const, lien: `/validations/${l.id}`, entite: { type: "VALIDATION_REQUEST", id: l.id },
  }));
}

/** « Une heure avant » : la réunion qui commence dans la fenêtre [seuil − 30 min, seuil + 15 min]. */
export function reunionsProches(lignes: readonly LigneReunion[], seuilMinutes: number, now: Date, pointsOuverts: (participants: string[]) => number = () => 0): Constat[] {
  const out: Constat[] = [];
  for (const l of lignes) {
    const dans = Math.round((l.debut.getTime() - now.getTime()) / 60_000);
    if (dans < Math.max(5, seuilMinutes - 30) || dans > seuilMinutes + 15) continue;
    const heure = new Date(l.debut.getTime() + 3_600_000).toISOString().slice(11, 16);
    const autres = l.participants.slice(0, 6);
    const points = pointsOuverts(l.participants);
    out.push({
      veilleur: "REUNION_PROCHE", cle: `${l.source}:${l.id}:${l.debut.toISOString()}`,
      titre: `Réunion « ${l.titre} » à ${heure}`,
      detail: [autres.length ? `Avec ${autres.join(", ")}${l.participants.length > autres.length ? "…" : ""}`.replace(/\.?$/, ".") : null,
        points ? `${points > 1 ? `${points} points ouverts` : "1 point ouvert"} de vos veilleurs concerne${points > 1 ? "nt" : ""} des participants.` : null].filter(Boolean).join(" ") || "À préparer.",
      gravite: "INFO", lien: l.lien, entite: { type: l.source === "AGENDA" ? "CALENDAR_EVENT" : "MEETING", id: l.id },
    });
  }
  return out;
}
