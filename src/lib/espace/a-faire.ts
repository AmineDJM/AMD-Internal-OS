import { construireLot, montantDzd, NATURES, parUrgence, type Geste, type LigneLot, type Lot, type NatureLot } from "./aujourdhui";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « À FAIRE » EN TROIS GROUPES (maquette validée par le Super Admin, 24/11/2026) — module PUR, lu par
 * le composant client de la file (`mon-espace/file-a-faire.tsx`).
 *
 * « On change uniquement l'interface » : les lots viennent tels quels de `regrouperFile` (le centre
 * d'actions, filtré par les droits). Ce module ne fait que les RANGER, sur ce que chaque ligne porte déjà :
 *
 *   · En retard   — l'échéance est dépassée d'au moins un jour civil (`retard`) ;
 *   · Aujourd'hui — échéance sous deux jours ou priorité haute (`urgence === "urgent"`), ou bien un
 *                   circuit arrêté chez la personne sans échéance plus lointaine : une décision qu'on
 *                   attend d'elle (`NATURES[…].decision`), une demande renvoyée pour correction ;
 *   · Plus tard   — le reste, replié tant que les deux premiers groupes ont quelque chose.
 *
 * Un lot dont les lignes tombent dans deux groupes se coupe en deux (même recomposition que le titre :
 * `construireLot`) : « 5 paiements à régler » en retard, « 7 paiements à régler » plus tard. Le nombre
 * d'un groupe compte des LIGNES (des objets), jamais des lots : « À faire · 26 » = 6 + 8 + 12.
 *
 * Un congé et une demande à corriger restent une ligne chacun (« Valider le congé de Samir », « À corriger
 * — … ») : chacun se traite à part, et la liste d'écran d'une nature n'en montre pas toujours tous.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type CleGroupe = "retard" | "aujourdhui" | "plus-tard";

const GROUPES: { cle: CleGroupe; libelle: string }[] = [
  { cle: "retard", libelle: "En retard" },
  { cle: "aujourdhui", libelle: "Aujourd'hui" },
  { cle: "plus-tard", libelle: "Plus tard" },
];

/** Ce qu'une ligne de la file ouvre sur place : le panneau d'un congé, ou celui de tous les congés à signer. */
export type Panneau = { type: "conge"; id: string } | { type: "conges" } | null;

/** Une sous-ligne d'un lot de plusieurs objets — dépliée à la demande. */
export interface SousLigne {
  key: string;
  titre: string;
  sousTitre: string | null;
  geste: Geste;
}

/** UNE LIGNE DE « À FAIRE » — un titre, un sous-titre d'une ligne, UN bouton. */
export interface LigneAFaire {
  key: string;
  titre: string;
  sousTitre: string | null;
  geste: Geste;
  panneau: Panneau;
  /** Le nombre d'objets que la ligne porte (0 pour une ligne de suivi ou « et d'autres… »). */
  n: number;
  /** Le seul bouton plein de la page : la première ligne en retard, à défaut la première de la liste. */
  enAvant: boolean;
  sousLignes: SousLigne[];
  /** « D'autres … attendent » — la file du centre est coupée au-delà (§118.60). */
  suite: Geste | null;
}

export interface GroupeAFaire {
  cle: CleGroupe;
  libelle: string;
  /** Objets du groupe (lignes de suivi exclues). */
  n: number;
  lignes: LigneAFaire[];
  /** Replié derrière « Afficher les N autres » (seulement « Plus tard », et quand il y a autre chose à voir). */
  replie: boolean;
}

export interface AFaire {
  /** « À faire · N » — dit une seule fois. */
  total: number;
  groupes: GroupeAFaire[];
}

/** Les natures qui font une ligne par objet. */
const UNE_LIGNE_PAR_OBJET = new Set<NatureLot>(["conge", "correction"]);
/** Un circuit arrêté chez la personne, en plus des décisions : sa demande renvoyée pour correction. */
const CIRCUIT_ARRETE = new Set<NatureLot>(["correction"]);
const PREFIXE_CONGE = "LEAVE_REQUEST:";

