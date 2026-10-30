import { Prisma, type Confidentiality, type SourcePiece } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";
import type { SessionUser } from "@/lib/rbac";
import { censurerTexte } from "@/modules/assistant-ia/partage";
import { fusionner, type Touche, type Voie } from "../domaine/classement";
import { extraire, type Segment } from "../domaine/extrait";
import { FAMILLES, lienDe, lireCle } from "../domaine/familles";
import { plier, type Format } from "../domaine/format";
import { exclusionPourModele, RAISONS_EXCLUSION_MODELE, type RaisonExclusionModele } from "../domaine/politique";
import { normaliserRequete, type Filtres } from "../domaine/requete";
import { capacites as capacitesDeLaBase, embedderParDefaut, litteralVecteur, type Capacites, type Embedder } from "./capacites";
import { clesOuvrables } from "./acces";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CHERCHER UNE PIÈCE PAR SON CONTENU — une requête, trois voies, filtrée par les droits (J1).
 *
 *   1. PLEIN TEXTE : `tsvector` français replié (accents, racines) sur les passages, index GIN — en OU
 *      (une pièce qui porte tous les mots passe devant par son rang, une qui n'en porte qu'un reste trouvée) ;
 *   2. TITRE : trigrammes sur le titre replié (« reglemnt interieur » trouve « Règlement intérieur ») ;
 *   3. SENS : vecteur de la requête (text-embedding-3-small) contre les passages, index HNSW — seulement si la
 *      base porte pgvector ET si le fournisseur répond ; sinon les deux premières voies, sans bruit.
 *
 * Les classements se FUSIONNENT par leurs rangs (RRF, `domaine/classement.ts`), puis chaque pièce est
 * JUGÉE : la personne doit pouvoir ouvrir au moins un des endroits où elle est rangée, par la règle de
 * l'écran qui la sert (`acces.ts`). On juge dans l'ordre du classement, jusqu'à la limite ; si les voies
 * étaient pleines et que les droits en ont écarté trop, on va chercher la page suivante.
 *
 * `pourModele` : le résultat partira à un modèle d'IA. S'ajoutent alors la politique (`domaine/politique.ts`
 * — ni confidentiel, ni sensible, écartés DANS la requête) et le filtre de confidentialité sur les extraits
 * (IBAN, NIN, salaires masqués). Un écran humain, lui, voit tout ce que la personne peut ouvrir.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface ResultatDocument {
  pieceId: string;
  titre: string;
  format: Format;
  source: SourcePiece;
  date: Date;
  nature: string | null;
  confidentiality: Confidentiality;
  sensible: boolean;
  /** L'endroit par lequel la personne l'ouvre (le premier qu'elle peut ouvrir). */
  endroit: { cle: string; libelle: string; lien: string };
  extrait: Segment[];
  score: number;
  voies: Voie[];
}

export interface RechercheDocuments {
  resultats: ResultatDocument[];
  /** Ce que la base a pu faire pour cette requête (le repli se DIT). */
  mode: { vecteur: boolean; trigrammes: boolean; vecteurUtilise: boolean };
  /** Candidats écartés parce que la personne ne peut pas les ouvrir (un compte, jamais lesquels). */
  ecartesParLesDroits: number;
}

export interface OptionsRecherche {
  limite?: number;
  pourModele?: boolean;
  /** Injectables (bancs, tests) : jamais de réseau dans `npm test`. */
  embed?: Embedder;
  capacites?: Capacites;
}

/**
 * Le temps qu'on accorde au fournisseur pour vectoriser la REQUÊTE. Au-delà, la recherche part sans le sens (le
 * mode le dit). MESURÉ le 29/10 au banc vivant (depuis le conteneur, par le mandataire) : ~280 ms par appel, 800 ms
 * pour le premier (TLS) ; le moteur lui-même répond en ~20 ms. L'appel part EN MÊME TEMPS que les voies lexicales,
 * et son vecteur est gardé (même texte, même vecteur) : une requête répétée ne le repaie pas.
 */
