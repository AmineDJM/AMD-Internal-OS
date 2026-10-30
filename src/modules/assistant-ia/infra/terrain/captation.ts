import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { modeleSttTerrain } from "@/platform/ia/modeles-roles";
import { auNomDe } from "../consommation";
import { genererTexte } from "../generer";
import { deposerAudio, NOM_DOSSIER_TERRAIN } from "../lecture/voix";
import { transcrireMedia } from "../lecture/pieces";
import { preparerCarte, type CartePreparee } from "../operations";
import type { VueCaptation } from "../../domaine/terrain/vue";
import { candidatsMedecins, produitsDuDelegue } from "../operations/terrain";
import { censurerTexte } from "../../domaine/filtre-confidentialite";
import { nomAnnonceLeCoffre } from "../../domaine/lecture/regles";
import {
  CONSIGNE_STRUCTURATION, extraireObjetJson, phraseErreurFournisseur, indiceVocabulaire, langueDictee, lireCompteRendu, type CompteRenduStructure, type LangueDictee,
} from "../../domaine/terrain/compte-rendu";
import { CONSIGNE_PHOTO, lireLecturePhoto, SORTES_PHOTO, type LecturePhoto, type SortePhoto } from "../../domaine/terrain/photo";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CAPTATION DE TERRAIN (lot J13, décision 0025) — un vocal ou une photo arrivent du téléphone ; en ressortent des
 * CARTES. Rien de métier n'est écrit ici : le compte rendu, la demande d'échantillons, la tournée de demain, la pièce
 * rattachée attendent chacun le clic du délégué (`confirmerCarteTerrain`).
 *
 *   vocal  → Drive (dossier « Terrain — vocaux et photos ») → transcription (`gpt-transcribe`, langue détectée, indice
 *            du panel et de la gamme) → structuration (le modèle de l'assistant, JSON relu par `lireCompteRendu`) →
 *            médecin résolu dans l'annuaire du délégué → cartes.
 *   photo  → Drive → vision (consigne du terrain : jamais de donnée patient, jamais de RIB) → faits proposés, filtrés →
 *            carte « rattacher au compte rendu ».
 *
 * IDEMPOTENTE : `cle` vient du téléphone (file hors ligne) ; un renvoi rend la captation déjà faite, sans rien rejouer
 * ni repayer. Mesurée : `msTotal`, du dépôt aux cartes — la cible du lot est 30 s.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */


/** Le terrain s'ouvre avec les rapports terrain — pas besoin de l'Assistant IA pour dicter un compte rendu. Jamais en « Vue exacte ». */
export const peutCapterTerrain = (u: CurrentUser): boolean => userCan(u, "FIELD_REPORTS", "VIEW") && !u.impersonatedBy && !u.visualise;

export const TAILLE_MAX_CAPTATION = 25 * 1024 * 1024;
export const DELAI_STRUCTURATION_MS = 25_000;

let fetchDeTest: typeof fetch | null = null;
/** RÉSERVÉ AUX TESTS — le moteur de transcription remplacé (aucun réseau). */
export function remplacerFetchTerrainPourTests(f: typeof fetch | null): void {
  fetchDeTest = f;
}

interface Analyse { compteRendu?: CompteRenduStructure | null; photo?: LecturePhoto | null; notes?: string[] }

function vue(c: {
  id: string; cle: string; sorte: string; etat: string; nom: string; transcription: string | null; langue: string | null;
  analyse: unknown; cartes: unknown; erreur: string | null; msTotal: number | null; createdAt: Date;
}): VueCaptation {
  const a = (c.analyse ?? {}) as Analyse;
  return {
    id: c.id, cle: c.cle, sorte: c.sorte === "PHOTO" ? "PHOTO" : "VOCAL", etat: c.etat === "PRET" ? "PRET" : c.etat === "ECHEC" ? "ECHEC" : "RECU",
    nom: c.nom, transcription: c.transcription, langue: (c.langue as LangueDictee | null) ?? null,
    compteRendu: a.compteRendu ?? null, photo: a.photo ?? null, notes: a.notes ?? [],
    cartes: Array.isArray(c.cartes) ? (c.cartes as CartePreparee[]) : [],
    erreur: c.erreur, msTotal: c.msTotal, creeLe: c.createdAt.toISOString(),
  };
}

const SELECT = {
  id: true, cle: true, sorte: true, etat: true, nom: true, transcription: true, langue: true, analyse: true, cartes: true,
  erreur: true, msTotal: true, createdAt: true,
} as const;

export async function lireCaptations(user: CurrentUser, take = 20): Promise<VueCaptation[]> {
  const cs = (await prisma.assistantIaTerrainCapture.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take, select: SELECT })).map(vue);
  // L'état de chaque carte, relu : une carte confirmée ne se représente pas comme à confirmer.
  const ids = cs.flatMap((c) => c.cartes.map((k) => k.intentId));
  const etats = new Map((ids.length ? await prisma.assistantActionIntent.findMany({
    where: { id: { in: ids }, userId: user.id }, select: { id: true, status: true, resultMessage: true, resultLink: true },
  }) : []).map((i) => [i.id, i]));
  const STATUTS = ["PROPOSED", "CONFIRMED", "EXECUTING", "EXECUTED", "CANCELLED"] as const;
  return cs.map((c) => ({
    ...c,
    cartes: c.cartes.map((k) => {
      const i = etats.get(k.intentId);
      const statut = STATUTS.find((s) => s === i?.status) ?? (i ? "CANCELLED" : "PROPOSED");
      return { ...k, statut, resultat: i ? { message: i.resultMessage, lien: i.resultLink } : undefined };
    }),
  }));
}

