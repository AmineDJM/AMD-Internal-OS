import { Prisma, type TacheEnrichissement, type TypeSujetFait } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getBlob, sha256 } from "@/lib/drive-storage";
import type { ClesCoffre } from "@/lib/coffre/cle";
import { porteDuCoffre, type PorteCoffre } from "./porte-coffre";
import { lireFichierUneFois } from "@/lib/pieces-lues/lecture-fichier";
import { FORMATS_LUS, PAGES_MAX } from "@/lib/pieces-lues/formats";
import type { MoteurOcr } from "@/lib/regulatory/intelligence/extract/texte-ou-ocr";
import { classerPiece } from "./classement";
import { deciderFait, resoudreSujet, type ResolutionSujet } from "./decision";
import type { ConfidentialitePiece, SourceDepot } from "./depot";
import { emettrePieceDeposee } from "./evenements";
import { extraireParNature, type NatureCommerciale } from "./extraction";
import { extraireDevisFacture } from "./extracteurs/devis-facture";
import { candidatsOrganisations, candidatsPersonnes, compacterIdentifiant, personneDuPorteur, personnesParEmpreinte, porteursDesLiens } from "./fiches";
import { confirmerFaitPropose, ouvrirConflit } from "./confirmation";
import {
  ESSAIS_MAX, PLAFOND_PAR_PASSAGE, VERROU_PERIME_MS, erreurPourJournal, extensionDe, extractionIdDe, faitProposeIdDe,
  issueApresEchec, pieceIdDe, raisonDIgnorer, sourcePieceDe,
} from "./file";
import { enrichissementActif } from "./signalement";
import { IDENTIFIANTS_SENSIBLES_PERSONNE, choisirSujet, estPorteurDePersonne, natureCoffreDe, sujetEstLePorteur, type ChoixSujet } from "./sujets";
import { ATTRIBUT_PAR_CLE, NATURES_PIECE, type FaitExtrait, type NaturePiece, type ResultatExtraction } from "./types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PASSAGE D'ENRICHISSEMENT — la file, de la pièce déposée au fait confirmé (lot V2-A, §3-E).
 *
 *   tâche → Piece (par empreinte) + PieceLien → lecture LOCALE du texte (une fois par empreinte)
 *         → classement (`classement.ts`) → extraction par nature (`extraction.ts`) → `FaitPropose`
 *         → sujet (`sujets.ts`) → décision (`decision.ts`) → `FaitConfirme` / `ConflitDeFait` / coffre.
 *
 * ── RIEN NE QUITTE LE SERVEUR ───────────────────────────────────────────────────────────────
 *
 * Le texte est lu par `lireFichierUneFois({ cloud: false })` : couche texte ou OCR local, jamais un
 * service tiers ; les extracteurs sont des règles ; les pièces commerciales passent par la lecture des
 * pièces en mode CONFIDENTIEL (`sortieCloudPermise: false` — aucun modèle approché). Une pièce
 * d'identité ou de paie ne voit donc jamais un modèle externe, et une extraction qui se déclarerait
 * non locale est refusée (`ErreurNonLocale`). La Direction ouvrira peut-être un jour la lecture par
 * modèle des pièces ordinaires : ce sera une branche de plus, jamais pour `NATURES_LOCALES`.
 *
 * ── REJOUABLE ───────────────────────────────────────────────────────────────────────────────
 *
 * Identifiants dérivés (`file.ts`) : rejouer une tâche, ou traiter deux rattachements de la même pièce,
 * ne crée ni seconde pièce, ni seconde extraction, ni second fait. Les valeurs sensibles ne sont pas
 * gardées en clair (`FaitPropose` les interdit) : quand le sujet d'un fait sensible n'est connu
 * qu'à un dépôt ultérieur, la pièce est RELUE (lecture en cache par empreinte) et l'extraction,
 * déterministe, rend la valeur au même rang.
 *
 * ── LA FILE ─────────────────────────────────────────────────────────────────────────────────
 *
 * `traiterLaFile({ max })` prend les tâches dues une à une (`FOR UPDATE SKIP LOCKED` : deux instances
 * ne prennent jamais la même), reprend celles d'un processus tombé (verrou périmé), réessaie après
 * échec à intervalles croissants puis abandonne en le disant (`ECHEC`, erreur écrite). Appelé par le
 * battement `runScheduledJobs` aujourd'hui, par le worker séparé demain (lot V2-F) — même fonction.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface DependancesChaine {
  /** Les octets d'un blob (`getBlob` par défaut). */
  lireOctets?: (blobId: string) => Promise<Buffer | null>;
  /** Le moteur OCR — injecté aux tests (sans réseau ni données de langue), toujours appelé `cloud: false`. */
  ocr?: MoteurOcr;
  /** Les clés du coffre (lues dans l'environnement par défaut). */
  cles?: () => ClesCoffre;
  horloge?: () => Date;
}