const DELAI_VECTEUR_MS = Math.max(50, Number(process.env.BIBLIOTHEQUE_DELAI_VECTEUR_MS ?? 400) || 400);
const VECTEURS_GARDES = 500;
const vecteursDesRequetes = new WeakMap<Embedder, Map<string, number[]>>();

function vecteurDeLaRequete(embed: Embedder, texte: string): Promise<number[] | null> {
  let garde = vecteursDesRequetes.get(embed);
  if (!garde) { garde = new Map(); vecteursDesRequetes.set(embed, garde); }
  const cle = plier(texte);
  const connu = garde.get(cle);
  if (connu) return Promise.resolve(connu);
  const appel = embed([texte]).then((v) => {
    const vecteur = v?.[0] ?? null;
    if (vecteur) {
      if (garde.size >= VECTEURS_GARDES) garde.delete(garde.keys().next().value!);
      garde.set(cle, vecteur);
    }
    return vecteur;
  }).catch(sansBloquer("bibliotheque.vecteur-requete", null));
  return Promise.race([appel, new Promise<null>((r) => setTimeout(() => r(null), DELAI_VECTEUR_MS))]);
}

/** Candidats rendus par chaque voie et par page. */
const PAGE = 120;
const PAGES_MAX = 4;
/** En deçà de cette similarité cosinus, un voisin n'est plus un sens partagé : du bruit. */
const SIMILARITE_MIN = 0.3;

function clauseFiltres(f: Filtres, pourModele: boolean): Prisma.Sql {
  const c: Prisma.Sql[] = [Prisma.sql`cardinality(f."cles") > 0`];
  if (f.formats?.length) c.push(Prisma.sql`f."format" IN (${Prisma.join(f.formats)})`);
  if (f.sources?.length) c.push(Prisma.sql`f."source"::text IN (${Prisma.join(f.sources)})`);
  if (f.du) c.push(Prisma.sql`f."dateDocument" >= ${f.du}`);
  if (f.au) c.push(Prisma.sql`f."dateDocument" <= ${f.au}`);
  if (f.objet) c.push(Prisma.sql`f."cles" @> ARRAY[${f.objet}]::text[]`);
  if (f.familles?.length) c.push(Prisma.sql`f."familles" && ARRAY[${Prisma.join(f.familles)}]::text[]`);
  if (pourModele) c.push(Prisma.sql`f."confidentiality" <> 'CONFIDENTIAL' AND f."sensible" = false`);
  return Prisma.join(c, " AND ");
}

async function voiePleinTexte(texte: string, where: Prisma.Sql, page: number): Promise<Touche[]> {
  // La requête en OU : `plainto_tsquery` normalise (repli, racines, mots vides), puis ses « & » deviennent des « | ».
  return prisma.$queryRaw<Touche[]>`
    WITH q AS (SELECT replace(plainto_tsquery('bibliotheque_fr', ${texte})::text, ' & ', ' | ') AS s)
    SELECT p."id" AS "passageId", p."pieceId"
      FROM "BibliothequePassage" p JOIN "BibliothequeFiche" f ON f."pieceId" = p."pieceId", q
     WHERE q.s <> '' AND p."recherche" @@ q.s::tsquery AND ${where}
     ORDER BY ts_rank_cd(p."recherche", q.s::tsquery, 32) DESC, p."pieceId", p."rang"
     LIMIT ${PAGE} OFFSET ${page * PAGE}`;
}

