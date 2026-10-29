/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA TRÉSORERIE ANCRÉE (§118.176) — module PUR : il ne lit rien, il calcule.
 *
 * « SGA Birkhadem, compte Adventum : 2 966 153 DZD au 28 sept. 2026 » (Direction, 01/10). Un
 * compte se lit comme un relevé : un SOLDE à une DATE, en fin de journée — l'ANCRAGE. Son solde
 * d'aujourd'hui, c'est l'ancrage plus les écritures RÉGLÉES qui lui reviennent et qui sont datées
 * APRÈS ce jour-là. Celles du jour même sont déjà dans le relevé : les ajouter les compterait deux
 * fois.
 *
 * ── POURQUOI L'ANCIEN CALCUL ÉTAIT FAUX ─────────────────────────────────────────────────────
 *
 * « Solde d'ouverture + TOUS les flux réglés » : un solde d'ouverture saisi au 28/09 contient déjà
 * tout ce qui s'est passé avant le 28/09, et l'ancien calcul y rajoutait trois mois d'écritures
 * antérieures. Et l'ouverture se RÉÉCRIVAIT en silence (un « upsert » sur le nom) : on ne savait
 * plus d'où partait le solde affiché.
 *
 * ── À QUEL COMPTE REVIENT UNE ÉCRITURE ──────────────────────────────────────────────────────
 *
 * Dans l'ordre, et la première réponse gagne :
 *   1. le compte que l'écriture NOMME (`treasuryAccountId`, figé quand elle s'écrit) ;
 *   2. le compte dont le NOM est son libellé de compte (l'historique dit « Banque », « Caisse ») ;
 *   3. le compte PRINCIPAL de son entité ;
 *   4. le compte principal sans entité ;
 *   5. le compte, s'il n'y en a qu'UN.
 * Sinon elle n'est rattachée à rien — et elle est COMPTÉE, jamais tue (§118.52) : une écriture
 * qu'on ne sait pas placer est un écart de rapprochement qu'il faut voir, pas un détail à cacher.
 *
 * Les étapes 3 à 5 ne servent qu'à l'historique et aux écrivains qui ne choisissent pas : chaque
 * écriture NEUVE fige son compte en s'écrivant (`compteParDefaut`, la même règle) — sans cela,
 * changer de compte principal ferait changer de compte toutes les écritures passées.
 *
 * Une écriture qui nomme un compte HORS de la liste reçue (un compte d'une entité qu'on ne voit
 * pas) n'est ni comptée ni signalée : elle appartient à un compte qui n'est pas le nôtre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface CompteTresorerie {
  id: string;
  nom: string;
  societeId: string | null;
  principal: boolean;
  /** Le solde du relevé au jour d'ancrage, en fin de journée. */
  ancrage: number;
  /** AAAA-MM-JJ, à l'heure d'Alger. */
  jourAncrage: string;
}

export interface FluxTresorerie {
  id: string;
  sens: "IN" | "OUT";
  /** Toujours positif : le sens dit s'il entre ou sort. */
  montant: number;
  statut: string;
  /** AAAA-MM-JJ, à l'heure d'Alger. */
  jour: string;
  /** Le compte que l'écriture NOMME — nul sur l'historique d'avant l'ancrage des comptes. */
  compteId: string | null;
  /** Le libellé de compte historique (« Banque », « Caisse »…). */
  compte: string;
  societeId: string | null;
}

export interface SoldeCompte {
  id: string;
  nom: string;
  ancrage: number;
  jourAncrage: string;
  /** La somme SIGNÉE des écritures réglées postérieures à l'ancrage. */
  mouvements: number;
  nombreMouvements: number;
  solde: number;
}

export interface SoldesTresorerie {
  comptes: SoldeCompte[];
  /** La somme des soldes des comptes. */
  total: number;
  /** Les écritures réglées postérieures au plus ancien ancrage qu'aucun compte ne reçoit. */
  nonRattaches: { nombre: number; montant: number };
}

/** Le jour d'un instant, À L'HEURE D'ALGER — c'est là que la banque arrête ses journées. */
export function jourAlger(d: Date): string {
  // `en-CA` écrit AAAA-MM-JJ ; le fuseau est celui de la banque, pas celui du serveur.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Algiers", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

const normaliser = (s: string) => s.trim().toLocaleLowerCase("fr").replace(/\s+/g, " ");

/**
 * LE COMPTE PAR DÉFAUT d'une entité — ce que fige une écriture qui ne nomme pas le sien : le
 * principal de l'entité, sinon le principal sans entité, sinon le compte unique, sinon rien. Deux
 * principaux pour une même entité n'en désignent AUCUN : choisir l'un des deux déciderait à la
 * place d'une personne d'où part l'argent (§118.34) — et l'écran refuse de les créer.
 */
export function compteParDefaut(comptes: readonly CompteTresorerie[], societeId: string | null): string | null {
  const unique = (liste: readonly CompteTresorerie[]) => (liste.length === 1 ? liste[0]!.id : null);
  if (societeId) {
    const principaux = comptes.filter((c) => c.principal && c.societeId === societeId);
    if (principaux.length > 0) return unique(principaux);
  }
  const sansEntite = comptes.filter((c) => c.principal && c.societeId === null);
  if (sansEntite.length > 0) return unique(sansEntite);
  return unique(comptes);
}

/** Le compte d'une écriture — la règle en cinq marches de l'en-tête. `null` : rattachée à rien. */
export function compteDuFlux(
  flux: Pick<FluxTresorerie, "compteId" | "compte" | "societeId">,
  comptes: readonly CompteTresorerie[],
): string | null {
  if (flux.compteId) return comptes.some((c) => c.id === flux.compteId) ? flux.compteId : null;
  const parNom = comptes.filter((c) => normaliser(c.nom) === normaliser(flux.compte));
  if (parNom.length === 1) return parNom[0]!.id;
  return compteParDefaut(comptes, flux.societeId);
}

/**
 * LE COMPTE QU'UNE ÉCRITURE NEUVE FIGE — la même règle que la lecture, au moment où l'argent
 * bouge : le compte que la personne a CHOISI (« payé depuis… ») s'il existe, sinon les marches 2
 * à 5. Un identifiant choisi qui n'existe pas n'est pas « le premier compte venu » : on retombe sur
 * la règle, exactement comme si rien n'avait été choisi.
 */
export function resoudreCompte(
  comptes: readonly CompteTresorerie[],
  input: { compteId?: string | null; compte?: string | null; societeId: string | null },
): string | null {
  if (input.compteId && comptes.some((c) => c.id === input.compteId)) return input.compteId;
  return compteDuFlux({ compteId: null, compte: input.compte ?? "", societeId: input.societeId }, comptes);
}

/** Les soldes de chaque compte, leur total, et ce qu'aucun compte ne reçoit. */
export function soldesTresorerie(comptes: readonly CompteTresorerie[], flux: readonly FluxTresorerie[]): SoldesTresorerie {
  const parCompte = new Map<string, SoldeCompte>(comptes.map((c) => [c.id, {
    id: c.id, nom: c.nom, ancrage: c.ancrage, jourAncrage: c.jourAncrage, mouvements: 0, nombreMouvements: 0, solde: c.ancrage,
  }]));
  const plusAncien = comptes.reduce<string | null>((min, c) => (min === null || c.jourAncrage < min ? c.jourAncrage : min), null);
  const nonRattaches = { nombre: 0, montant: 0 };
  for (const f of flux) {
    if (f.statut !== "SETTLED") continue;
    const signe = f.sens === "IN" ? f.montant : -f.montant;
    // Un compte nommé hors de la liste : celui d'une entité qu'on ne voit pas — ni compté, ni signalé.
    if (f.compteId && !parCompte.has(f.compteId)) continue;
    const id = compteDuFlux(f, comptes);
    if (id === null) {
      if (plusAncien !== null && f.jour > plusAncien) {
        nonRattaches.nombre += 1;
        nonRattaches.montant += signe;
      }
      continue;
    }
    const s = parCompte.get(id)!;
    // Le jour d'ancrage est DANS le relevé : seules les écritures postérieures s'ajoutent.
    if (f.jour <= s.jourAncrage) continue;
    s.mouvements += signe;
    s.nombreMouvements += 1;
    s.solde = s.ancrage + s.mouvements;
  }
  const liste = comptes.map((c) => parCompte.get(c.id)!);
  return {
    comptes: liste,
    total: liste.reduce((t, c) => t + c.solde, 0),
    nonRattaches,
  };
}

/**
 * « SOLDE TRÉSORERIE = somme des comptes − paiements autorisés » (Direction, 01/10). Un paiement
 * AUTORISÉ par le centre et pas encore réglé est déjà engagé : l'argent est sur le compte, mais il
 * n'est plus disponible. Un paiement reporté reste dû — il reste compté.
 */
export function disponible(totalComptes: number, paiementsAutorises: number): number {
  return totalComptes - paiementsAutorises;
}
