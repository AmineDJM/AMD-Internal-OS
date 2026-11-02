/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PRODUITS 360 — les calculs PURS de la liste et de la fiche (Direction, 07/10).
 *
 * « Produit = dossier réglementaire » : UN catalogue. Le produit canonique (`Product`) porte
 * l'identité ; ses dossiers (`RegulatoryProduct`) portent l'enregistrement ET le stock (les
 * relevés sont indexés sur le dossier). Ce module ne lit rien : il reçoit des faits et rend
 * l'étape du cycle de vie, les mois de couverture, LE signal d'une ligne, l'échéance de la DE et
 * le prix qui fait foi (saisie manuelle > explorateur). Sans import de valeur : la liste, la fiche,
 * les composants client et les tests le partagent.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────── Le cycle de vie, en frise ───────────────────────────

export const ETAPES_CYCLE = ["ETUDE", "ENREGISTREMENT", "COMMERCIALISE", "FIN_DE_VIE"] as const;
export type EtapeCycle = (typeof ETAPES_CYCLE)[number];

/** Les statuts de dossier qui font d'un produit un produit de la société (`products/termines.ts`). */
const TERMINES = new Set(["DECISION_OBTAINED", "CLOSED"]);

/**
 * L'ÉTAPE DE LA FRISE. Arrêté (cycle de vie « DISCONTINUED ») ou inactif → fin de vie ; un dossier
 * terminé → commercialisé (la règle de la Direction du 06/10, celle de la liste) ; un dossier en
 * cours → enregistrement ; aucun dossier → étude.
 */
export function etapeCycle(p: { lifecycle: string; isActive: boolean; statutsDossiers: readonly string[] }): EtapeCycle {
  if (p.lifecycle === "DISCONTINUED" || !p.isActive) return "FIN_DE_VIE";
  if (p.statutsDossiers.some((s) => TERMINES.has(s))) return "COMMERCIALISE";
  if (p.statutsDossiers.length > 0) return "ENREGISTREMENT";
  return "ETUDE";
}

// ─────────────────────────── Le stock et sa couverture ───────────────────────────

/** En dessous, le stock est « bas » : deux mois de ventes. */
export const SEUIL_STOCK_BAS_MOIS = 2;

/**
 * LE STOCK D'AUJOURD'HUI — le DERNIER relevé de chaque lieu (dossier × portée × annexe), additionnés.
 * Un relevé est un « il reste X à cette date » : additionner deux relevés du même lieu compterait
 * deux fois les mêmes boîtes.
 */
export function stockActuel(releves: readonly { productId: string; scope: string; annexId: string | null; drCode?: string | null; date: Date | string; quantity: number }[]): { unites: number; date: Date | null; lieux: number } {
  const dernier = new Map<string, { t: number; q: number }>();
  for (const r of releves) {
    // Une direction régionale de la PCH est un lieu à part entière (scope ANNEX, annexId nul, `drCode`).
    const k = `${r.productId}|${r.scope}|${r.annexId ?? ""}|${r.drCode ?? ""}`;
    const t = new Date(r.date).getTime();
    const cur = dernier.get(k);
    if (!cur || t > cur.t) dernier.set(k, { t, q: r.quantity });
  }
  let unites = 0; let t = 0;
  for (const v of dernier.values()) { unites += v.q; t = Math.max(t, v.t); }
  return { unites, date: dernier.size ? new Date(t) : null, lieux: dernier.size };
}

/** MOIS DE COUVERTURE = stock ÷ écoulement mensuel moyen. Rien à diviser → `null` (on ne l'invente pas). */
export function moisDeCouverture(stockUnites: number | null, ecoulementMensuel: number | null): number | null {
  if (stockUnites === null || ecoulementMensuel === null || !(ecoulementMensuel > 0)) return null;
  return Math.round((stockUnites / ecoulementMensuel) * 10) / 10;
}

/**
 * L'ÉCOULEMENT MENSUEL MOYEN d'une consommation : le total divisé par le nombre de MOIS réellement
 * couverts — un import de trois mois ne se divise pas par douze.
 */
