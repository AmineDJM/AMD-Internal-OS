/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FIN DE CONTRAT D'UN SALARIÉ — LES RÈGLES (Super Admin, 24/11/2026 — lot rhdepart).
 *
 * « Il faut que ça soit tout automatique. Depuis la fiche du salarié […] on peut valider sa fin de contrat. Triple
 * validation : RH, supérieur hiérarchique et DG. Dans ce cas, on a la liste des choses qu'on doit récupérer […], le
 * solde de tout compte qui s'affiche, le certificat de travail qui s'affiche, […] toujours tout modifiable. »
 *
 * Ce module dit : les motifs, l'ordre du circuit (qui valide, dans quel ordre, quand une marche se confond avec une
 * autre), ce que la liste de sortie contient d'après les données réelles, ce que le solde de tout compte préremplit
 * (sans calcul de paie : la paie se calcule ailleurs) et quand le compte se ferme.
 *
 * PUR, SANS AUCUN IMPORT : le formulaire de la fiche (navigateur) et le serveur lisent la même règle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** La nature de la demande de validation (`ValidationRequest.objectType`) — recopiée dans `labels/commun.ts`. */
export const OBJET_DEPART_SALARIE = "DEPART_SALARIE";

export const MOTIFS_DEPART = ["FIN_CDD", "DEMISSION", "LICENCIEMENT", "RUPTURE", "RETRAITE", "FIN_ESSAI", "AUTRE"] as const;
export type MotifDepart = (typeof MOTIFS_DEPART)[number];
export const LIBELLE_MOTIF_DEPART: Record<MotifDepart, string> = {
  FIN_CDD: "Fin de CDD",
  DEMISSION: "Démission",
  LICENCIEMENT: "Licenciement",
  RUPTURE: "Rupture d'un commun accord",
  RETRAITE: "Départ à la retraite",
  FIN_ESSAI: "Fin de période d'essai",
  AUTRE: "Autre motif",
};

export const STATUTS_DEPART = ["EN_VALIDATION", "A_CORRIGER", "REFUSE", "VALIDE", "ANNULE"] as const;
export type StatutDepart = (typeof STATUTS_DEPART)[number];
/** Les états où la fin de contrat est VIVANTE : on n'en ouvre pas une seconde. */
export const STATUTS_DEPART_OUVERTS: readonly StatutDepart[] = ["EN_VALIDATION", "A_CORRIGER", "VALIDE"];
export const LIBELLE_STATUT_DEPART: Record<StatutDepart, { label: string; tone: "info" | "warning" | "danger" | "success" | "neutral" }> = {
  EN_VALIDATION: { label: "En validation", tone: "info" },
  A_CORRIGER: { label: "À corriger", tone: "warning" },
  REFUSE: { label: "Refusée", tone: "danger" },
  VALIDE: { label: "Validée", tone: "success" },
  ANNULE: { label: "Annulée", tone: "neutral" },
};

/** Le statut que prend la fin de contrat quand sa demande de validation se clôt. */
export function statutApresValidation(statutValidation: string): StatutDepart | null {
  switch (statutValidation) {
    case "APPROVED": return "VALIDE";
    case "REJECTED": return "REFUSE";
    case "CHANGES_REQUESTED": return "A_CORRIGER";
    case "CANCELLED": return "ANNULE";
    default: return null;
  }
}