/** LE GROUPE D'UNE LIGNE — lu sur son retard, son urgence et sa nature, jamais estimé. */
function groupeDe(l: LigneLot, nature: NatureLot): CleGroupe {
  if (l.retard !== null) return "retard";
  if (l.urgence === "urgent") return "aujourdhui";
  if (l.echeanceDans === null && (NATURES[nature].decision || CIRCUIT_ARRETE.has(nature))) return "aujourdhui";
  return "plus-tard";
}

const pl = (n: number, s: string, p?: string) => (n > 1 ? p ?? `${s}s` : s);

/** « 28 j de retard », « échéance demain », « attend depuis 43 j » — le délai d'UNE ligne. */
function delaiLigne(l: LigneLot): string | null {
  if (l.retard !== null) return `${l.retard} j de retard`;
  if (l.echeanceDans === 0) return "échéance aujourd'hui";
  if (l.echeanceDans === 1) return "échéance demain";
  if (l.attente) return `attend depuis ${l.attente} j`;
  return null;
}

/** Le délai d'un lot de plusieurs lignes : le pire retard, sinon la plus longue attente. */
function delaiLot(lot: Lot): string | null {
  if (lot.retardMax > 0) return `jusqu'à ${lot.retardMax} j de retard`;
  if (lot.attenteMax) return `le plus ancien attend depuis ${lot.attenteMax} j`;
  return null;
}

const joindre = (parts: (string | null | undefined)[]) => {
  const vus = [...new Set(parts.filter((x): x is string => Boolean(x && x.trim())))];
  return vus.length ? vus.join(" · ") : null;
};

/** « Congé — Samir Haddad » → « Samir Haddad ». */
const nomDuConge = (libelle: string) => libelle.replace(/^Congé\s+—\s+/, "");

function sousLigneDe(l: LigneLot): SousLigne {
  return {
    key: l.key,
    titre: joindre([l.ref, l.libelle]) ?? l.libelle,
    sousTitre: joindre([l.detail, l.montant ? montantDzd(l.montant) : null, delaiLigne(l)]),
    geste: l.geste,
  };
}

/** Une ligne de la file à partir d'un lot (déjà recomposé sur les lignes de son groupe). */
function ligneDuLot(lot: Lot, suite: Geste | null): LigneAFaire {
  const base = { key: lot.id, n: lot.n, enAvant: false, suite, panneau: null as Panneau, sousLignes: [] as SousLigne[] };
  if (lot.n === 0) {
    // Une ligne « et d'autres… » seule : son libellé, son lien.
    const conges = lot.nature === "conge";
    return {
      ...base, titre: lot.titre, sousTitre: lot.sousTitre || null, suite: null,
      geste: { libelle: conges ? "Ouvrir" : "Voir", href: lot.geste.href }, panneau: conges ? { type: "conges" } : null,
    };
  }
  if (lot.nature === "conge") {
    const l = lot.lignes[0];
    const nom = nomDuConge(l.libelle);
    // Le détail du centre dit « 3 j · Chez le N+1 · Samir Haddad » : le nom est déjà dans le titre.
    const detail = (l.detail ?? "").split(" · ").filter((x) => x && x !== nom).join(" · ");
    return {
      ...base,
      titre: `Valider le congé de ${nom}`,
      sousTitre: joindre([detail, delaiLigne(l)]),
      geste: { libelle: "Ouvrir", href: l.geste.href },
      panneau: { type: "conge", id: l.objet.slice(PREFIXE_CONGE.length) },
    };
  }
  if (lot.n === 1) {
    const l = lot.lignes[0];
    // Un paiement seul garde son titre « 1 paiement à régler — … » : le sous-titre du lot dit la référence et le bénéficiaire.
    const quoi = lot.nature === "paiement" ? lot.sousTitre : joindre([l.ref, l.detail ?? NATURES[lot.nature].sousTitre]);
    return { ...base, titre: lot.titre, sousTitre: joindre([quoi, delaiLigne(l)]), geste: { libelle: NATURES[lot.nature].verbe, href: lot.geste.href } };
  }
  return {
    ...base,
    titre: lot.titre,
    sousTitre: joindre([lot.sousTitre || lot.module, delaiLot(lot)]),
    // Le verbe seul (« Régler », « Valider ») : le lien, lui, reste celui du lot (l'écran filtré, les ordres en retard mis en évidence).
    geste: { libelle: NATURES[lot.nature].verbe, href: lot.geste.href },
    sousLignes: lot.lignes.map(sousLigneDe),
  };
}

