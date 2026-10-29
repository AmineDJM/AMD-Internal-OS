import type { PowerTool } from "@/lib/assistant/power-tools";
import { prisma, searchDrive, resolveDriveAccess, canViewDrive, getBlob, readFileByKey } from "./dependances";
import { extractAttachmentText } from "@/lib/assistant-files";
import { estMedia } from "@/platform/in-process/media";
import { indexDriveNodeText } from "@/lib/assistant/document-discovery";
import { resultatIndisponible } from "@/lib/assistant/capability-failure";
import { resultatVide } from "@/lib/assistant/empty-result";
import { fichierALire, fichiersDe } from "@/lib/assistant/artifact-ref";
import { sansBloquer } from "@/lib/journal";
import { transcriptionPersistee, noteDeMethode, EXEC, str, DOC_TEXT_CAP } from "./commun";

/**
 * OUTILS EXÉCUTIFS — Drive : chercher (`search_drive`) et LIRE une pièce (`read_document`).
 *
 * Morceau de `EXECUTIVE_TOOLS` (`../executive-tools.ts`), recomposé dans l'ordre d'origine : l'ordre
 * des outils fait partie du prompt de l'IA.
 */
export const OUTILS_DRIVE: PowerTool[] = [
  {
    def: {
      name: "search_drive",
      description:
        "Cherche un FICHIER ou un DOSSIER dans le Drive de l'entreprise par un mot du nom. Renvoie le chemin complet et le lien " +
        "de chaque résultat. À utiliser dès que l'utilisateur cherche « le contrat X », « la facture de… », « le scan de… » sans savoir où il est rangé.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string", description: "Un ou plusieurs mots du nom du fichier ou du dossier." } },
        required: ["query"],
      },
    },
    allowed: EXEC,
    label: "Drive fouillé",
    run: async (input, user) => {
      const query = str(input, "query");
      if (query.length < 2) return resultatIndisponible("MISSING_INPUT", "Donnez au moins deux caractères du nom.");
      const out = await searchDrive(user, query);
      // ZÉRO EST UN COMPTE MESURÉ, pas une phrase : c'est ce compte qui rend une absence
      // citable comme preuve par le juge d'objectif (`empty-result.ts`).
      if (out.rows.length === 0) {
        return resultatVide(`Aucun fichier ni dossier ne contient « ${query} » dans le Drive visible.`, { requete: query });
      }
      const resultats = out.rows.slice(0, 25).map((r) => ({ nom: r.name, chemin: r.path, lien: r.href, driveNodeId: r.id }));
      return JSON.stringify({ items: resultats, count: resultats.length, resultats, tronque: out.truncated });
    },
  },

  {
    def: {
      name: "read_document",
      description:
        "LIT le contenu d'un fichier — PDF, Word, Excel, PowerPoint, CSV, texte. Trois portes : `driveNodeId` (un fichier du Drive, " +
        "obtenu via search_drive), `documentId` (une pièce jointe d'un dossier, obtenue via inspect_record) ou `artifactId` (un livrable " +
        "généré, obtenu via draft_deliverable ou list_artifacts). Renvoie le texte extrait, " +
        "pour résumer, extraire un chiffre, retrouver une clause. Un scan sans OCR est signalé comme illisible — ne rien inventer.",
      input_schema: {
        type: "object",
        properties: {
          driveNodeId: { type: "string", description: "Identifiant d'un fichier du Drive." },
          documentId: { type: "string", description: "Identifiant d'une pièce jointe (table Document)." },
          artifactId: { type: "string", description: "Identifiant d'un livrable généré (`artifact_id` de draft_deliverable / list_artifacts)." },
        },
      },
    },
    allowed: EXEC,
    label: "Document lu",
    run: async (input, user) => {
      let nodeId = str(input, "driveNodeId");
      const documentId = str(input, "documentId");
      const artifactId = str(input, "artifactId");

      /**
       * ── LA TROISIÈME PORTE : L'IDENTITÉ D'UN LIVRABLE ───────────────────────────────
       *
       * `list_artifacts` publie `artifact_id` ; c'était le seul identifiant qu'elle publiait en
       * clair, et `read_document` ne l'acceptait pas. Il finissait donc dans `documentId`, ne
       * correspondait à aucune ligne `Document`, et rendait « Pièce introuvable ou sans
       * fichier » — sur un run réel, l'étape passait DONE avec cette phrase pour preuve.
       *
       * La résolution est EXACTE : un identifiant, une ligne, celle du propriétaire. Jamais un
       * rapprochement par titre — deux livrables peuvent porter le même nom, et se tromper de
       * document en annonçant qu'on l'a lu est le défaut le plus coûteux de tout ce système.
       */
      if (!nodeId && artifactId) {
        const art = await prisma.assistantArtifact.findFirst({
          where: { id: artifactId, ownerId: user.id },
          select: { title: true, files: true },
        });
        if (!art) {
          return resultatIndisponible("MISSING_DOCUMENT",
            "Livrable introuvable dans VOTRE registre (list_artifacts pour retrouver l'identifiant).",
            { artifactId });
        }
        const cible = fichierALire(fichiersDe(art.files));
        if (!cible) {
          return resultatIndisponible("MISSING_DOCUMENT",
            `Le livrable « ${art.title} » ne porte aucun fichier lisible.`, { artifactId });
        }
        nodeId = cible.nodeId;
      }

      if (nodeId) {
        // Le droit du Drive se vérifie NŒUD PAR NŒUD — être PDG n'ouvre pas un fichier privé
        // qu'aucun partage ne lui donne : le même contrôle que l'écran.
        if (!canViewDrive(await resolveDriveAccess(user, nodeId))) {
          return resultatIndisponible("MISSING_PERMISSION", "Ce fichier du Drive ne vous est pas ouvert.", { driveNodeId: nodeId });
        }
        const node = await prisma.driveNode.findUnique({ where: { id: nodeId }, select: { name: true, type: true, isTrashed: true } });
        if (!node || node.isTrashed || node.type !== "FILE") {
          return resultatIndisponible("MISSING_DOCUMENT", "Fichier introuvable dans le Drive.", { driveNodeId: nodeId });
        }
        const version = await prisma.fileVersion.findFirst({
          where: { nodeId }, orderBy: { version: "desc" }, select: { id: true, blobId: true },
        });
        const bytes = version ? await getBlob(version.blobId) : null;
        if (!bytes) {
          return resultatIndisponible("CAPABILITY_FAILURE", "Le contenu de ce fichier est indisponible.", { driveNodeId: nodeId, nom: node.name });
        }
        /**
         * ── UN AUDIO DU DRIVE PASSE PAR LE TRANSCRIPTEUR QUI SE SOUVIENT ──────────────
         *
         * Mesuré sur la campagne live (`defi-media-reunion`) : Adam a répondu JUSTE — les
         * instants et les citations correspondent au mot près à l'enregistrement — mais
         * `MediaTranscript` était VIDE et `DriveTextIndex` portait le texte horodaté. Deux
         * transcripteurs dans le même dépôt sur le même fichier, et un seul se souvient
         * (§118.5) :
         *
         *   · `transcrireMediaDrive` est IDEMPOTENT (il relit une transcription existante),
         *     persiste les SEGMENTS, le MODÈLE et la méthode ;
         *   · `extractAttachmentText` — la porte qu'un modèle emprunte naturellement — refait
         *     l'appel de parole à CHAQUE lecture, ne garde rien, et sa réserve (« ce n'est pas
         *     un fait vérifié : à citer comme PROBABLE ») meurt avec la réponse.
         *
         * Trois conséquences, toutes nommables : on paie la transcription autant de fois qu'on
         * lit ; `media_transcript chercher` — l'outil FAIT pour « où exactement en parle-t-on ? »
         * — reste aveugle à une transcription que le produit a déjà faite ; et la MÉTHODE et la
         * CONFIANCE d'une lecture de parole ne sont plus persistées, alors que c'est
         * précisément ce qui distingue un procès-verbal d'une reconnaissance vocale à 63 %
         * (§104.15, §118.63).
         *
         * On ne recopie pas la persistance ici : on APPELLE le transcripteur qui l'a déjà. Et
         * s'il échoue, on retombe sur la lecture d'octets — ajouter une capacité ne doit pas
         * retirer celle qui marchait (§118.27).
         */
        let t = estMedia(node.name) ? await transcriptionPersistee(user, nodeId, node.name) : null;
        if (!t) t = await extractAttachmentText(node.name, bytes);
        // Chaque lecture NOURRIT l'index textuel progressif : la prochaine découverte
        // (find_documents) retrouvera ce fichier par son CONTENU, même mal nommé.
        if (version) await indexDriveNodeText(nodeId, version.id, t.text ?? "", t.note ?? null, node.name);
        if (!t.text) {
          return resultatIndisponible("UNKNOWN_FORMAT",
            `« ${node.name} » n'est pas extractible (${t.note ?? "scan sans OCR ou format non textuel"}).`,
            { driveNodeId: nodeId, nom: node.name });
        }
        return JSON.stringify({
          nom: node.name, lien: `/drive/${nodeId}`, driveNodeId: nodeId,
          texte: t.text.slice(0, DOC_TEXT_CAP), tronque: t.text.length > DOC_TEXT_CAP,
          ...noteDeMethode(t.note),
        });
      }

      if (documentId) {
        const doc = await prisma.document.findUnique({
          where: { id: documentId }, select: { name: true, fileKey: true },
        });
        if (!doc?.fileKey) {
          return resultatIndisponible("MISSING_DOCUMENT", "Pièce introuvable ou sans fichier.", { documentId });
        }
        const bytes = await readFileByKey(doc.fileKey).catch(sansBloquer("executive-tools.run.readFileByKey", null));
        if (!bytes) {
          return resultatIndisponible("CAPABILITY_FAILURE", "Le fichier de cette pièce est indisponible.", { documentId, nom: doc.name });
        }
        const t = await extractAttachmentText(doc.name, bytes);
        if (!t.text) {
          return resultatIndisponible("UNKNOWN_FORMAT",
            `« ${doc.name} » n'est pas extractible (${t.note ?? "scan sans OCR ou format non textuel"}).`,
            { documentId, nom: doc.name });
        }
        return JSON.stringify({
          nom: doc.name, documentId,
          texte: t.text.slice(0, DOC_TEXT_CAP), tronque: t.text.length > DOC_TEXT_CAP,
          ...noteDeMethode(t.note),
        });
      }

      return resultatIndisponible("MISSING_INPUT",
        "Donnez `driveNodeId` (via search_drive), `documentId` (via inspect_record) ou `artifactId` (via list_artifacts).");
    },
  },
];
