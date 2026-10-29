/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'EXCEL GOD MODE, VU D'ADAM — le pont entre les questions (« vérifie ce fichier », « d'où vient
 * ce chiffre », « qu'est-ce qui a changé ») et le Drive.
 *
 * ── CE QUE FAIT CE FICHIER, ET CE QU'IL NE FAIT PAS ─────────────────────────────────────
 *
 * Il RÉSOUT une cible (un identifiant Drive, ou un nom tel que la personne le dit), LIT les
 * octets par le port — donc avec les droits de la personne, `canViewDrive`, vérifiés là et
 * nulle part ailleurs (§74) — et appelle la façade pure `artifact/sheets/analyse.ts`. Il ne
 * calcule rien lui-même : tout ce qui se teste sans base est dans `artifact/sheets/`.
 *
 * ── LE CACHE, ET POURQUOI IL EST PETIT ──────────────────────────────────────────────────
 *
 * « Vérifie le budget » puis « d'où vient le total de D45 ? » puis « et si je change la TVA ? »
 * portent sur le MÊME fichier. Relire cent mille lignes à chaque question coûterait deux
 * secondes par question ; on garde les dernières analyses en mémoire, par (fichier, version,
 * personne). Par PERSONNE : une analyse obtenue avec les droits de l'un ne sert jamais à un
 * autre. Dix minutes, six entrées — assez pour une conversation, pas assez pour devenir un état.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { CurrentUser } from "@/lib/session";
import type { FicheDocument } from "@/lib/artifact/ports";
import {
  analyserClasseur, comparerFichiersXlsx, lirePlage, resumerAudit, tracerCellule, type Analyse,
} from "@/lib/artifact/sheets/analyse";
import { construireClasseurVerifie, type SpecClasseur, type Verification } from "@/lib/artifact/sheets/build";
import { MIME_XLSX } from "@/lib/artifact/adapters/xlsx/adapter";
import { portsArtefact } from "@/platform/ia/artifact/ports";

export interface CibleClasseur {
  nodeId?: string | null;
  nom?: string | null;
  /** Une version précise ; vide = la courante. */
  version?: number | null;
}

export interface DocumentVise { nodeId: string; nom: string; version: number; taille: number }

type Resolution =
  | { ok: true; fiche: FicheDocument; version: number }
  | { ok: false; motif: string; candidats?: { nodeId: string; nom: string; format: string | null }[] };

const estXlsx = (f: FicheDocument): boolean => f.format === "XLSX" || /\.xls[xm]$/i.test(f.nom);

async function resoudre(user: CurrentUser, cible: CibleClasseur): Promise<Resolution> {
  if (cible.nodeId) {
    const fiche = await portsArtefact.documents.decrire(user.id, cible.nodeId);
    if (!fiche) return { ok: false, motif: "Ce document n'existe pas, ou vous n'y avez pas accès." };
    if (!estXlsx(fiche)) return { ok: false, motif: `« ${fiche.nom} » n'est pas un classeur Excel (.xlsx).` };
    return { ok: true, fiche, version: cible.version ?? fiche.version };
  }
  const nom = (cible.nom ?? "").trim();
  if (!nom) return { ok: false, motif: "Dites-moi quel classeur : son nom, ou son identifiant Drive." };
  const trouves = (await portsArtefact.documents.chercher(user.id, nom, 8)).filter(estXlsx);
  if (trouves.length === 0) return { ok: false, motif: `Aucun classeur Excel nommé « ${nom} » dans ce que vous pouvez voir.` };
  const exact = trouves.filter((f) => f.nom.toLowerCase() === nom.toLowerCase() || f.nom.toLowerCase().replace(/\.xls[xm]$/i, "") === nom.toLowerCase());
  const retenu = exact.length === 1 ? exact[0] : trouves.length === 1 ? trouves[0] : null;
  if (!retenu) {
    return { ok: false, motif: `${trouves.length} classeurs correspondent à « ${nom} » : lequel ?`, candidats: trouves.map((f) => ({ nodeId: f.nodeId, nom: f.nom, format: f.format })) };
  }
  return { ok: true, fiche: retenu, version: cible.version ?? retenu.version };
}

const CACHE_MAX = 6;
const CACHE_TTL_MS = 10 * 60 * 1000;
/**
 * Le plafond de CELLULES gardées en mémoire, toutes analyses confondues. Mesuré (`sheets:bench`) :
 * un classeur de 1,2 million de cellules avec son graphe pèse ~400 Mo. Six analyses de cette
 * taille ne tiendraient pas dans une instance : on borne par le contenu, pas par le compte.
 */
const CACHE_CELLULES_MAX = 3_000_000;
const cache = new Map<string, { at: number; cellules: number; analyse: Promise<Analyse | null> }>();

function purger(sauf: string): void {
  const maintenant = Date.now();
  for (const [k, v] of cache) if (k !== sauf && maintenant - v.at >= CACHE_TTL_MS) cache.delete(k);
  let total = [...cache.values()].reduce((s, v) => s + v.cellules, 0);
  for (const [k, v] of cache) {
    if (cache.size <= CACHE_MAX && total <= CACHE_CELLULES_MAX) break;
    if (k === sauf) continue;
    cache.delete(k); total -= v.cellules;
  }
}

function analyseDe(user: CurrentUser, fiche: FicheDocument, version: number): Promise<Analyse | null> {
  const cle = `${user.id}|${fiche.nodeId}@${version}`;
  const maintenant = Date.now();
  const existante = cache.get(cle);
  if (existante && maintenant - existante.at < CACHE_TTL_MS) return existante.analyse;
  const entree = { at: maintenant, cellules: 0, analyse: Promise.resolve<Analyse | null>(null) };
  entree.analyse = (async () => {
    const octets = await portsArtefact.documents.lire(user.id, fiche.nodeId, version);
    if (!octets) return null;
    const a = await analyserClasseur(octets);
    entree.cellules = a.structure.cellules;
    purger(cle);
    return a;
  })();
  cache.set(cle, entree);
  purger(cle);
  return entree.analyse;
}

const documentDe = (fiche: FicheDocument, version: number): DocumentVise => ({ nodeId: fiche.nodeId, nom: fiche.nom, version, taille: fiche.taille });

type Echec = { ok: false; motif: string; candidats?: { nodeId: string; nom: string; format: string | null }[] };

/** « Vérifie ce classeur » : structure, recalcul et audit, prêts à être dits. */
export async function auditerClasseurDrive(user: CurrentUser, cible: CibleClasseur, opts: { maxConstats?: number } = {}): Promise<Echec | {
  ok: true; document: DocumentVise; structure: Analyse["structure"];
  audit: { resume: string; total: number; parGravite: Analyse["audit"]["parGravite"]; parCode: Analyse["audit"]["parCode"]; constats: Analyse["audit"]["constats"] };
  recalcul: { formules: number; ecarts: number; nonCalculees: number; nonVerifiees: number; circulaires: number; fonctionsInconnues: string[] };
  metriques: Analyse["metriques"];
}> {
  const r = await resoudre(user, cible);
  if (!r.ok) return r;
  const a = await analyseDe(user, r.fiche, r.version);
  if (!a) return { ok: false, motif: `Impossible de lire « ${r.fiche.nom} » (version ${r.version}).` };
  return {
    ok: true, document: documentDe(r.fiche, r.version), structure: a.structure,
    audit: { resume: resumerAudit(a.audit), total: a.audit.total, parGravite: a.audit.parGravite, parCode: a.audit.parCode, constats: a.audit.constats.slice(0, opts.maxConstats ?? 40) },
    recalcul: {
      formules: a.recalcul.metriques.formules, ecarts: a.recalcul.ecarts.length, nonCalculees: a.recalcul.nonCalculees.length,
      nonVerifiees: a.recalcul.nonVerifiees.length, circulaires: a.recalcul.circulaires.length, fonctionsInconnues: a.recalcul.fonctionsInconnues,
    },
    metriques: a.metriques,
  };
}

/** « D'où vient ce chiffre ? » */
export async function tracerCelluleDrive(user: CurrentUser, cible: CibleClasseur, ref: string, feuille?: string | null) {
  const r = await resoudre(user, cible);
  if (!r.ok) return r;
  const a = await analyseDe(user, r.fiche, r.version);
  if (!a) return { ok: false as const, motif: `Impossible de lire « ${r.fiche.nom} ».` };
  const trace = tracerCellule(a.classeur, a.graphe, a.recalcul, ref, { feuille });
  return { ok: trace.ok, motif: trace.motif, document: documentDe(r.fiche, r.version), trace };
}

/** « Montre-moi Ventes!A1:F20 » — sans ouvrir le Live Office. */
export async function lirePlageDrive(user: CurrentUser, cible: CibleClasseur, plage: string, feuille?: string | null) {
  const r = await resoudre(user, cible);
  if (!r.ok) return r;
  const a = await analyseDe(user, r.fiche, r.version);
  if (!a) return { ok: false as const, motif: `Impossible de lire « ${r.fiche.nom} ».` };
  const lecture = lirePlage(a.classeur, plage, { feuille });
  return { ...lecture, document: documentDe(r.fiche, r.version) };
}

/**
 * « Qu'est-ce qui a changé ? » — deux versions du même fichier (par défaut : la courante contre
 * la précédente), ou deux fichiers différents.
 */
export async function comparerClasseursDrive(user: CurrentUser, avant: CibleClasseur, apres?: CibleClasseur | null, opts: { maxDetails?: number } = {}) {
  const rb = await resoudre(user, apres && (apres.nodeId || apres.nom) ? apres : avant);
  if (!rb.ok) return rb;
  let ra: Resolution;
  if (apres && (apres.nodeId || apres.nom)) {
    ra = await resoudre(user, avant);
  } else {
    // Même fichier : « avant » est la version demandée, sinon la précédente.
    const versionAvant = avant.version ?? (apres?.version ?? rb.version) - 1;
    if (versionAvant < 1) return { ok: false as const, motif: `« ${rb.fiche.nom} » n'a qu'une version : rien à comparer.` };
    ra = { ok: true, fiche: rb.fiche, version: versionAvant };
  }
  if (!ra.ok) return ra;
  if (ra.fiche.nodeId === rb.fiche.nodeId && ra.version === rb.version) return { ok: false as const, motif: "Ce sont les mêmes octets : même fichier, même version." };
  const [oa, ob] = await Promise.all([
    portsArtefact.documents.lire(user.id, ra.fiche.nodeId, ra.version),
    portsArtefact.documents.lire(user.id, rb.fiche.nodeId, rb.version),
  ]);
  if (!oa || !ob) return { ok: false as const, motif: "L'une des deux versions est illisible ou inaccessible." };
  const c = await comparerFichiersXlsx(oa, ob, { maxDetails: opts.maxDetails ?? 60 });
  return { ok: true as const, avant: documentDe(ra.fiche, ra.version), apres: documentDe(rb.fiche, rb.version), comparaison: c };
}

/**
 * CONSTRUIT un classeur vérifié et l'ÉCRIT dans le Drive personnel de la personne — un NOUVEAU
 * fichier, jamais par-dessus un existant. Si la vérification échoue (formule en erreur, constat
 * critique ou haut), RIEN n'est écrit : on rend les constats, et c'est au modèle de corriger sa
 * spécification. Un classeur faux dans le Drive est pire qu'un classeur absent.
 */
export async function construireClasseurDrive(
  user: CurrentUser, opts: { nom: string; spec: SpecClasseur; dossier?: string },
): Promise<{ ok: true; nodeId: string; nom: string; version: number; verification: Verification; taille: number; ms: number } | { ok: false; motif: string; verification?: Verification }> {
  const nom = /\.xlsx$/i.test(opts.nom.trim()) ? opts.nom.trim() : `${opts.nom.trim() || "Classeur Adam"}.xlsx`;
  let construit;
  try {
    construit = await construireClasseurVerifie({ ...opts.spec, auteur: opts.spec.auteur ?? user.name ?? "Adam" });
  } catch (e) {
    return { ok: false, motif: `Spécification invalide : ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!construit.verification.ok) {
    const raisons = [
      ...construit.verification.erreurs.slice(0, 5).map((e) => `${e.ref} : =${e.formule} → ${e.erreur}`),
      ...construit.verification.constats.slice(0, 5).map((c) => `${c.feuille}!${c.cellule} : ${c.message}`),
    ];
    return { ok: false, motif: `Le classeur n'a pas été écrit : la vérification a échoué — ${raisons.join(" ; ")}`, verification: construit.verification };
  }
  const cree = await portsArtefact.documents.creerFichier(user.id, { nom, octets: construit.octets, mime: MIME_XLSX, dossier: opts.dossier });
  await portsArtefact.audit.tracer({
    userId: user.id, action: "sheet_build", cible: cree.nodeId,
    detail: `classeur construit et vérifié : ${construit.verification.formules} formule(s), 0 écart, ${opts.spec.feuilles.length} feuille(s)`,
  });
  return { ok: true, nodeId: cree.nodeId, nom, version: cree.version, verification: construit.verification, taille: construit.octets.length, ms: construit.ms };
}

/** Pour les tests : vider le cache d'analyses. */
export function oublierAnalyses(): void { cache.clear(); }