/** « Afficher les 12 autres » — le bouton qui déplie « Plus tard ». */
export function libelleDeplier(n: number): string {
  if (n === 1) return "Afficher l'autre";
  if (n > 1) return `Afficher les ${n} autres`;
  return "Afficher la suite";
}

/**
 * LA FILE EN TROIS GROUPES. `piecesEnAttente` : les pièces que la personne attend des AUTRES — une ligne de
 * suivi dans « Plus tard » (rien à faire de son côté, sinon relancer), jamais comptée dans « À faire ».
 */
export function grouperAFaire(lots: readonly Lot[], opts: { piecesEnAttente?: number } = {}): AFaire {
  const parGroupe: Record<CleGroupe, { lot: Lot; suite: Geste | null }[]> = { retard: [], aujourdhui: [], "plus-tard": [] };
  const suites: Record<CleGroupe, LigneAFaire[]> = { retard: [], aujourdhui: [], "plus-tard": [] };

  for (const lot of lots) {
    if (lot.n === 0) {
      // Une file coupée sans ligne visible : une décision se range aujourd'hui, le reste plus tard.
      const cle: CleGroupe = NATURES[lot.nature].decision ? "aujourdhui" : "plus-tard";
      suites[cle].push(ligneDuLot(lot, null));
      continue;
    }
    const morceaux = new Map<CleGroupe, LigneLot[]>();
    for (const l of lot.lignes) {
      const cle = groupeDe(l, lot.nature);
      morceaux.set(cle, [...(morceaux.get(cle) ?? []), l]);
    }
    // La suite (« et d'autres… ») accompagne le morceau le plus pressant du lot.
    let suite = lot.suite;
    for (const { cle } of GROUPES) {
      const lignes = morceaux.get(cle);
      if (!lignes) continue;
      const paquets = UNE_LIGNE_PAR_OBJET.has(lot.nature) ? lignes.map((l) => [l]) : [lignes];
      for (const paquet of paquets) {
        const id = paquets.length > 1 || morceaux.size > 1 ? `${lot.id}:${cle}:${paquet.length === 1 ? paquet[0].key : "lot"}` : lot.id;
        const refait = construireLot({ id, nature: lot.nature, module: lot.module, lignes: paquet, suite: null }, { taireRetard: cle === "retard" });
        if (!refait) continue;
        if (lot.nature === "conge" && suite) {
          // Les congés au-delà du plafond du centre : une ligne à part, qui ouvre le panneau de tous les congés.
          suites.aujourdhui.push(ligneDuLot({ ...lot, id: `${lot.id}:reste`, n: 0, titre: suite.libelle, geste: suite }, null));
          suite = null;
        }
        parGroupe[cle].push({ lot: refait, suite });
        suite = null;
      }
    }
  }

  const groupes: GroupeAFaire[] = GROUPES.map(({ cle, libelle }) => {
    const lignes = parGroupe[cle].sort((a, b) => parUrgence(a.lot, b.lot)).map(({ lot, suite }) => ligneDuLot(lot, suite));
    lignes.push(...suites[cle]);
    return { cle, libelle, n: lignes.reduce((s, l) => s + l.n, 0), lignes, replie: false };
  });

  const plusTard = groupes[2];
  const pieces = opts.piecesEnAttente ?? 0;
  if (pieces > 0) {
    plusTard.lignes.push({
      key: "pieces-en-attente", n: 0, enAvant: false, sousLignes: [], suite: null, panneau: null,
      titre: `Vous attendez ${pieces} ${pl(pieces, "pièce")} d'autres personnes`,
      sousTitre: "Pièces demandées — à relancer depuis leur fiche si besoin",
      geste: { libelle: "Voir", href: "/pieces" },
    });
  }
  plusTard.replie = plusTard.lignes.length > 0 && (groupes[0].lignes.length > 0 || groupes[1].lignes.length > 0);

  // UN SEUL BOUTON PLEIN : la première ligne affichée (« En retard » vient en tête).
  const premiere = groupes.find((g) => g.lignes.length > 0)?.lignes[0];
  if (premiere) premiere.enAvant = true;

  return { total: groupes.reduce((s, g) => s + g.n, 0), groupes };
}
