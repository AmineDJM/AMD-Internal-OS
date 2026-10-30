/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CONVERSIONS DE L'ATELIER (J3, décision 0017) — Word → PDF, PowerPoint → PDF, Excel → PDF,
 * tableau → Excel, PDF → Word. Et l'écran dit TOUJOURS par quelle voie.
 *
 * La composition : la source se lit À TRAVERS LE PORT (droits de la personne), les octets se produisent par la
 * bibliothèque `lib/office/conversions-atelier.ts` (voies WORKER / EDITEUR / LOCAL / RENDU / MAISON, et la file), le
 * résultat est un NOUVEAU fichier du Drive de la personne (dossier « Atelier »), déposé par le port — qui l'inscrit
 * à la Bibliothèque. L'original n'est jamais touché. On convertit la DERNIÈRE VERSION ENREGISTRÉE.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import {
  choisirVoie, conversionsPossibles, fileConversions, LIBELLE_VOIE, libreOfficeLocal, MIME_CONVERSION, nomSans, produire,
  type VersFormat, type Voie,
} from "@/lib/office/conversions-atelier";
import type { Personne } from "@/platform/ia/artifact/office";
import { droitsSurDocument, portsArtefact } from "@/platform/ia/artifact/ports";

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
export async function demanderConversion(user: Personne, nodeId: string, vers: VersFormat, sessionId: string | null = null): Promise<DemandeConversion> {
  const rien = { id: null, voie: null, etat: null, resultat: null, note: null };
  const droits = await droitsSurDocument(user.id, nodeId);
  if (!droits.voir) return { ok: false, motif: "Ce document n'existe pas, ou vous n'y avez pas accès.", ...rien };
  const fiche = await portsArtefact.documents.decrire(user.id, nodeId);
  if (!fiche?.format) return { ok: false, motif: "Ce fichier n'est ni un Word, ni un PowerPoint, ni un Excel, ni un PDF.", ...rien };
  const choix = await choisirVoie(fiche.format, vers);
  if ("refus" in choix) return { ok: false, motif: `Conversion impossible : ${choix.refus}.`, ...rien };
  const ligne = await fileConversions.creer({ userId: user.id, nodeId, version: fiche.version, sessionId, vers, voie: choix.voie });
  if (choix.voie === "WORKER") {
    return { ok: true, motif: null, id: ligne.id, voie: "WORKER", etat: "EN_FILE", resultat: null, note: "en file : le worker la prend à son prochain passage (une minute au plus)" };
  }
  return executer(ligne.id, user.id, { nodeId, version: fiche.version, format: fiche.format, nom: fiche.nom }, vers, choix.voie);
}

async function executer(id: string, userId: string, src: Source, vers: VersFormat, voie: Voie): Promise<DemandeConversion> {
  try {
    const octets = await portsArtefact.documents.lire(userId, src.nodeId, src.version);
    if (!octets) throw new Error("la source n'est plus accessible");
    const r = await produire(userId, src, octets, vers, voie);
    const nom = `${nomSans(src.nom)}.${vers.toLowerCase()}`;
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
export async function traiterConversionsEnFile(opts: { executeur: string; max?: number }): Promise<{ faites: number; echecs: number }> {
  const bilan = { faites: 0, echecs: 0 };
  if (opts.executeur !== "worker") return bilan;
  for (const c of await fileConversions.enFile(opts.max ?? 5)) {
    if (!(await fileConversions.prendre(c.id))) continue;
    const fiche = await portsArtefact.documents.decrire(c.userId, c.nodeId);
    if (!fiche?.format) {
      await fileConversions.echouee(c.id, "la source n'est plus accessible");
      bilan.echecs += 1;
      continue;
    }
    const r = await executer(c.id, c.userId, { nodeId: c.nodeId, version: c.version, format: fiche.format, nom: fiche.nom }, c.vers as VersFormat, "WORKER");
    if (r.ok) bilan.faites += 1; else bilan.echecs += 1;
  }
  await fileConversions.expirer();
  return bilan;
}

/** Les conversions récentes de la personne (l'écran les montre sous l'Atelier). */
export const conversionsRecentes = (userId: string) => fileConversions.recentes(userId);