// ─────────────────────────── L'ouverture ───────────────────────────

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
function estDateIso(s: string): boolean {
  const m = ISO.exec(s.trim());
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

export function estMotifDepart(m: string | null | undefined): m is MotifDepart {
  return !!m && (MOTIFS_DEPART as readonly string[]).includes(m);
}

/** Ce qui empêche d'ouvrir (ou de corriger) une fin de contrat — `null` si tout y est. */
export function refusSaisieDepart(s: { motif: string | null; dateFin: string | null; preavisJours: number | null; note: string | null }): string | null {
  if (!estMotifDepart(s.motif)) return "Choisissez le motif de la fin de contrat (fin de CDD, démission, licenciement…).";
  if (!s.dateFin || !estDateIso(s.dateFin)) return "Indiquez la date de fin du contrat (le dernier jour travaillé).";
  if (s.preavisJours != null && (!Number.isInteger(s.preavisJours) || s.preavisJours < 0 || s.preavisJours > 365)) {
    return "Le préavis se compte en jours entiers, de 0 à 365.";
  }
  if (s.motif === "AUTRE" && !s.note?.trim()) return "Précisez le motif dans la note : « Autre motif » seul ne dit rien aux valideurs.";
  return null;
}

// ─────────────────────────── Le circuit : RH → N+1 → DG ───────────────────────────

export type MarcheDepart = "RH" | "N1" | "DG";
export const LIBELLE_MARCHE: Record<MarcheDepart, string> = { RH: "Ressources humaines", N1: "Supérieur hiérarchique", DG: "Direction générale" };

export interface EtapeDepart {
  marche: MarcheDepart;
  validatorId: string;
  /** « Supérieur hiérarchique et Direction générale » quand une même personne tient les deux marches. */
  libelle: string;
}

/**
 * LES MARCHES DU CIRCUIT, DANS L'ORDRE : la RH qui ouvre (sa marche est acquise à l'ouverture — les RH SONT l'étape RH,
 * comme pour une formation qu'elles organisent), puis le N+1 lu dans l'organigramme, puis le DG.
 *
 *   • pas de N+1 résolu (sommet, département sans responsable) : la marche est sautée, et la note le dit ;
 *   • le N+1 est la RH qui ouvre : sa marche se confond avec celle des RH — une personne ne valide pas deux fois ;
 *   • le N+1 est le DG : une seule décision, au nom des deux marches ;
 *   • le salarié qui part ne valide jamais son propre départ (l'appelant choisit un DG qui n'est pas lui).
 */
export function circuitDuDepart(p: { rhId: string; n1Id: string | null; dgId: string | null; salarieUserId: string | null }):
  { ok: true; etapes: EtapeDepart[]; notes: string[] } | { ok: false; refus: string } {
  if (p.salarieUserId && p.rhId === p.salarieUserId) return { ok: false, refus: "On n'ouvre pas sa propre fin de contrat : un autre membre des RH (ou la Direction) l'ouvre." };
  if (!p.dgId) return { ok: false, refus: "Aucun Directeur Général actif pour la dernière validation : nommez-le dans Administration › Comptes, puis rouvrez la fin de contrat." };
  const notes: string[] = [];
  const n1 = p.n1Id && p.n1Id !== p.salarieUserId ? p.n1Id : null;
  // LA DIRECTION GÉNÉRALE OUVRE ELLE-MÊME (aucun autre DG ni Super Admin) : sa marche vaut pour les RH et la DG — une
  // personne ne valide pas deux fois —, et le supérieur hiérarchique, s'il en est un autre, tranche en dernier.
  if (p.dgId === p.rhId) {
    const etapes: EtapeDepart[] = [{ marche: "RH", validatorId: p.rhId, libelle: `${LIBELLE_MARCHE.RH} et ${LIBELLE_MARCHE.DG}` }];
    if (n1 && n1 !== p.rhId) etapes.push({ marche: "N1", validatorId: n1, libelle: LIBELLE_MARCHE.N1 });
    notes.push("La Direction générale ouvre elle-même la fin de contrat : sa validation vaut pour les RH et la DG.");
    return { ok: true, etapes, notes };
  }
  const etapes: EtapeDepart[] = [{ marche: "RH", validatorId: p.rhId, libelle: LIBELLE_MARCHE.RH }];
  if (!n1) notes.push("Aucun supérieur hiérarchique n'est résolu dans l'organigramme : la validation passe des RH à la Direction générale.");
  else if (n1 === p.rhId) notes.push("Le supérieur hiérarchique est la personne qui ouvre la fin de contrat : sa validation RH vaut pour les deux marches.");
  else if (n1 !== p.dgId) etapes.push({ marche: "N1", validatorId: n1, libelle: LIBELLE_MARCHE.N1 });
  etapes.push({ marche: "DG", validatorId: p.dgId, libelle: n1 && n1 === p.dgId ? `${LIBELLE_MARCHE.N1} et ${LIBELLE_MARCHE.DG}` : LIBELLE_MARCHE.DG });
  return { ok: true, etapes, notes };
}

// ─────────────────────────── La fermeture du compte ───────────────────────────

/** Une heure : Alger est à UTC+1 toute l'année. */
const DECALAGE_ALGER_MS = 3_600_000;

/**
 * LE DÉPART EST-IL ÉCHU ? — le compte se ferme le LENDEMAIN du dernier jour travaillé, à minuit à Alger : le salarié garde
 * l'ERP toute sa dernière journée. `dateFin` est la date à minuit UTC (telle que la saisit un champ date).
 */
export function departEchu(dateFin: Date, maintenant: Date): boolean {
  return maintenant.getTime() >= dateFin.getTime() + 86_400_000 - DECALAGE_ALGER_MS;
}

// ─────────────────────────── La liste de sortie ───────────────────────────

export const CATEGORIES_TACHE = ["VEHICULE", "MATERIEL", "MATERIEL_PROMO", "INFORMATIQUE", "BADGE_CLES", "ACCES", "TRANSFERT", "DOCUMENTS", "COMPTE", "AUTRE"] as const;
export type CategorieTache = (typeof CATEGORIES_TACHE)[number];
export const LIBELLE_CATEGORIE_TACHE: Record<CategorieTache, string> = {
  VEHICULE: "Véhicule",
  MATERIEL: "Matériel",
  MATERIEL_PROMO: "Matériel promotionnel",
  INFORMATIQUE: "Informatique",
  BADGE_CLES: "Badge et clés",
  ACCES: "Accès",
  TRANSFERT: "Transferts",
  DOCUMENTS: "Documents",
  COMPTE: "Compte applicatif",
  AUTRE: "Autre",
};
export function estCategorieTache(c: string | null | undefined): c is CategorieTache {
  return !!c && (CATEGORIES_TACHE as readonly string[]).includes(c);
}

/** Les sources des lignes que la plateforme sait cocher seule (ou par un geste dédié). */
export const SOURCE_COMPTE = "AUTO:COMPTE";
export const SOURCE_CERTIFICAT = "AUTO:CERTIFICAT";
export const SOURCE_SOLDE = "AUTO:SOLDE";
export const SOURCE_TRANSFERT_TACHES = "AUTO:TRANSFERT_TACHES";
export const SOURCE_TRANSFERT_SUJETS = "AUTO:TRANSFERT_SUJETS";

/** Ce que les données réelles disent de ce que la personne détient et de ce qu'elle porte encore. */
export interface SourcesSortie {
  /** Véhicules et équipements des Moyens généraux dont elle est responsable. */
  moyens: { id: string; type: string; libelle: string; identifiant: string | null; reference: string }[];
  /** Le matériel promotionnel « en main » (solde des mouvements à son nom, > 0). */
  promo: { itemId: string; nom: string; quantite: number; unite: string | null }[];
  /** Un registre du parc informatique existe-t-il ? (non : une ligne libre). */
  parcInformatique?: { id: string; libelle: string; identifiant: string | null }[] | null;
  /** Ses tâches ouvertes, ses sujets ouverts, ses étapes de validation en attente. */
  tachesOuvertes: number;
  sujetsOuverts: number;
  validationsEnAttente: number;
  /** Ses accès propres : siège au centre de paiement, accès personnalisés, accès aux entités. */
  siegeCentrePaiement: boolean;
  accesPersonnalises: number;
  accesEntites: number;
  /** A-t-elle un compte applicatif ? */
  aUnCompte: boolean;
  /** Le nom du N+1 qui reçoit les transferts (null : les RH choisiront). */
  repreneur: string | null;
  dateFin: string;
}

export interface TacheProposee {
  categorie: CategorieTache;
  libelle: string;
  detail: string | null;
  quantite: number | null;
  source: string;
  ordre: number;
}

const pluriel = (n: number, un: string, plusieurs: string) => `${n} ${n > 1 ? plusieurs : un}`;

/**
 * LA LISTE DE SORTIE PRÉREMPLIE — une ligne par chose réelle à récupérer ou à faire. Ce que la plateforme ne connaît pas
 * (le parc informatique tant qu'il n'a pas de registre, le badge, les clés) entre en ligne libre : on ne l'oublie pas.
 */
export function tachesDeSortie(s: SourcesSortie): TacheProposee[] {
  const t: TacheProposee[] = [];
  let ordre = 0;
  const pousser = (x: Omit<TacheProposee, "ordre">) => t.push({ ...x, ordre: ordre++ });

  for (const m of s.moyens) {
    pousser({
      categorie: m.type === "VEHICULE" ? "VEHICULE" : "MATERIEL",
      libelle: `${m.type === "VEHICULE" ? "Restituer le véhicule" : "Restituer"} ${m.libelle}`,
      detail: [m.identifiant, m.reference].filter(Boolean).join(" · ") || null,
      quantite: null, source: `MoyenGeneral:${m.id}`,
    });
  }
  for (const p of s.promo) {
    pousser({
      categorie: "MATERIEL_PROMO", libelle: `Rendre au magasin : ${p.nom}`,
      detail: `En main : ${p.quantite.toLocaleString("fr-FR")}${p.unite ? ` ${p.unite}` : ""}`,
      quantite: p.quantite, source: `PromoStockItem:${p.itemId}`,
    });
  }
  if (s.parcInformatique && s.parcInformatique.length > 0) {
    for (const i of s.parcInformatique) {
      pousser({ categorie: "INFORMATIQUE", libelle: `Restituer ${i.libelle}`, detail: i.identifiant, quantite: null, source: `ParcInformatique:${i.id}` });
    }
  } else {
    pousser({ categorie: "INFORMATIQUE", libelle: "Restituer le matériel informatique (ordinateur, téléphone, clé 4G…)", detail: null, quantite: null, source: "LIBRE:INFORMATIQUE" });
  }
  pousser({ categorie: "BADGE_CLES", libelle: "Restituer le badge et les clés", detail: null, quantite: null, source: "LIBRE:BADGE_CLES" });

  const vers = s.repreneur ? ` à ${s.repreneur}` : "";
  if (s.tachesOuvertes > 0) {
    pousser({ categorie: "TRANSFERT", libelle: `Transférer ${pluriel(s.tachesOuvertes, "tâche en cours", "tâches en cours")}${vers}`, detail: null, quantite: null, source: SOURCE_TRANSFERT_TACHES });
  }
  if (s.sujetsOuverts > 0) {
    pousser({ categorie: "TRANSFERT", libelle: `Transférer ${pluriel(s.sujetsOuverts, "sujet ouvert", "sujets ouverts")}${vers}`, detail: null, quantite: null, source: SOURCE_TRANSFERT_SUJETS });
  }
  if (s.validationsEnAttente > 0) {
    pousser({
      categorie: "TRANSFERT", libelle: `${pluriel(s.validationsEnAttente, "validation l'attend", "validations l'attendent")} : la faire trancher avant le départ`,
      detail: "Centre de validations", quantite: null, source: "AUTO:VALIDATIONS",
    });
  }
  if (s.siegeCentrePaiement) pousser({ categorie: "ACCES", libelle: "Retirer son siège au centre de paiement", detail: "Finances › Centre de paiement", quantite: null, source: "AUTO:SIEGE_PAIEMENT" });
  if (s.accesPersonnalises > 0) {
    pousser({ categorie: "ACCES", libelle: `Retirer ${pluriel(s.accesPersonnalises, "accès personnalisé", "accès personnalisés")}`, detail: "Administration › Comptes", quantite: null, source: "AUTO:ACCES_PERSO" });
  }
  if (s.accesEntites > 0) {
    pousser({ categorie: "ACCES", libelle: `Retirer ${pluriel(s.accesEntites, "accès à une entité", "accès aux entités")}`, detail: "Fiche salarié › Accès aux entités", quantite: null, source: "AUTO:ACCES_ENTITES" });
  }
  pousser({ categorie: "ACCES", libelle: "Retirer les accès extérieurs (messagerie, clés de console, logiciels)", detail: null, quantite: null, source: "LIBRE:ACCES" });

  pousser({ categorie: "DOCUMENTS", libelle: "Remettre le certificat de travail", detail: null, quantite: null, source: SOURCE_CERTIFICAT });
  pousser({ categorie: "DOCUMENTS", libelle: "Faire signer le reçu pour solde de tout compte", detail: null, quantite: null, source: SOURCE_SOLDE });
  if (s.aUnCompte) {
    pousser({
      categorie: "COMPTE", libelle: "Fermer le compte applicatif (automatique, le lendemain de la date de fin)",
      detail: `Dernier jour : ${s.dateFin}`, quantite: null, source: SOURCE_COMPTE,
    });
  }
  return t;
}

// ─────────────────────────── Le solde de tout compte ───────────────────────────

export type SensSolde = "GAIN" | "RETENUE";
export interface LigneSolde {
  id: string;
  libelle: string;
  detail: string | null;
  /** DZD ; `null` = à saisir par les RH (la plateforme ne l'invente pas). */
  montant: number | null;
  sens: SensSolde;
}

export interface SourcesSolde {
  salaireBase: number | null;
  joursCongesRestants: number | null;
  avances: { id: string; montant: number; versee: string | null }[];
  notesDeFrais: { id: string; montant: number | null; mois: string | null; statut: string }[];
}

/**
 * LE SOLDE DE TOUT COMPTE PRÉREMPLI — ce que la plateforme SAIT, chaque montant éditable. Aucun calcul de paie : le
 * salaire du dernier mois part de la base de la fiche (aux RH de proratiser), l'indemnité de congés est À SAISIR (le
 * nombre de jours restants est donné), les avances versées sont proposées en retenue (si elles ne sont pas déjà
 * remboursées : la plateforme ne suit pas le remboursement), les notes de frais non réglées en gain.
 */
export function soldePrerempli(s: SourcesSolde): LigneSolde[] {
  const l: LigneSolde[] = [];
  l.push({
    id: "salaire", libelle: "Salaire du dernier mois",
    detail: s.salaireBase != null ? "Salaire de base de la fiche — à proratiser aux jours travaillés" : "Salaire de base absent de la fiche — à saisir",
    montant: s.salaireBase != null && s.salaireBase > 0 ? s.salaireBase : null, sens: "GAIN",
  });
  l.push({
    id: "conges", libelle: "Indemnité compensatrice de congés",
    detail: s.joursCongesRestants != null ? `${s.joursCongesRestants.toLocaleString("fr-FR")} jour(s) de congé restant(s) — montant à saisir` : "Montant à saisir",
    montant: null, sens: "GAIN",
  });
  for (const n of s.notesDeFrais) {
    l.push({ id: `frais-${n.id}`, libelle: `Note de frais${n.mois ? ` ${n.mois}` : ""} non réglée`, detail: n.statut, montant: n.montant, sens: "GAIN" });
  }
  for (const a of s.avances) {
    l.push({
      id: `avance-${a.id}`, libelle: "Avance sur salaire à retenir",
      detail: `Versée${a.versee ? ` le ${a.versee}` : ""} — à retirer si elle est déjà remboursée`, montant: a.montant, sens: "RETENUE",
    });
  }
  return l;
}

/** Les totaux du solde — les lignes sans montant sont comptées « à saisir », jamais comme zéro. */
export function totauxSolde(lignes: readonly LigneSolde[]): { gains: number; retenues: number; net: number; aSaisir: number } {
  let gains = 0, retenues = 0, aSaisir = 0;
  for (const x of lignes) {
    if (x.montant == null) { aSaisir++; continue; }
    if (x.sens === "RETENUE") retenues += x.montant; else gains += x.montant;
  }
  const arrondi = (n: number) => Math.round(n * 100) / 100;
  return { gains: arrondi(gains), retenues: arrondi(retenues), net: arrondi(gains - retenues), aSaisir };
}

/**
 * Relit un solde envoyé par l'écran (JSON) : lignes bornées, libellé exigé, montant positif ou vide, sens connu.
 * Rend les lignes propres ou le refus à dire.
 */
export function lireSoldeSaisi(brut: unknown): { ok: true; lignes: LigneSolde[] } | { ok: false; refus: string } {
  if (!Array.isArray(brut)) return { ok: false, refus: "Le solde de tout compte est illisible : rechargez la page." };
  if (brut.length > 60) return { ok: false, refus: "Soixante lignes au plus dans un solde de tout compte." };
  const lignes: LigneSolde[] = [];
  for (const [i, x] of brut.entries()) {
    const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const libelle = typeof o.libelle === "string" ? o.libelle.trim().slice(0, 200) : "";
    if (!libelle) return { ok: false, refus: `Ligne ${i + 1} : donnez-lui un libellé.` };
    const m = o.montant;
    const montant = m === null || m === undefined || m === "" ? null : Number(m);
    if (montant !== null && (!Number.isFinite(montant) || montant < 0)) return { ok: false, refus: `Ligne ${i + 1} : le montant est un nombre positif (ou vide, à saisir).` };
    const sens: SensSolde = o.sens === "RETENUE" ? "RETENUE" : "GAIN";
    const id = typeof o.id === "string" && o.id.trim() ? o.id.trim().slice(0, 60) : `l${i + 1}`;
    const detail = typeof o.detail === "string" && o.detail.trim() ? o.detail.trim().slice(0, 300) : null;
    lignes.push({ id, libelle, detail, montant: montant === null ? null : Math.round(montant * 100) / 100, sens });
  }
  return { ok: true, lignes };
}