export type { VueCaptation };
export type EntreeCaptation = { cle: string; octets: Buffer; nom: string; mime: string; dureeS?: number | null; sorte?: SortePhoto | null };
export type IssueCaptation = { ok: true; captation: VueCaptation; deja: boolean } | { ok: false; erreur: string; definitif: boolean };

/** La porte commune : clé, taille, coffre, idempotence. Rend la captation existante, ou la ligne neuve. */
async function ouvrir(user: CurrentUser, sorte: "VOCAL" | "PHOTO", e: EntreeCaptation): Promise<IssueCaptation | { id: string; t0: number }> {
  const cle = (e.cle ?? "").trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(cle)) return { ok: false, erreur: "Clé de captation invalide.", definitif: true };
  const existante = await prisma.assistantIaTerrainCapture.findUnique({ where: { userId_cle: { userId: user.id, cle } }, select: SELECT });
  if (existante) return { ok: true, captation: vue(existante), deja: true };
  if (!e.octets.length) return { ok: false, erreur: "Fichier vide.", definitif: true };
  if (e.octets.length > TAILLE_MAX_CAPTATION) return { ok: false, erreur: "Fichier trop lourd (25 Mo au plus).", definitif: true };
  if (nomAnnonceLeCoffre(e.nom)) return { ok: false, erreur: "Ce nom annonce une pièce protégée (passeport, RIB, bulletin de paie) : elle n'est pas lue par l'assistant.", definitif: true };
  try {
    const c = await prisma.assistantIaTerrainCapture.create({
      data: { userId: user.id, cle, sorte, nom: e.nom.slice(0, 200), mime: e.mime.slice(0, 100), taille: e.octets.length, dureeS: e.dureeS ?? null },
      select: { id: true },
    });
    return { id: c.id, t0: Date.now() };
  } catch {
    // Deux envois simultanés de la même clé : le second retrouve le premier.
    const deja = await prisma.assistantIaTerrainCapture.findUnique({ where: { userId_cle: { userId: user.id, cle } }, select: SELECT });
    return deja ? { ok: true, captation: vue(deja), deja: true } : { ok: false, erreur: "Captation impossible.", definitif: false };
  }
}