export interface BilanTache {
  nature?: NaturePiece;
  faits: number;
  confirmesDOffice: number;
  aConfirmer: number;
  conflits: number;
  auCoffre: number;
  ignores: number;
  sansSujet: number;
  raison?: string;
}

export interface BilanPassage {
  actif: boolean;
  prises: number;
  faites: number;
  ignorees: number;
  reportees: number;
  echecs: number;
  reprises: number;
}

/** Une extraction qui se dirait non locale : refusée, rien n'est écrit. */
export class ErreurNonLocale extends Error {}

const bilanVide = (): BilanTache => ({ faits: 0, confirmesDOffice: 0, aConfirmer: 0, conflits: 0, auCoffre: 0, ignores: 0, sansSujet: 0 });

// ───────────────────────────────────────── La file ─────────────────────────────────────────

/** Le passage : au plus `max` tâches dues, une à une. Ne lève jamais ; interrupteur fermé, ne fait rien. */
export async function traiterLaFile(opts: { max?: number } = {}, deps: DependancesChaine = {}): Promise<BilanPassage> {
  const bilan: BilanPassage = { actif: false, prises: 0, faites: 0, ignorees: 0, reportees: 0, echecs: 0, reprises: 0 };
  try {
    if (!(await enrichissementActif())) return bilan;
    bilan.actif = true;
    const horloge = deps.horloge ?? (() => new Date());
    const max = Math.max(0, Math.min(opts.max ?? PLAFOND_PAR_PASSAGE, 200));

    // Un processus tombé en pleine tâche l'a laissée EN_COURS : passé le délai, elle se reprend.
    const repris = await prisma.tacheEnrichissement.updateMany({
      where: { statut: "EN_COURS", verrouilleLe: { lt: new Date(horloge().getTime() - VERROU_PERIME_MS) } },
      data: { statut: "A_FAIRE", verrouilleLe: null },
    });
    bilan.reprises = repris.count;

    for (let i = 0; i < max; i++) {
      const tache = await prendreUneTache(horloge());
      if (!tache) break;
      bilan.prises += 1;
      const issue = await executer(tache, deps, horloge);
      if (issue === "FAITE") bilan.faites += 1;
      else if (issue === "IGNOREE") bilan.ignorees += 1;
      else if (issue === "ECHEC") bilan.echecs += 1;
      else bilan.reportees += 1;
    }
  } catch (err) {
    console.error("[enrichissement] passage interrompu", err);
  }
  return bilan;
}

