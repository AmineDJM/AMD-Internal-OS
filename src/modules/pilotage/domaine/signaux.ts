/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES SIGNAUX DATÉS — la part PURE (aucun import) : le vocabulaire, la clé d'unicité, et la traduction de ce que les
 * mécanismes existants calculent déjà (Voix du terrain, l'essentiel Produits 360, les signaux des finances) en lignes.
 *
 * Une ligne = (jour, source, nature, cible) + des dimensions + une valeur + une charge. La clé (source, nature, cle, jour)
 * est UNIQUE en base : rejouer un calcul le même jour réécrit la même ligne. Le lendemain en écrit une autre — c'est
 * l'historique que la purge quotidienne effaçait.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * Les SOURCES : le mécanisme qui écrit. Pour une IA, c'est le code de sa fonction (`AiFeature` de `ai-settings.ts`), pour
 * que le journal d'usage (coût) et le journal des propositions (fiabilité) se lisent côte à côte.
 */
export const SOURCES = {
  voix_terrain: "Voix du terrain",
  produit_360: "L'essentiel Produits 360",
  finances: "Instantané des finances",
  kpi: "KPI avec Luna",
  budget_campagne: "Campagne budgétaire avec Luna",
  nature_depense: "Nature des dépenses",
  postes_luna: "Postes Ad & Pro proposés",
  attestation_travail: "Attestation de travail (contrat lu)",
  conseil_pieces: "Conseil de rangement d'une pièce",
  controle_cles: "Contrôle des clés",
} as const;
export type SourceSignal = keyof typeof SOURCES;
export const estSource = (v: unknown): v is SourceSignal => typeof v === "string" && v in SOURCES;

/** Qui a produit la valeur : une règle déterministe, un modèle, ou le repli déterministe d'un modèle absent. */
export type Producteur = "regle" | "ia" | "repli";

/** Le statut d'une ligne : une mesure est CONSTATÉE ; une proposition d'IA est PROPOSÉE puis tranchée par un humain. */
export const STATUTS_SIGNAL = ["CONSTATE", "PROPOSE", "ACCEPTE", "MODIFIE", "REJETE"] as const;
export type StatutSignal = (typeof STATUTS_SIGNAL)[number];

export interface LigneSignal {
  jour: string;
  source: SourceSignal;
  nature: string;
  cle: string;
  producteur?: Producteur;
  companyId?: string | null;
  buId?: string | null;
  wilayaCode?: string | null;
  productId?: string | null;
  doctorId?: string | null;
  budgetEnvelopeId?: string | null;
  entiteType?: string | null;
  entiteId?: string | null;
  valeur?: number | null;
  unite?: string | null;
  gravite?: string | null;
  charge?: Record<string, unknown>;
}

/** LE JOUR D'ALGER (AAAA-MM-JJ) — le fuseau de la société, pas celui du serveur. Alger n'a pas d'heure d'été : UTC+1. */
export function jourAlger(d: Date): string {
  return new Date(d.getTime() + 3_600_000).toISOString().slice(0, 10);
}

const CLE_MAX = 300;

/** LA CLÉ D'UNE CIBLE — « type:id » (« bu:abc », « produit:xyz|9f3a ») ; sans cible : « groupe ». Bornée. */
export function cleDeCible(type: string | null | undefined, id?: string | null, precision?: string | null): string {
  if (!type) return "groupe";
  const base = id ? `${type}:${id}` : type;
  return (precision ? `${base}|${precision}` : base).slice(0, CLE_MAX);
}

/** L'IDENTITÉ d'une ligne en base — ce qui la rend idempotente. */
export const identiteSignal = (l: Pick<LigneSignal, "source" | "nature" | "cle" | "jour">): string => `${l.source}|${l.nature}|${l.cle}|${l.jour}`;

/**
 * DÉDOUBLONNER un lot avant l'écriture : deux lignes de même identité dans le même lot, la DERNIÈRE l'emporte (c'est ce
 * que ferait la base, ligne après ligne). Les lignes sans jour, source, nature ou clé sont écartées — une mesure absente
 * n'écrit rien (règle des briques KPI), et une valeur non finie devient `null`.
 */
export function lotDeSignaux(lignes: readonly LigneSignal[]): LigneSignal[] {
  const parCle = new Map<string, LigneSignal>();
  for (const l of lignes) {
    if (!l.jour || !/^\d{4}-\d{2}-\d{2}$/.test(l.jour) || !estSource(l.source) || !l.nature || !l.cle) continue;
    const valeur = typeof l.valeur === "number" && Number.isFinite(l.valeur) ? l.valeur : null;
    parCle.set(identiteSignal(l), { ...l, valeur });
  }
  return [...parCle.values()];
}

// ─────────────────────────── La Voix du terrain ───────────────────────────

/** Ce que `voix-terrain/pur.ts` rend — redit ici sans import (un domaine ne lit pas `src/lib`). */
export interface VoixLue {
  jours: number;
  rapports: number;
  groupes: { categorie: string; rapports: number; delegues: number; citation: { texte: string; rapportId: string; coupe: boolean } | null }[];
  objectionsPrixAo: number;
  parLuna: boolean;
}

/**
 * LE PÉRIMÈTRE d'une Voix du terrain → ses dimensions. « mkt:bu:<id> » (Marketing cockpit) et « ops:<id> » (Cockpit
 * Opérations, une BU) portent une BU ; « ops:all » n'en porte pas.
 */
export function buDuPerimetre(perimetre: string): string | null {
  const m = /^(?:mkt:bu|ops):(.+)$/.exec(perimetre);
  return m && m[1] !== "all" ? m[1] : null;
}

/** UNE VOIX DU TERRAIN → ses lignes : une par famille trouvée, plus le total des rapports lus (le dénominateur). */
export function signauxDeLaVoix(v: VoixLue, ctx: { perimetre: string; jour: string; companyId?: string | null }): LigneSignal[] {
  const cle = cleDeCible("perimetre", ctx.perimetre, `${v.jours}j`);
  const commun = { jour: ctx.jour, source: "voix_terrain" as const, cle, producteur: (v.parLuna ? "ia" : "repli") as Producteur, buId: buDuPerimetre(ctx.perimetre), companyId: ctx.companyId ?? null };
  return [
    { ...commun, nature: "RAPPORTS", valeur: v.rapports, unite: "rapports", charge: { jours: v.jours, objectionsPrixAo: v.objectionsPrixAo } },
    ...v.groupes.map((g) => ({
      ...commun, nature: g.categorie, valeur: g.rapports, unite: "rapports",
      charge: { delegues: g.delegues, citation: g.citation, jours: v.jours, part: v.rapports > 0 ? g.rapports / v.rapports : null },
    })),
  ];
}

// ─────────────────────────── L'essentiel Produits 360 ───────────────────────────

/** L'ESSENTIEL d'un produit → une ligne (ses points cités dans la charge). L'empreinte des faits distingue deux lecteurs. */
export function signalDeLEssentiel(
  e: { points: readonly unknown[]; parLuna: boolean },
  ctx: { productId: string; empreinte: string; jour: string; companyId?: string | null },
): LigneSignal | null {
  if (e.points.length === 0) return null;
  return {
    jour: ctx.jour, source: "produit_360", nature: "ESSENTIEL", cle: cleDeCible("produit", ctx.productId, ctx.empreinte),
    producteur: e.parLuna ? "ia" : "repli", productId: ctx.productId, companyId: ctx.companyId ?? null,
    valeur: e.points.length, unite: "points", charge: { points: e.points },
  };
}

// ─────────────────────────── L'instantané quotidien des finances ───────────────────────────

/** Un signal des finances tel que `finances/domaine/intelligence.ts` le rend (forme structurelle, sans import). */
export interface SignalFinanceLu {
  code: string;
  gravite: string;
  titre: string;
  detail?: string;
  calcul?: string;
  montant?: number | null;
  echeance?: string | null;
  entite?: { type: string; id: string; ref?: string | null } | null;
  href?: string | null;
}

/** UN SIGNAL DES FINANCES → une ligne, rattachée à sa société (lue par l'entité qu'il nomme). */
export function ligneDeSignalFinance(s: SignalFinanceLu, ctx: { jour: string; companyId: string | null }): LigneSignal {
  const enveloppe = s.entite?.type === "BudgetEnvelope" ? s.entite.id : null;
  return {
    jour: ctx.jour, source: "finances", nature: s.code, cle: cleDeCible(s.entite?.type ?? "groupe", s.entite?.id ?? null),
    producteur: "regle", companyId: ctx.companyId, budgetEnvelopeId: enveloppe,
    entiteType: s.entite?.type ?? null, entiteId: s.entite?.id ?? null,
    valeur: typeof s.montant === "number" ? s.montant : null, unite: "DZD", gravite: s.gravite,
    charge: { titre: s.titre, detail: s.detail ?? null, calcul: s.calcul ?? null, echeance: s.echeance ?? null, ref: s.entite?.ref ?? null, href: s.href ?? null },
  };
}

/** La santé d'une enveloppe telle que `santeBudget` la rend. */
export interface SanteLue {
  sante: string;
  tauxTemps: number;
  tauxConsomme: number;
  tauxEngage: number;
  projectionFin: number | null;
  ecartProjete: number | null;
  calcul: string;
}

/** LA SANTÉ D'UNE ENVELOPPE, chaque jour, même saine : la projection de fin d'exercice n'a de sens qu'en série. */
export function ligneSanteBudget(
  e: { id: string; nom: string; alloue: number; consomme: number; engage?: number },
  s: SanteLue,
  ctx: { jour: string; companyId: string | null; buId?: string | null; productId?: string | null },
): LigneSignal {
  return {
    jour: ctx.jour, source: "finances", nature: "sante_budget", cle: cleDeCible("BudgetEnvelope", e.id),
    producteur: "regle", companyId: ctx.companyId, buId: ctx.buId ?? null, productId: ctx.productId ?? null, budgetEnvelopeId: e.id,
    entiteType: "BudgetEnvelope", entiteId: e.id, valeur: s.projectionFin, unite: "DZD", gravite: s.sante,
    charge: {
      nom: e.nom, alloue: e.alloue, consomme: e.consomme, engage: e.engage ?? 0, sante: s.sante, tauxTemps: s.tauxTemps,
      tauxConsomme: s.tauxConsomme, tauxEngage: s.tauxEngage, ecartProjete: s.ecartProjete, calcul: s.calcul,
    },
  };
}

/** LE DISPONIBLE d'une société (somme des comptes − paiements autorisés non réglés). */
export function ligneDisponible(
  t: { disponible: number; total: number; autorises: { nombre: number; montant: number }; comptes: number },
  ctx: { jour: string; companyId: string },
): LigneSignal {
  return {
    jour: ctx.jour, source: "finances", nature: "disponible", cle: cleDeCible("Company", ctx.companyId),
    producteur: "regle", companyId: ctx.companyId, entiteType: "Company", entiteId: ctx.companyId,
    valeur: t.disponible, unite: "DZD",
    charge: { soldeComptes: t.total, autorises: t.autorises, comptes: t.comptes },
  };
}

/** LE RÉSUMÉ D'UNE SOCIÉTÉ pour le jour : combien de signaux par code et par gravité — la courbe qui se lit d'un coup d'œil. */
export function resumeFinances(lignes: readonly LigneSignal[], ctx: { jour: string; companyId: string | null }): LigneSignal {
  const parCode: Record<string, number> = {};
  const parGravite: Record<string, number> = {};
  let n = 0;
  for (const l of lignes) {
    if (l.source !== "finances" || l.nature === "sante_budget" || l.nature === "disponible" || l.nature === "resume") continue;
    if ((l.companyId ?? null) !== ctx.companyId) continue;
    parCode[l.nature] = (parCode[l.nature] ?? 0) + 1;
    if (l.gravite) parGravite[l.gravite] = (parGravite[l.gravite] ?? 0) + 1;
    n += 1;
  }
  return {
    jour: ctx.jour, source: "finances", nature: "resume", cle: cleDeCible(ctx.companyId ? "Company" : "sans-societe", ctx.companyId),
    producteur: "regle", companyId: ctx.companyId, valeur: n, unite: "signaux", charge: { parCode, parGravite },
  };
}