export function ecoulementMensuel(lignes: readonly { quantite: number; mois: string }[]): number | null {
  if (!lignes.length) return null;
  const mois = new Set(lignes.map((l) => l.mois));
  const total = lignes.reduce((s, l) => s + l.quantite, 0);
  return total > 0 ? total / Math.max(1, mois.size) : null;
}

// ─────────────────────────── Les ventes, mois par mois ───────────────────────────

/** « 2026-07 » — la clé d'un mois, en UTC. */
export function cleMois(d: Date | string): string {
  const x = new Date(d);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Les `n` mois qui finissent à `fin` (inclus), du plus ancien au plus récent. */
export function moisGlissants(fin: Date, n = 12): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(cleMois(new Date(Date.UTC(fin.getUTCFullYear(), fin.getUTCMonth() - i, 1))));
  return out;
}

/** Les ventes ramenées à 12 barres mensuelles, hôpital (marché / PCH) et officine séparés. */
export function serieMensuelle(
  ventes: readonly { date: Date | string; montant: number; hopital: boolean }[],
  fin: Date,
  n = 12,
): { mois: string; hopital: number; officine: number }[] {
  const cles = moisGlissants(fin, n);
  const par = new Map(cles.map((k) => [k, { mois: k, hopital: 0, officine: 0 }]));
  for (const v of ventes) {
    const b = par.get(cleMois(v.date));
    if (!b) continue;
    if (v.hopital) b.hopital += v.montant; else b.officine += v.montant;
  }
  return cles.map((k) => par.get(k)!);
}

/** « 48,2 M » — un montant DZD lisible d'un coup d'œil (le détail exact vit dans l'onglet). */
export function montantCourt(n: number): string {
  const a = Math.abs(n);
  const un = (x: number) => x.toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (a >= 1e9) return `${un(n / 1e9)} Md`;
  if (a >= 1e6) return `${un(n / 1e6)} M`;
  if (a >= 1e3) return `${Math.round(n / 1e3).toLocaleString("fr-FR")} k`;
  return Math.round(n).toLocaleString("fr-FR");
}

/** Variation relative en %, arrondie à l'unité — `null` sans base de comparaison. */
export function variationPct(courant: number, precedent: number): number | null {
  if (!(precedent > 0)) return null;
  return Math.round(((courant - precedent) / precedent) * 100);
}

// ─────────────────────────── La décision d'enregistrement ───────────────────────────

/** Validité d'une DE : 5 ans à compter de la signature ; le renouvellement se dépose 180 jours avant (ANPP). */
export const VALIDITE_DE_ANS = 5;
export const PREAVIS_RENOUVELLEMENT_JOURS = 180;

export function echeanceDecision(dateDecision: Date | string | null | undefined, maintenant: Date): { expiration: Date; depotAvant: Date; joursAvantDepot: number } | null {
  if (!dateDecision) return null;
  const d = new Date(dateDecision);
  if (Number.isNaN(d.getTime())) return null;
  const expiration = new Date(Date.UTC(d.getUTCFullYear() + VALIDITE_DE_ANS, d.getUTCMonth(), d.getUTCDate()));
  const depotAvant = new Date(expiration.getTime() - PREAVIS_RENOUVELLEMENT_JOURS * 86_400_000);
  return { expiration, depotAvant, joursAvantDepot: Math.floor((depotAvant.getTime() - maintenant.getTime()) / 86_400_000) };
}

/** L'échéance de dépôt du renouvellement devient un signal à six mois. */
export const HORIZON_ECHEANCE_DE_JOURS = 183;

// ─────────────────────────── LE signal d'une ligne ───────────────────────────

export type CodeSignal = "PV_OUVERT" | "STOCK_BAS" | "NON_SERVI" | "GENERIQUE" | "ECHEANCE_DE";
export interface Signal { code: CodeSignal; label: string; ton: "danger" | "warning" }

/**
 * UN SEUL SIGNAL PAR PRODUIT dans la liste — le plus grave d'abord : un cas de pharmacovigilance
 * ouvert, puis le stock bas, puis une demande non servie significative à la PCH (des hôpitaux
 * commandent, rien n'est livré), puis un générique fraîchement enregistré, puis l'échéance de la DE.
 * Chaque fait n'est fourni que si la personne a le module qui le montre (`undefined` = non vu).
 */
