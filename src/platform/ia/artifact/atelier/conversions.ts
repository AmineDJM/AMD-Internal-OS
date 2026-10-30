/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CONVERSIONS DE L'ATELIER (J3, décision 0017 ; haute fidélité : décision 0019) — Word/PowerPoint/Excel → PDF,
 * tableau → Excel, PDF → Word (mise en page, images, tableaux, arabe, OCR des scans), PDF → Excel, image → PDF/Word,
 * PowerPoint → images. Et l'écran dit TOUJOURS par quelle voie.
 *
 * La composition : la source se lit À TRAVERS LE PORT (droits de la personne), les octets se produisent par la
 * bibliothèque `lib/office/conversions-atelier.ts` (voies WORKER / EDITEUR / LOCAL / RENDU / MAISON, et la file), le
 * résultat est un NOUVEAU fichier du Drive de la personne (dossier « Atelier »), déposé par le port — qui l'inscrit
 * à la Bibliothèque. L'original n'est jamais touché. On convertit la DERNIÈRE VERSION ENREGISTRÉE.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import {
  choisirVoie, conversionsPossibles, EXT_CONVERSION, fileConversions, formatSource, LIBELLE_VOIE, libreOfficeLocal, MIME_CONVERSION, nomSans, produire,
  type LecteurVision, type VersFormat, type Voie,
} from "@/lib/office/conversions-atelier";
import type { Personne } from "@/platform/ia/artifact/office";
import { droitsSurDocument, gardeOcrVision, portsArtefact } from "@/platform/ia/artifact/ports";

/**
 * L'OCR VISION, FOURNI PAR L'APPELANT (décision 0019, suite) : le socle ne connaît pas le modèle. Une fabrique
 * « au nom de qui » (le journal et le budget sont ceux du demandeur) ; le socle, lui, passe la GARDE de confidentialité
 * avant de s'en servir — une pièce confidentielle, du coffre ou d'un dossier RH ne part jamais.
 */
export type FabriqueVision = (userId: string) => LecteurVision;

export type { VersFormat, Voie };
export { choisirVoie, conversionsPossibles, LIBELLE_VOIE, libreOfficeLocal };
export const DOSSIER_ATELIER = "Atelier";

export interface DemandeConversion {
  ok: boolean;
  motif: string | null;
  id: string | null;
  voie: Voie | null;
  etat: "EN_FILE" | "FAITE" | "ECHEC" | null;
  resultat: { nodeId: string; nom: string } | null;
  note: string | null;
}

interface Source { nodeId: string; version: number; format: string; nom: string }

/**
 * DEMANDE une conversion de la dernière version ENREGISTRÉE d'un fichier. Droits relus : il faut pouvoir LIRE
 * la source (le résultat atterrit dans le Drive de la personne, l'original n'est pas touché).
 */
export async function demanderConversion(user: Personne, nodeId: string, vers: VersFormat, sessionId: string | null = null, deps: { vision?: FabriqueVision } = {}): Promise<DemandeConversion> {
  const rien = { id: null, voie: null, etat: null, resultat: null, note: null };
  const droits = await droitsSurDocument(user.id, nodeId);
  if (!droits.voir) return { ok: false, motif: "Ce document n'existe pas, ou vous n'y avez pas accès.", ...rien };
  const fiche = await portsArtefact.documents.decrire(user.id, nodeId);
  const format = fiche ? formatSource(fiche.format, fiche.nom, fiche.mime) : null;
  if (!fiche || !format) return { ok: false, motif: "Ce fichier n'est ni un Word, ni un PowerPoint, ni un Excel, ni un PDF, ni une image.", ...rien };
  const choix = await choisirVoie(format, vers);
  if ("refus" in choix) return { ok: false, motif: `Conversion impossible : ${choix.refus}.`, ...rien };
  const ligne = await fileConversions.creer({ userId: user.id, nodeId, version: fiche.version, sessionId, vers, voie: choix.voie });
  if (choix.voie === "WORKER") {
    return { ok: true, motif: null, id: ligne.id, voie: "WORKER", etat: "EN_FILE", resultat: null, note: "en file : le worker la prend à son prochain passage (une minute au plus)" };
  }
  return executer(ligne.id, user.id, { nodeId, version: fiche.version, format, nom: fiche.nom }, vers, choix.voie, deps.vision);
}