async function finir(id: string, data: Record<string, unknown>): Promise<VueCaptation> {
  return vue(await prisma.assistantIaTerrainCapture.update({ where: { id }, data, select: SELECT }));
}

/** Les cartes d'un compte rendu structuré — chaque `proposer` relit sous les droits ; un refus devient une note. */
async function cartesDuCompteRendu(user: CurrentUser, cr: CompteRenduStructure): Promise<{ cartes: CartePreparee[]; notes: string[] }> {
  const cartes: CartePreparee[] = [];
  const notes: string[] = [];
  const garder = (r: Awaited<ReturnType<typeof preparerCarte>>, quoi: string) => {
    if ("carte" in r) cartes.push(r.carte);
    else if ("manque" in r) notes.push(`${quoi} : à préciser — ${r.manque[0]}.`);
    else notes.push(`${quoi} : ${r.erreur}`);
  };
  garder(await preparerCarte(user, "terrain_compte_rendu", {
    medecin: cr.medecin, etablissement: cr.etablissement, specialite: cr.specialite, produits: cr.produits,
    synthese: cr.synthese, aConfirmer: cr.aConfirmer,
  }), "Compte rendu");
  for (const d of cr.demandes.filter((x) => x.nature === "ECHANTILLONS" || x.nature === "MATERIEL")) {
    garder(await preparerCarte(user, "terrain_demande_materiel", {
      produit: d.produit ?? cr.produits[0] ?? null, quantite: d.quantite,
      note: [d.detail, cr.medecin ? `pour ${cr.medecin}` : null, cr.etablissement].filter(Boolean).join(" — "),
    }), `Demande « ${d.detail} »`);
  }
  for (const d of cr.demandes.filter((x) => x.nature === "DOCUMENTATION" || x.nature === "AUTRE")) notes.push(`Demande notée au compte rendu : ${d.detail}.`);
  if (cr.revoirDemain) garder(await preparerCarte(user, "terrain_tournee_demain", { medecin: cr.medecin, etablissement: cr.etablissement }), "Tournée de demain");
  return { cartes, notes };
}

/**
 * Le tronc commun : la porte (`ouvrir`), le dépôt au Drive sous le nom de la personne, le fichier posé sur la captation
 * AVANT la suite (« rattacher » relit la photo par sa captation) — puis la suite propre au vocal ou à la photo.
 */
async function capter(
  user: CurrentUser, sorte: "VOCAL" | "PHOTO", e: EntreeCaptation,
  suite: (o: { id: string; t0: number }) => Promise<IssueCaptation>,
): Promise<IssueCaptation> {
  const o = await ouvrir(user, sorte, e);
  if ("ok" in o) return o;
  return auNomDe(user.id, async () => {
    const depot = await deposerAudio(user, e.octets, e.nom, e.mime, NOM_DOSSIER_TERRAIN);
    if ("erreur" in depot) return { ok: true, deja: false, captation: await finir(o.id, { etat: "ECHEC", erreur: depot.erreur }) };
    await prisma.assistantIaTerrainCapture.update({ where: { id: o.id }, data: { blobId: depot.blobId } });
    return suite(o);
  });
}