export function signalPrincipal(f: {
  pvOuverts?: number; couvertureMois?: number | null; nonServiSignificatif?: boolean; generiquesRecents?: number; joursAvantDepotDe?: number | null;
}): Signal | null {
  if ((f.pvOuverts ?? 0) > 0) return { code: "PV_OUVERT", label: f.pvOuverts === 1 ? "PV ouvert" : `${f.pvOuverts} PV ouverts`, ton: "danger" };
  if (f.couvertureMois !== null && f.couvertureMois !== undefined && f.couvertureMois < SEUIL_STOCK_BAS_MOIS) return { code: "STOCK_BAS", label: "stock bas", ton: "warning" };
  if (f.nonServiSignificatif) return { code: "NON_SERVI", label: "demande non servie", ton: "warning" };
  if ((f.generiquesRecents ?? 0) > 0) return { code: "GENERIQUE", label: "générique enregistré", ton: "danger" };
  if (f.joursAvantDepotDe !== null && f.joursAvantDepotDe !== undefined && f.joursAvantDepotDe <= HORIZON_ECHEANCE_DE_JOURS) return { code: "ECHEANCE_DE", label: "échéance DE", ton: "warning" };
  return null;
}

// ─────────────────────────── Les prix ───────────────────────────

export const TYPES_PRIX = ["PPA", "SHP", "TARIF_REFERENCE", "PRIX_HOPITAL"] as const;
export type TypePrix = (typeof TYPES_PRIX)[number];

export const LIBELLE_PRIX: Record<TypePrix, string> = {
  PPA: "Prix public (PPA, boîte)",
  SHP: "SHP (boîte)",
  TARIF_REFERENCE: "Tarif de référence (remboursement)",
  PRIX_HOPITAL: "Prix hôpital (PCH, unité)",
};

export function estTypePrix(v: string | null | undefined): v is TypePrix {
  return !!v && (TYPES_PRIX as readonly string[]).includes(v);
}

export interface SaisiePrix { montant: number | null; depuis: Date | string; creeLe: Date | string; auteur: string | null; note: string | null }
export interface PrixResolu {
  type: TypePrix;
  montant: number | null;
  source: "MANUEL" | "EXPLORATEUR" | null;
  /** Pour une saisie : qui, depuis quand. Pour l'explorateur : la source des données. */
  auteur: string | null;
  depuis: Date | null;
  note: string | null;
  /** La valeur de l'explorateur, gardée à côté quand la saisie la remplace. */
  explorateur: number | null;
}

/**
 * LE PRIX QUI FAIT FOI. La dernière saisie en vigueur (date d'effet passée, la plus récente, puis la
 * plus récemment écrite) l'emporte sur l'explorateur ; une saisie SANS montant est un « retour à
 * l'explorateur » — l'historique garde les deux.
 */
export function resoudrePrix(type: TypePrix, saisies: readonly SaisiePrix[], explorateur: { montant: number | null; source: string | null; date: Date | null }, maintenant: Date): PrixResolu {
  const enVigueur = saisies
    .filter((s) => new Date(s.depuis).getTime() <= maintenant.getTime())
    .sort((a, b) => new Date(b.depuis).getTime() - new Date(a.depuis).getTime() || new Date(b.creeLe).getTime() - new Date(a.creeLe).getTime())[0];
  if (enVigueur && enVigueur.montant !== null) {
    return { type, montant: enVigueur.montant, source: "MANUEL", auteur: enVigueur.auteur, depuis: new Date(enVigueur.depuis), note: enVigueur.note, explorateur: explorateur.montant };
  }
  if (explorateur.montant !== null) {
    return { type, montant: explorateur.montant, source: "EXPLORATEUR", auteur: explorateur.source, depuis: explorateur.date, note: null, explorateur: explorateur.montant };
  }
  return { type, montant: null, source: null, auteur: null, depuis: null, note: null, explorateur: null };
}

/** « 1 234,5 » → 1234.5 ; vide → null ; illisible ou négatif → NaN (refusé par l'action). */
export function lireMontant(brut: string | null | undefined): number | null {
  const s = (brut ?? "").replace(/[\s  ]/g, "").replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : Number.NaN;
}