async function voieTitre(texte: string, where: Prisma.Sql, page: number, trigrammes: boolean): Promise<Touche[]> {
  const plie = plier(texte);
  if (plie.length < 3) return [];
  if (!trigrammes) {
    return prisma.$queryRaw<Touche[]>`
      SELECT f."pieceId", NULL::text AS "passageId" FROM "BibliothequeFiche" f
       WHERE f."titrePlie" LIKE ${`%${plie.replace(/[%_\\]/g, "")}%`} AND ${where}
       ORDER BY f."dateDocument" DESC LIMIT ${PAGE} OFFSET ${page * PAGE}`;
  }
  return prisma.$queryRaw<Touche[]>`
    SELECT f."pieceId", NULL::text AS "passageId" FROM "BibliothequeFiche" f
     WHERE ${plie} <% f."titrePlie" AND ${where}
     ORDER BY word_similarity(${plie}, f."titrePlie") DESC, f."pieceId"
     LIMIT ${PAGE} OFFSET ${page * PAGE}`;
}

/**
 * MESURÉ (29/10, banc) : l'index HNSW ne rend que `hnsw.ef_search` voisins (40 par défaut), AVANT les filtres de la
 * requête — une recherche filtrée (format, période, droits) en perdait. On l'élargit pour la requête seule, au-delà
 * de ce qu'une page demande (`SET LOCAL` : la transaction, pas la connexion).
 */
const EF_SEARCH = 4 * PAGE;
/**
 * Le SENS ne rend que ses meilleurs voisins : 50 par page, et seulement ceux à moins de 0,1 du meilleur. MESURÉ
 * (29/10, banc vivant, text-embedding-3-small) : sur un corpus homogène, des centaines de passages passent le
 * seuil absolu à quelques millièmes l'un de l'autre — les garder tous noie la fusion et fait juger des droits pour rien.
 */
const VOISINS = 50;
const ECART_AU_MEILLEUR = 0.1;