/** UN VOCAL DE TERRAIN → transcription → compte rendu structuré → cartes. */
export async function capterVocal(user: CurrentUser, e: EntreeCaptation): Promise<IssueCaptation> {
  return capter(user, "VOCAL", e, async (o) => {
    const [medecins, produits] = await Promise.all([candidatsMedecins(user, 400), produitsDuDelegue(user.id)]);
    const indice = indiceVocabulaire(medecins.map((m) => m.nom), produits.map((p) => p.nom), [...new Set(medecins.map((m) => m.etablissement).filter((x): x is string => !!x))]);
    const tr = await transcrireMedia(e.octets, e.nom, { langue: "auto", modele: modeleSttTerrain(), indice, ...(fetchDeTest ? { fetchImpl: fetchDeTest } : {}) });
    if (!tr.ok || !tr.valeur.texte.trim()) {
      if (!tr.ok) console.warn("[terrain] transcription", tr.raison.slice(0, 300));
      const erreur = tr.ok ? "Aucune parole reconnue dans ce vocal — réenregistrez-le, ou écrivez le compte rendu." : phraseErreurFournisseur(tr.raison, "transcription");
      return { ok: true, deja: false, captation: await finir(o.id, { etat: "ECHEC", erreur, msTotal: Date.now() - o.t0 }) };
    }
    const transcription = tr.valeur.texte.trim();
    const langue = langueDictee(transcription, tr.valeur.langue);
    // Le filtre de confidentialité AVANT le modèle : un IBAN dicté ne part pas.
    const pourModele = censurerTexte(transcription).texte;
    const g = await genererTexte(CONSIGNE_STRUCTURATION, pourModele, DELAI_STRUCTURATION_MS, { role: "standard" });
    const cr = g.ok ? lireCompteRendu(g.texte) : null;
    // Le modèle n'a pas rendu de compte rendu lisible : la transcription brute devient la synthèse — dit sur la carte.
    const structure: CompteRenduStructure = cr ?? {
      medecin: null, etablissement: null, specialite: null, produits: [], interet: null, objections: null, demandes: [], revoirDemain: false,
      synthese: transcription.slice(0, 1_500), aConfirmer: [g.ok ? "structuration illisible : synthèse = transcription brute" : "structuration indisponible : synthèse = transcription brute"],
    };
    const { cartes, notes } = await cartesDuCompteRendu(user, structure);
    return {
      ok: true, deja: false,
      captation: await finir(o.id, {
        etat: "PRET", transcription, langue, modeleStt: tr.valeur.modele,
        analyse: { compteRendu: structure, notes } as object, cartes: cartes as object, msTotal: Date.now() - o.t0,
      }),
    };
  });
}

/** UNE PHOTO DE TERRAIN → vision → faits proposés → carte « rattacher au compte rendu ». */
export async function capterPhoto(user: CurrentUser, e: EntreeCaptation): Promise<IssueCaptation> {
  if (!/^image\/(png|jpe?g|webp|gif)$/i.test(e.mime)) return { ok: false, erreur: "Photo attendue (JPEG, PNG, WebP).", definitif: true };
  return capter(user, "PHOTO", e, async (o) => {
    const sorte = e.sorte && (SORTES_PHOTO as readonly string[]).includes(e.sorte) ? e.sorte : null;
    const g = await genererTexte(CONSIGNE_PHOTO, sorte ? `Photo annoncée comme : ${sorte}.` : "Photo de terrain.", DELAI_STRUCTURATION_MS, {
      images: [{ octets: e.octets, mime: e.mime, legende: e.nom }], origine: "vision",
    });
    // Le filtre de confidentialité sur ce que la vision a lu (un RIB sur une facture) avant tout affichage ou stockage.
    const lecture = g.ok ? lireLecturePhoto(extraireObjetJson(censurerTexte(g.texte).texte), sorte) : null;
    const notes: string[] = [];
    if (!g.ok) console.warn("[terrain] vision", g.raison.slice(0, 300));
    if (!lecture) notes.push(g.ok ? "La photo n'a pas pu être lue (réponse hors forme) : elle est gardée au Drive." : phraseErreurFournisseur(g.raison, "lecture"));
    const cartes: CartePreparee[] = [];
    const r = await preparerCarte(user, "terrain_piece_visite", { captationId: o.id });
    if ("carte" in r) cartes.push(r.carte);
    else notes.push("erreur" in r ? r.erreur : r.manque[0]);
    return {
      ok: true, deja: false,
      captation: await finir(o.id, { etat: lecture ? "PRET" : "ECHEC", analyse: { photo: lecture, notes } as object, cartes: cartes as object, msTotal: Date.now() - o.t0, ...(lecture ? {} : { erreur: notes[0] }) }),
    };
  });
}