/** Prend la plus ancienne tâche due, atomiquement (deux instances ne prennent jamais la même). */
async function prendreUneTache(maintenant: Date): Promise<TacheEnrichissement | null> {
  const lignes = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "TacheEnrichissement"
       SET "statut" = 'EN_COURS', "verrouilleLe" = ${maintenant}::timestamptz AT TIME ZONE 'UTC',
           "tentatives" = "tentatives" + 1, "updatedAt" = ${maintenant}::timestamptz AT TIME ZONE 'UTC'
     WHERE "id" = (
       SELECT "id" FROM "TacheEnrichissement"
        WHERE "statut" = 'A_FAIRE' AND "prochainEssaiLe" <= ${maintenant}::timestamptz AT TIME ZONE 'UTC'
        ORDER BY "prochainEssaiLe", "createdAt"
        LIMIT 1
        FOR UPDATE SKIP LOCKED)
    RETURNING "id"`;
  const id = lignes[0]?.id;
  return id ? prisma.tacheEnrichissement.findUnique({ where: { id } }) : null;
}

async function executer(t: TacheEnrichissement, deps: DependancesChaine, horloge: () => Date): Promise<"FAITE" | "IGNOREE" | "REPORTEE" | "ECHEC"> {
  try {
    const r = await traiterTache(t, deps);
    await prisma.tacheEnrichissement.update({
      where: { id: t.id },
      data: { statut: r.statut, pieceId: r.pieceId, bilan: r.bilan as unknown as Prisma.InputJsonValue, verrouilleLe: null, derniereErreur: null },
    });
    return r.statut;
  } catch (err) {
    const erreur = erreurPourJournal(err);
    console.error(`[enrichissement] tâche ${t.id} (essai ${t.tentatives}/${ESSAIS_MAX})`, erreur);
    const suite = issueApresEchec(t.tentatives, horloge());
    await prisma.tacheEnrichissement.update({
      where: { id: t.id },
      data: { statut: suite.statut, prochainEssaiLe: suite.prochainEssaiLe, verrouilleLe: null, derniereErreur: erreur },
    }).catch((e) => console.error("[enrichissement] tâche non refermée", e));
    return suite.statut === "ECHEC" ? "ECHEC" : "REPORTEE";
  }
}

// ───────────────────────────────────────── Une tâche ─────────────────────────────────────────

/** Traite UNE tâche. Lève sur une erreur passagère (la file réessaiera) ; rend `IGNOREE` pour ce qui ne se lit pas. */
export async function traiterTache(t: TacheEnrichissement, deps: DependancesChaine = {}): Promise<{ statut: "FAITE" | "IGNOREE"; pieceId: string | null; bilan: BilanTache }> {
  const lireOctets = deps.lireOctets ?? getBlob;
  const bilan = bilanVide();
  const rattachement = { type: t.rattachementType, id: t.rattachementId, role: t.role };
  let octets: Buffer | null = null;

  // 1. L'EMPREINTE d'un dépôt direct se calcule ici (relecture du blob), puis le fait est émis.
  let empreinte = t.empreinte;
  if (!empreinte) {
    const ignorer = raisonDIgnorer(t, FORMATS_LUS);
    if (ignorer) return { statut: "IGNOREE", pieceId: null, bilan: { ...bilan, raison: ignorer } };
    octets = await lireOctets(t.blobId);
    if (!octets) throw new Error("contenu du dépôt direct introuvable");
    empreinte = sha256(octets);
    await prisma.tacheEnrichissement.update({ where: { id: t.id }, data: { empreinte } });
    await emettrePieceDeposee({
      blobId: t.blobId, empreinte, nomFichier: t.nomFichier, mime: t.mime, taille: t.taille, source: t.source as SourceDepot,
      deposeParId: t.deposeParId, rattachements: [rattachement], confidentialite: t.confidentiality as ConfidentialitePiece, deposeLe: t.deposeLe,
    });
  }

  // 2. LA PIÈCE ET SON LIEN — R5, quoi qu'il advienne de la lecture.
  const pieceId = await assurerPiece(t, empreinte);
  await assurerLien(pieceId, t);

  const ignorer = raisonDIgnorer(t, FORMATS_LUS);
  if (ignorer) return { statut: "IGNOREE", pieceId, bilan: { ...bilan, raison: ignorer } };

  // 3. LE TEXTE, lu sur ce serveur, une fois par empreinte.
  octets ??= await lireOctets(t.blobId);
  if (!octets) throw new Error("contenu de la pièce introuvable");
  const ext = extensionDe(t.nomFichier, t.mime);
  const lu = await lireFichierUneFois({ octets, ext, cloud: false, maxPages: PAGES_MAX, userId: t.deposeParId }, deps.ocr ? { ocr: deps.ocr } : {});
  if (!lu.ok) throw new Error(lu.message);
  const texte = lu.lecture.texte;

  // 4. LA NATURE — classée une fois ; un classement déjà posé fait foi.
  const piece = await prisma.piece.findUniqueOrThrow({ where: { id: pieceId }, select: { nature: true } });
  let nature = (NATURES_PIECE as readonly string[]).includes(piece.nature ?? "") ? (piece.nature as NaturePiece) : null;
  if (!nature) {
    const c = classerPiece({ nomFichier: t.nomFichier, mime: t.mime, texte });
    nature = c.nature;
    await prisma.piece.update({ where: { id: pieceId }, data: { nature, natureConfiance: c.confiance } });
  }
  bilan.nature = nature;

  // 5. L'EXTRACTION — en mémoire à chaque passage (déterministe), écrite une fois.
  const debut = Date.now();
  const resultat = await extraire(nature, texte, t, octets, rattachement.type);
  if (!resultat.local) throw new ErreurNonLocale(`extraction « ${resultat.moteur} » non locale : refusée`);
  const extractionId = await assurerExtraction(pieceId, resultat, Date.now() - debut);
  bilan.faits = resultat.faits.length;

  // 6. LES SUJETS ET LES DÉCISIONS — pour les faits encore sans fiche.
  await deciderLesFaits(pieceId, extractionId, nature, resultat.faits, deps, bilan);
  return { statut: "FAITE", pieceId, bilan };
}

async function assurerPiece(t: TacheEnrichissement, empreinte: string): Promise<string> {
  const id = pieceIdDe(empreinte);
  await prisma.piece.upsert({
    where: { id },
    create: {
      id, blobId: t.blobId, empreinte, nom: t.nomFichier, mime: t.mime, taille: t.taille, confidentiality: t.confidentiality,
      source: sourcePieceDe(t.source as SourceDepot), deposeeParId: t.deposeParId, deposeeLe: t.deposeLe,
    },
    update: {},
  });
  // Une pièce déposée ailleurs sous une confidentialité plus stricte la garde (jamais l'inverse).
  if (t.confidentiality !== "INTERNAL") {
    const plusStricte = t.confidentiality === "CONFIDENTIAL" ? ["INTERNAL", "RESTRICTED"] : ["INTERNAL"];
    await prisma.piece.updateMany({ where: { id, confidentiality: { in: plusStricte as ("INTERNAL" | "RESTRICTED")[] } }, data: { confidentiality: t.confidentiality } });
  }
  return id;
}

/** Le lien de la pièce à la fiche du dépôt ; et la colonne `pieceId` du document ou du fichier Drive. */
async function assurerLien(pieceId: string, t: TacheEnrichissement): Promise<void> {
  const sujetType = t.rattachementType === "PERSONNE" ? "PERSONNE" : t.rattachementType === "ORGANISATION" ? "ORGANISATION" : "ENTITE";
  await prisma.pieceLien.createMany({
    data: [{ pieceId, sujetType, sujetId: t.rattachementId, entityType: sujetType === "ENTITE" ? t.rattachementType : null, role: t.role, creeParId: t.deposeParId }],
    skipDuplicates: true,
  });
  if (t.rattachementType === "DOCUMENT") await prisma.document.updateMany({ where: { id: t.rattachementId, pieceId: null }, data: { pieceId } });
  if (t.rattachementType === "DRIVE_NODE") await prisma.driveNode.updateMany({ where: { id: t.rattachementId, pieceId: null }, data: { pieceId } });
}

async function extraire(nature: NaturePiece, texte: string, t: TacheEnrichissement, octets: Buffer, typeRattachement: string): Promise<ResultatExtraction> {
  const titulaire = estPorteurDePersonne(typeRattachement) ? "PERSONNE" : typeRattachement === "ORGANISATION" ? "ORGANISATION" : undefined;
  const e = extraireParNature(nature, { texte, nomFichier: t.nomFichier, titulaire });
  if (e.genre === "FAITE") return e.resultat;
  if (e.genre === "SANS_EXTRACTEUR") return { nature, moteur: "aucun", local: true, faits: [], notes: [e.note] };
  return extraireCommerciale(e.nature, texte, t, octets);
}

/** Devis, facture, BC, avoir : la lecture des pièces, en mode CONFIDENTIEL — aucun modèle approché. */
async function extraireCommerciale(nature: NatureCommerciale, texte: string, t: TacheEnrichissement, octets: Buffer): Promise<ResultatExtraction> {
  const { proposerLecture } = await import("@/lib/pieces-lues/service");
  const p = await proposerLecture({
    user: { id: t.deposeParId ?? "systeme" },
    octets,
    nomFichier: t.nomFichier,
    contexte: { cible: "LEGAL_DOCUMENT", sortieCloudPermise: false, annuaireVisible: [] },
  });
  if (!p.ok) return { nature, moteur: "pieces-lues", local: true, faits: [], notes: [p.error] };
  return extraireDevisFacture({ proposition: p.proposition, texte, nature });
}

/** L'extraction et ses faits proposés, écrits UNE fois (identifiants dérivés). Rend l'identifiant de l'extraction. */
async function assurerExtraction(pieceId: string, r: ResultatExtraction, dureeMs: number): Promise<string> {
  const id = extractionIdDe(pieceId);
  const existe = await prisma.extraction.findUnique({ where: { id }, select: { id: true } });
  if (existe) return id;
  try {
    await prisma.extraction.create({ data: { id, pieceId, nature: r.nature, moteur: r.moteur, local: r.local, statut: "TERMINEE", notes: r.notes.slice(0, 20), dureeMs } });
  } catch (err) {
    // Une autre instance l'a écrite entre-temps : la sienne fait foi.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    return id;
  }
  if (r.faits.length) {
    await prisma.faitPropose.createMany({
      data: r.faits.map((f, rang) => ({
        id: faitProposeIdDe(id, rang),
        extractionId: id,
        sujetRef: f.sujetRef,
        sujetType: f.sujetType,
        role: f.role,
        attribut: f.attribut,
        // Un fait sensible ne garde RIEN en clair : ni valeur, ni extrait lisible (contrainte en base).
        valeur: f.sensible ? null : f.valeur,
        valeurNormalisee: f.sensible ? null : f.valeurNormalisee,
        confiance: Math.min(1, Math.max(0, Number.isFinite(f.confiance) ? f.confiance : 0)),
        preuve: { page: f.preuve.page, extrait: f.sensible ? "[valeur sensible — au coffre]" : f.preuve.extrait },
        sensible: f.sensible,
        raisonDecision: "En attente du sujet.",
      })),
      skipDuplicates: true,
    });
  }
  return id;
}

// ───────────────────────────────────────── Sujets et décisions ─────────────────────────────────────────

const rangDe = (faitId: string): number => Number(/_f(\d+)$/.exec(faitId)?.[1] ?? -1);

const NATURES_IDENTIFIANTS: Record<string, string> = {
  "personne.passeport.numero": "PASSEPORT_NUMERO", "personne.cni.numero": "CNI_NUMERO", "personne.nin": "NIN",
};

async function deciderLesFaits(
  pieceId: string, extractionId: string, nature: NaturePiece, faits: readonly FaitExtrait[], deps: DependancesChaine, bilan: BilanTache,
): Promise<void> {
  const enAttente = await prisma.faitPropose.findMany({
    where: { extractionId, sujetId: null, decision: "EN_ATTENTE" },
    select: { id: true, sujetRef: true, sujetType: true, role: true },
    orderBy: { id: "asc" },
  });
  if (enAttente.length === 0) return;
  const coffre = porteDuCoffre(deps.cles, deps.horloge);
  const maintenant = (deps.horloge ?? (() => new Date()))();

  // Les faits d'un même sujet de la pièce, avec leur valeur EN MÉMOIRE (les sensibles n'en ont pas en base).
  const groupes = new Map<string, { id: string; fait: FaitExtrait }[]>();
  for (const ligne of enAttente) {
    const fait = faits[rangDe(ligne.id)];
    if (!fait || fait.sujetRef !== ligne.sujetRef || fait.attribut === undefined) continue;
    const cle = `${ligne.sujetType}|${ligne.sujetRef}`;
    groupes.set(cle, [...(groupes.get(cle) ?? []), { id: ligne.id, fait }]);
  }

  for (const groupe of groupes.values()) {
    const { sujetType, role } = groupe[0].fait;
    const choix = await choisirLeSujet(pieceId, nature, sujetType, role, groupe.map((g) => g.fait), coffre);
    if (choix.sujetId === null) {
      bilan.sansSujet += groupe.length;
      await prisma.faitPropose.updateMany({ where: { id: { in: groupe.map((g) => g.id) } }, data: { raisonDecision: choix.raison } });
      continue;
    }
    const sujetId = choix.sujetId;
    await prisma.faitPropose.updateMany({ where: { id: { in: groupe.map((g) => g.id) } }, data: { sujetId } });
    // La pièce apparaît sur la fiche de son sujet (« passeport de », « devis de »).
    if (sujetType !== "PRODUIT") {
      await prisma.pieceLien.createMany({ data: [{ pieceId, sujetType, sujetId, role: nature.toLowerCase() }], skipDuplicates: true });
    }
    for (const { id, fait } of groupe) await deciderUnFait(id, fait, { pieceId, nature, sujetType, sujetId, coffre, maintenant, raisonSujet: choix.raison }, bilan);
  }
}

async function choisirLeSujet(
  pieceId: string, nature: NaturePiece, sujetType: TypeSujetFait, role: FaitExtrait["role"], faits: FaitExtrait[], coffre: PorteCoffre,
): Promise<ChoixSujet> {
  if (sujetType === "PRODUIT") return { sujetId: null, ambigu: false, raison: "Le rattachement au catalogue des produits n'est pas encore branché." };

  if (sujetType === "ORGANISATION") {
    const lus = faits.map((f) => ({ attribut: f.attribut, valeurNormalisee: f.valeurNormalisee }));
    const candidats = await candidatsOrganisations(lus);
    if (candidats.length === 0) return { sujetId: null, ambigu: false, raison: "Aucune organisation du référentiel ne porte ces identifiants : les faits restent proposés, sans fiche." };
    const compactes = faits.map((f) => (ATTRIBUT_PAR_CLE.get(f.attribut)?.identifiant ? { ...f, valeurNormalisee: compacterIdentifiant(f.valeurNormalisee) } : f));
    return choisirSujet({ contexte: [], parIdentifiant: resoudreSujet(compactes, candidats) });
  }

  // PERSONNE : le contexte (les fiches où la pièce est déposée), puis les identifiants au coffre.
  const contexte: string[] = [];
  if (sujetEstLePorteur(nature, role)) {
    const liens = await prisma.pieceLien.findMany({ where: { pieceId }, select: { sujetType: true, sujetId: true, entityType: true } });
    for (const p of await porteursDesLiens(liens)) {
      const id = await personneDuPorteur(p.type, p.id);
      if (id) contexte.push(id);
    }
  }
  const empreinteDe = (attribut: string, valeur: string): string => {
    const n = natureCoffreDe(attribut, valeur);
    return (n && coffre.empreinteDe(n, valeur)) ?? `illisible:${attribut}`;
  };
  const trouves = new Set<string>();
  for (const f of faits) {
    if (!(IDENTIFIANTS_SENSIBLES_PERSONNE as readonly string[]).includes(f.attribut) || !f.valeurNormalisee.trim()) continue;
    for (const id of await personnesParEmpreinte(NATURES_IDENTIFIANTS[f.attribut], empreinteDe(f.attribut, f.valeurNormalisee))) trouves.add(id);
  }
  const ids = [...new Set([...contexte, ...trouves])];
  let parIdentifiant: ResolutionSujet | null = null;
  if (ids.length) parIdentifiant = resoudreSujet(faits, await candidatsPersonnes(ids, NATURES_IDENTIFIANTS), { empreinte: empreinteDe });
  return choisirSujet({ contexte, parIdentifiant });
}

interface ContexteFait {
  pieceId: string;
  nature: NaturePiece;
  sujetType: TypeSujetFait;
  sujetId: string;
  coffre: PorteCoffre;
  maintenant: Date;
  raisonSujet: string;
}

async function deciderUnFait(faitId: string, fait: FaitExtrait, c: ContexteFait, bilan: BilanTache): Promise<void> {
  const attribut = ATTRIBUT_PAR_CLE.get(fait.attribut);
  const decider = (decision: "IGNORE" | "COFFRE", raison: string, donneeSensibleId?: string) =>
    prisma.faitPropose.update({ where: { id: faitId }, data: { decision, raisonDecision: raison, decideeLe: c.maintenant, ...(donneeSensibleId ? { donneeSensibleId } : {}) } });
  if (!attribut) {
    bilan.ignores += 1;
    await decider("IGNORE", `Attribut hors catalogue : ${fait.attribut}.`);
    return;
  }

  const [confirmes, proposes] = await Promise.all([
    prisma.faitConfirme.findMany({ where: { sujetType: c.sujetType, sujetId: c.sujetId, attribut: fait.attribut, actif: true }, select: { valeurNormalisee: true, source: true, confirmeLe: true } }),
    prisma.faitPropose.findMany({ where: { sujetType: c.sujetType, sujetId: c.sujetId, attribut: fait.attribut, decision: "EN_ATTENTE", id: { not: faitId } }, select: { valeurNormalisee: true } }),
  ]);
  const d = deciderFait(fait, {
    nature: c.nature,
    attribut,
    valeursActuelles: [
      ...confirmes.map((v) => ({ valeurNormalisee: v.valeurNormalisee ?? "", source: v.source === "PIECE" ? "pièce confirmée" : v.source === "SAISIE" ? "saisie" : "import", confirmeLe: v.confirmeLe })),
      ...proposes.map((v) => ({ valeurNormalisee: v.valeurNormalisee ?? "", source: "autre pièce, à confirmer", confirmeLe: null })),
    ],
  });

  switch (d.decision) {
    case "CONFIRMER_D_OFFICE": {
      const r = await confirmerFaitPropose(faitId, { parId: null, decision: "CONFIRME_D_OFFICE", raison: d.raison, maintenant: c.maintenant });
      if (r.ok) bilan.confirmesDOffice += 1;
      return;
    }
    case "A_CONFIRMER":
      bilan.aConfirmer += 1;
      await prisma.faitPropose.update({ where: { id: faitId }, data: { raisonDecision: `${d.raison} ${c.raisonSujet}`.trim() } });
      return;
    case "CONFLIT":
      bilan.conflits += 1;
      await ouvrirConflit(faitId, { valeurActuelle: d.valeurActuelle, raison: d.raison, maintenant: c.maintenant });
      return;
    case "COFFRE": {
      const natureCoffre = natureCoffreDe(fait.attribut, fait.valeurNormalisee);
      const titulaire = c.sujetType === "PERSONNE" ? { genre: "PERSONNE" as const, personneId: c.sujetId } : c.sujetType === "ORGANISATION" ? { genre: "ORGANISATION" as const, organisationId: c.sujetId } : null;
      if (!natureCoffre || !titulaire) {
        bilan.ignores += 1;
        await decider("IGNORE", `${attribut.libelle} : aucune place au coffre pour cette donnée — rien n'est gardé.`);
        return;
      }
      const depot = await c.coffre.deposer({
        titulaire, nature: natureCoffre, valeur: fait.valeurNormalisee || fait.valeur, deposeParId: null, pieceSourceId: c.pieceId,
      });
      if (!depot.ok) {
        bilan.ignores += 1;
        await decider("IGNORE", `${attribut.libelle} illisible pour le coffre (${depot.erreur}) — rien n'est gardé.`);
        return;
      }
      bilan.auCoffre += 1;
      await decider("COFFRE", `${d.raison} ${depot.dejaPresente ? "Déjà au coffre" : "Rangée au coffre"} : ${depot.masque}.`, depot.id);
      return;
    }
    case "IGNORER":
      bilan.ignores += 1;
      await decider("IGNORE", d.raison);
      return;
  }
}
