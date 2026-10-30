/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PORTS DU LIVE OFFICE — ce que le domaine `artifact/` DEMANDE, sans savoir qui le fournit.
 *
 * Même dessein que `missions/ports.ts`, et pour la même raison : ce module manipule des
 * documents, il ne doit pas connaître le Drive, ni le chiffrement, ni le stockage objet, ni les
 * autorisations. Un adaptateur qui saurait écrire dans le Drive serait un adaptateur capable
 * d'écrire SANS passer par les droits — et §74 l'interdit.
 *
 * Le composeur (`src/platform/ia/artifact/`) remplit ces ports avec le vrai Drive, en
 * vérifiant les droits AVANT de rendre le moindre octet. C'est le seul endroit où les deux se
 * rencontrent, et il est visible.
 */

import type { ArtifactFormat } from "@/lib/artifact/object-model/model";

/** Ce qu'on sait d'un fichier avant de l'ouvrir. */
export interface FicheDocument {
  nodeId: string;
  nom: string;
  mime: string | null;
  taille: number;
  /** Numéro de la version courante — c'est elle qu'on ouvre, et sur elle qu'on rejoue. */
  version: number;
  format: ArtifactFormat | null;
}

export interface VersionEcrite {
  version: number;
  taille: number;
}

/**
 * L'ACCÈS AUX DOCUMENTS. Toute méthode reçoit l'identifiant de la PERSONNE : la vérification
 * des droits appartient à l'implémentation, pas à l'appelant, pour qu'on ne puisse pas l'oublier.
 */
export interface PortDocuments {
  /** La fiche d'un document, ou `null` si la personne n'y a pas droit / il n'existe pas. */
  decrire(userId: string, nodeId: string): Promise<FicheDocument | null>;
  /** Les octets d'une version précise. `null` = pas de droit, ou version absente. */
  lire(userId: string, nodeId: string, version: number): Promise<Buffer | null>;
  /**
   * Écrit une NOUVELLE version. Ne remplace jamais : le Drive est un historique, et §21 exige
   * que la version précédente reste ouvrable.
   */
  ecrireVersion(
    userId: string,
    nodeId: string,
    octets: Buffer,
    opts: {
      mime: string;
      resume: string;
      /**
       * La pièce Legal dont ce fichier EST le fichier — posée par le code serveur seul (révision
       * DÉLÉGUÉE d'une pièce de la fabrique, §118.152), jamais par une entrée de modèle. L'écriture
       * n'exige alors pas le droit d'écrire dans le Drive de celui qui a émis la pièce : c'est la
       * pièce qui se révise, sous la délégation que l'appelant a vérifiée — et seulement SON fichier.
       */
      piece?: string;
    },
  ): Promise<VersionEcrite>;
  /** Crée un NOUVEAU fichier (« enregistrer sous », §23). Rend son identifiant Drive. */
  creerFichier(
    userId: string,
    opts: { nom: string; octets: Buffer; mime: string; dossier?: string },
  ): Promise<{ nodeId: string; version: number }>;
  /** Cherche un document par son nom — « affiche-moi le Word Contrat Consulting Mouffok ». */
  chercher(userId: string, requete: string, limite: number): Promise<FicheDocument[]>;
}

/** Le journal d'audit. Une modification de document est une écriture : elle se trace (§76). */
export interface PortAudit {
  tracer(opts: {
    userId: string;
    action: string;
    cible: string;
    detail: string;
  }): Promise<void>;
}

/**
 * CE QU'UNE IMAGE PORTE, une fois lue. Le TEXTE et la NOTE voyagent ensemble, toujours : ce qui
 * vient d'un OCR ou d'un modèle n'est jamais un fait vérifié, et une lecture livrée sans sa
 * méthode ni sa confiance sera citée comme une certitude (§29, calibration).
 */
export interface LectureImage {
  texte: string;
  /** Méthode, confiance, durée — la phrase qui accompagne le texte jusqu'au modèle. */
  note: string | null;
}

/**
 * LA LECTURE D'UNE IMAGE. `artifact/` sort les octets ; il ne sait pas ce qu'ils montrent.
 *
 * Ce port existe pour que le domaine n'importe NI l'OCR, NI le modèle vision, NI le réseau —
 * exactement la raison qui a fait sortir le Drive du domaine. Le composeur le remplit avec le
 * repli multimodal DÉJÀ en place (§38 : parser → OCR ciblé → modèle rapide), qu'on ne récrit pas.
 */
export interface PortVision {
  lire(userId: string, octets: Buffer, nom: string): Promise<LectureImage>;
}

export interface PortsArtefact {
  documents: PortDocuments;
  audit: PortAudit;
  /**
   * Facultatif : un composeur qui ne branche pas la vision fait dire au moteur que la lecture
   * d'image n'est pas disponible ICI — pas qu'elle a échoué, et surtout pas qu'elle a réussi.
   */
  vision?: PortVision;
}