async function voieVecteur(vecteur: number[], where: Prisma.Sql, page: number): Promise<Touche[]> {
  const v = litteralVecteur(vecteur);
  const [, lignes] = await prisma.$transaction([
    prisma.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${EF_SEARCH}`),
    prisma.$queryRaw<(Touche & { distance: number })[]>`
      SELECT p."id" AS "passageId", p."pieceId", (p."vecteur" <=> ${v}::vector) AS distance
        FROM "BibliothequePassage" p JOIN "BibliothequeFiche" f ON f."pieceId" = p."pieceId"
       WHERE p."vecteur" IS NOT NULL AND (p."vecteur" <=> ${v}::vector) <= ${1 - SIMILARITE_MIN} AND ${where}
       ORDER BY p."vecteur" <=> ${v}::vector
       LIMIT ${VOISINS} OFFSET ${page * VOISINS}`,
  ]);
  const meilleure = lignes[0]?.distance ?? 0;
  return lignes.filter((l) => l.distance <= meilleure + ECART_AU_MEILLEUR).map(({ pieceId, passageId }) => ({ pieceId, passageId }));
}

/** Sans texte : les pièces les plus récentes que la personne peut ouvrir, sous les filtres. */
async function voieRecents(where: Prisma.Sql, page: number): Promise<Touche[]> {
  return prisma.$queryRaw<Touche[]>`
    SELECT f."pieceId", NULL::text AS "passageId" FROM "BibliothequeFiche" f
     WHERE ${where} ORDER BY f."dateDocument" DESC, f."pieceId" LIMIT ${PAGE} OFFSET ${page * PAGE}`;
}

interface FicheLue {
  pieceId: string; titre: string; format: string; source: SourcePiece; dateDocument: Date; nature: string | null;
  confidentiality: Confidentiality; sensible: boolean; cles: string[];
}

export async function chercherDocuments(
  user: SessionUser,
  requete: string,
  filtres: Parameters<typeof normaliserRequete>[1] = {},
  opts: OptionsRecherche = {},
): Promise<RechercheDocuments> {
  const r = normaliserRequete(requete, filtres, opts.limite);
  const pourModele = opts.pourModele === true;
  const cap = opts.capacites ?? (await capacitesDeLaBase());
  const where = clauseFiltres(r.filtres, pourModele);

  // Le vecteur de la requête part tout de suite, en parallèle des voies lexicales — et n'est attendu que borné.
  const enVol = cap.vecteur && r.texte.length >= 3 ? vecteurDeLaRequete(opts.embed ?? embedderParDefaut, r.texte) : Promise.resolve(null);
  let vecteur: number[] | null = null;

  const gardes: { pieceId: string; passageId: string | null; score: number; voies: Voie[]; fiche: FicheLue; cle: string }[] = [];
  const jugees = new Set<string>();
  let ecartes = 0;
  for (let page = 0; page < PAGES_MAX && gardes.length < r.limite; page++) {
    const [pt, ti, ve] = r.texte
      ? await Promise.all([
        voiePleinTexte(r.texte, where, page),
        voieTitre(r.texte, where, page, cap.trigrammes),
        enVol.then((v) => {
          vecteur = v;
          return v ? voieVecteur(v, where, page) : ([] as Touche[]);
        }),
      ])
      : [await voieRecents(where, page), [] as Touche[], [] as Touche[]];
    const classes = fusionner({ "plein-texte": pt, titre: ti, vecteur: ve }).filter((c) => !jugees.has(c.pieceId));
    if (!classes.length) break;
    const fiches = await prisma.bibliothequeFiche.findMany({
      where: { pieceId: { in: classes.map((c) => c.pieceId) } },
      select: { pieceId: true, titre: true, format: true, source: true, dateDocument: true, nature: true, confidentiality: true, sensible: true, cles: true },
    });
    const parId = new Map(fiches.map((f) => [f.pieceId, f as FicheLue]));
    const ouvrables = await clesOuvrables(user, fiches.flatMap((f) => f.cles));
    for (const c of classes) {
      jugees.add(c.pieceId);
      const f = parId.get(c.pieceId);
      const cle = f?.cles.find((k) => ouvrables.has(k));
      if (!f || !cle) { ecartes += 1; continue; }
      // Double verrou : la clause SQL écarte déjà ces pièces quand le résultat part à un modèle.
      if (pourModele && exclusionPourModele(f)) continue;
      gardes.push({ pieceId: c.pieceId, passageId: c.passageId, score: c.score, voies: Object.keys(c.rangs) as Voie[], fiche: f, cle });
      if (gardes.length >= r.limite) break;
    }
    const pleine = Math.max(pt.length, ti.length, ve.length) >= PAGE;
    if (!pleine) break;
  }

  // Les extraits : le passage le mieux classé, sinon le premier de la pièce.
  const idsPassages = gardes.map((g) => g.passageId).filter((x): x is string => !!x);
  const sansPassage = gardes.filter((g) => !g.passageId).map((g) => g.pieceId);
  const [touches, premiers] = await Promise.all([
    idsPassages.length ? prisma.bibliothequePassage.findMany({ where: { id: { in: idsPassages } }, select: { id: true, texte: true } }) : [],
    sansPassage.length ? prisma.bibliothequePassage.findMany({ where: { pieceId: { in: sansPassage }, rang: 0 }, select: { pieceId: true, texte: true } }) : [],
  ]);
  const texteDuPassage = new Map(touches.map((p) => [p.id, p.texte]));
  const premierDeLaPiece = new Map(premiers.map((p) => [p.pieceId, p.texte]));

  const resultats: ResultatDocument[] = gardes.map((g) => {
    const source = (g.passageId ? texteDuPassage.get(g.passageId) : premierDeLaPiece.get(g.pieceId)) ?? "";
    let extrait = extraire(source, r.texte);
    if (pourModele) extrait = extrait.map((s) => ({ ...s, texte: censurerTexte(s.texte).texte }));
    const c = lireCle(g.cle)!;
    return {
      pieceId: g.pieceId,
      titre: g.fiche.titre,
      format: g.fiche.format as Format,
      source: g.fiche.source,
      date: g.fiche.dateDocument,
      nature: g.fiche.nature,
      confidentiality: g.fiche.confidentiality,
      sensible: g.fiche.sensible,
      endroit: { cle: g.cle, libelle: FAMILLES[c.famille].libelle, lien: lienDe(g.cle)! },
      extrait,
      score: g.score,
      voies: g.voies,
    };
  });
  return { resultats, mode: { ...cap, vecteurUtilise: !!vecteur }, ecartesParLesDroits: ecartes };
}

/**
 * LES PIÈCES, parmi celles données, que cette personne peut ouvrir (au moins un de leurs endroits) — la même règle que
 * `chercherDocuments` et `ouvrirDocuments`. Lue par qui rend un fait TIRÉ d'une pièce (J4 : faits confirmés) : le fait
 * ne se montre pas à qui ne pourrait pas ouvrir la pièce dont il vient.
 */
export async function piecesOuvrables(user: SessionUser, ids: readonly string[]): Promise<Set<string>> {
  const voulus = [...new Set(ids)];
  if (!voulus.length) return new Set();
  const fiches = await prisma.bibliothequeFiche.findMany({ where: { pieceId: { in: voulus } }, select: { pieceId: true, cles: true } });
  const ouvrables = await clesOuvrables(user, fiches.flatMap((f) => f.cles));
  return new Set(fiches.filter((f) => f.cles.some((k) => ouvrables.has(k))).map((f) => f.pieceId));
}

// ─────────────────────────────── Ouvrir ───────────────────────────────

export interface DocumentOuvert {
  pieceId: string;
  titre: string;
  format: Format;
  date: Date;
  endroit: { cle: string; libelle: string; lien: string };
  /** Le texte lu, recomposé depuis ses passages (borné ; `tronque` le dit). */
  texte: string;
  tronque: boolean;
  methode: string | null;
}

export type Refus = { pieceId: string; raison: "INTROUVABLE" | "INTERDIT" | "PAS_ENCORE_LUE" | RaisonExclusionModele; message: string };

export const CARACTERES_OUVERTS_MAX = 60_000;

/** Les passages recousus : chacun reprend là où le précédent s'arrête (ils se chevauchent). */
function recoudre(passages: { debut: number; texte: string }[], max: number): { texte: string; tronque: boolean } {
  let texte = "";
  let fin = 0;
  for (const p of passages) {
    const reste = p.debut >= fin ? p.texte : p.texte.slice(Math.max(0, fin - p.debut));
    if (reste) texte += (texte && p.debut >= fin ? "\n" : "") + reste;
    fin = Math.max(fin, p.debut + p.texte.length);
    if (texte.length > max) return { texte: texte.slice(0, max), tronque: true };
  }
  return { texte, tronque: false };
}

export async function ouvrirDocuments(
  user: SessionUser,
  ids: readonly string[],
  opts: { pourModele?: boolean; caracteresMax?: number } = {},
): Promise<{ documents: DocumentOuvert[]; refus: Refus[] }> {
  const voulus = [...new Set(ids)].slice(0, 20);
  const fiches = await prisma.bibliothequeFiche.findMany({
    where: { pieceId: { in: voulus } },
    select: { pieceId: true, titre: true, format: true, dateDocument: true, confidentiality: true, sensible: true, cles: true, statut: true, methode: true },
  });
  const parId = new Map(fiches.map((f) => [f.pieceId, f]));
  const ouvrables = await clesOuvrables(user, fiches.flatMap((f) => f.cles));
  const documents: DocumentOuvert[] = [];
  const refus: Refus[] = [];
  for (const id of voulus) {
    const f = parId.get(id);
    const cle = f?.cles.find((k) => ouvrables.has(k));
    // Introuvable et interdit se disent pareil à un modèle : la différence révélerait qu'une pièce existe.
    if (!f || !cle) { refus.push({ pieceId: id, raison: f ? "INTERDIT" : "INTROUVABLE", message: "Pièce introuvable ou inaccessible." }); continue; }
    const exclusion = opts.pourModele ? exclusionPourModele(f) : null;
    if (exclusion) { refus.push({ pieceId: id, raison: exclusion, message: RAISONS_EXCLUSION_MODELE[exclusion] }); continue; }
    if (f.statut !== "FAITE") { refus.push({ pieceId: id, raison: "PAS_ENCORE_LUE", message: "La pièce n'est pas encore lue par la bibliothèque." }); continue; }
    const passages = await prisma.bibliothequePassage.findMany({ where: { pieceId: id }, orderBy: { rang: "asc" }, select: { debut: true, texte: true } });
    let { texte, tronque } = recoudre(passages, opts.caracteresMax ?? CARACTERES_OUVERTS_MAX);
    if (opts.pourModele) texte = censurerTexte(texte).texte;
    const c = lireCle(cle)!;
    documents.push({
      pieceId: id, titre: f.titre, format: f.format as Format, date: f.dateDocument,
      endroit: { cle, libelle: FAMILLES[c.famille].libelle, lien: lienDe(cle)! }, texte, tronque, methode: f.methode,
    });
  }
  return { documents, refus };
}

/** Une pièce d'un DOSSIER, telle que la Bibliothèque la connaît déjà — sans relire le fichier (J11, décision 0030). */
export interface FicheDeDossier {
  pieceId: string;
  titre: string;
  format: string;
  nature: string | null;
  statut: string;
  /** Le début du texte lu (premier passage, censuré) — absent si la pièce n'est pas lue ou ne part pas au modèle. */
  extrait: string | null;
  /** Pourquoi le texte ne part pas au modèle (pièce du coffre, confidentielle) — `null` sinon. */
  exclusion: RaisonExclusionModele | null;
}

/**
 * LES FICHES D'UN DOSSIER, en lot (jusqu'à 2 000 pièces) : titre, format, nature, état de lecture, et le début du texte
 * lu. MÊMES DROITS que `ouvrirDocuments` (une pièce dont aucun endroit n'est ouvert à la personne n'est pas rendue) et
 * même politique pour un modèle (coffre, confidentiel : le titre seul, sans texte). Une requête par table, pas une
 * par pièce : 300 fichiers se lisent en une passe.
 */
export async function fichesDeDossier(
  user: SessionUser, ids: readonly string[], opts: { pourModele?: boolean; caracteres?: number } = {},
): Promise<FicheDeDossier[]> {
  const voulus = [...new Set(ids)].slice(0, 2000);
  if (!voulus.length) return [];
  const fiches = await prisma.bibliothequeFiche.findMany({
    where: { pieceId: { in: voulus } },
    select: { pieceId: true, titre: true, format: true, nature: true, statut: true, confidentiality: true, sensible: true, cles: true },
  });
  const ouvrables = await clesOuvrables(user, fiches.flatMap((f) => f.cles));
  const visibles = fiches.filter((f) => f.cles.some((k) => ouvrables.has(k)));
  const exclusions = new Map(visibles.map((f) => [f.pieceId, opts.pourModele ? exclusionPourModele(f) : null]));
  const lisibles = visibles.filter((f) => f.statut === "FAITE" && !exclusions.get(f.pieceId)).map((f) => f.pieceId);
  const premiers = lisibles.length
    ? await prisma.bibliothequePassage.findMany({ where: { pieceId: { in: lisibles }, rang: 0 }, select: { pieceId: true, texte: true } })
    : [];
  const max = opts.caracteres ?? 600;
  const extraits = new Map(premiers.map((p) => [p.pieceId, opts.pourModele ? censurerTexte(p.texte.slice(0, max)).texte : p.texte.slice(0, max)]));
  return visibles.map((f) => ({
    pieceId: f.pieceId, titre: f.titre, format: f.format, nature: f.nature, statut: f.statut,
    extrait: extraits.get(f.pieceId) ?? null, exclusion: exclusions.get(f.pieceId) ?? null,
  }));
}