async function executer(id: string, userId: string, src: Source, vers: VersFormat, voie: Voie, fabrique?: FabriqueVision): Promise<DemandeConversion> {
  try {
    const octets = await portsArtefact.documents.lire(userId, src.nodeId, src.version);
    if (!octets) throw new Error("la source n'est plus accessible");
    // La garde AVANT le lecteur : refusée, la voie locale reste seule et l'écran dit pourquoi.
    let vision: LecteurVision | undefined;
    let refusVision: string | null = null;
    if (fabrique && (src.format === "PDF" || src.format === "IMAGE")) {
      refusVision = await gardeOcrVision(src.nodeId, src.version, src.nom);
      if (!refusVision) vision = fabrique(userId);
    }
    const r = await produire(userId, src, octets, vers, voie, vision);
    if (refusVision && r.note && /OCR|scann/i.test(r.note)) r.note = `${r.note} ; OCR vision non utilisé : ${refusVision}`;
    const nom = `${nomSans(src.nom)}${vers === "IMAGES" ? " (diapositives)" : ""}.${EXT_CONVERSION[vers]}`;
    const cree = await portsArtefact.documents.creerFichier(userId, { nom, octets: r.octets, mime: MIME_CONVERSION[vers], dossier: DOSSIER_ATELIER });
    await fileConversions.reussie(id, cree.nodeId, nom, r.note);
    return { ok: true, motif: null, id, voie, etat: "FAITE", resultat: { nodeId: cree.nodeId, nom }, note: r.note };
  } catch (e) {
    const erreur = (e as Error).message.slice(0, 500);
    await fileConversions.echouee(id, erreur);
    return { ok: false, motif: `La conversion (${LIBELLE_VOIE[voie]}) a échoué : ${erreur}`, id, voie, etat: "ECHEC", resultat: null, note: null };
  }
}

/**
 * LE PASSAGE DU WORKER (`atelier.conversions`) : il prend les demandes en file, une à une, sous réclamation
 * atomique. Ailleurs que sur le worker, il ne fait rien — c'est LibreOffice de l'image qui fait la différence.
 */
export async function traiterConversionsEnFile(opts: { executeur: string; max?: number; vision?: FabriqueVision }): Promise<{ faites: number; echecs: number }> {
  const bilan = { faites: 0, echecs: 0 };
  if (opts.executeur !== "worker") return bilan;
  for (const c of await fileConversions.enFile(opts.max ?? 5)) {
    if (!(await fileConversions.prendre(c.id))) continue;
    const fiche = await portsArtefact.documents.decrire(c.userId, c.nodeId);
    const format = fiche ? formatSource(fiche.format, fiche.nom, fiche.mime) : null;
    if (!fiche || !format) {
      await fileConversions.echouee(c.id, "la source n'est plus accessible");
      bilan.echecs += 1;
      continue;
    }
    const r = await executer(c.id, c.userId, { nodeId: c.nodeId, version: c.version, format, nom: fiche.nom }, c.vers as VersFormat, "WORKER", opts.vision);
    if (r.ok) bilan.faites += 1; else bilan.echecs += 1;
  }
  await fileConversions.expirer();
  return bilan;
}

/** Fait échouer (en le disant) les demandes que le worker n'a pas prises à temps — le web le fait aussi. */
export const expirerConversionsEnFile = () => fileConversions.expirer();

/** Les conversions récentes de la personne (l'écran les montre sous l'Atelier). */
export const conversionsRecentes = (userId: string) => fileConversions.recentes(userId);
