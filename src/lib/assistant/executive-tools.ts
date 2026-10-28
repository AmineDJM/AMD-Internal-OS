import type { PowerTool } from "@/lib/assistant/power-tools";
import type { CurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { hasGlobalView } from "@/lib/rbac";
import { searchDrive } from "@/lib/queries/drive-search";
import { resolveDriveAccess, canViewDrive } from "@/lib/drive";
import { getBlob } from "@/lib/drive-storage";
import { readFileByKey } from "@/lib/storage";
import { extractAttachmentText } from "@/lib/assistant-files";
import { estMedia } from "@/platform/in-process/media";
import { indexDriveNodeText } from "@/lib/assistant/document-discovery";
import { toNumber } from "@/lib/utils";
import { chainOf, amountDrift, type ChainDoc } from "@/lib/legal/chain";
import { paymentExecutiveState } from "@/lib/assistant/executive-state";
import {
  REMINDER_RECURRENCES, RECURRENCE_LABEL, algiersToUtc, formatAlgiersDue,
  type ReminderRecurrence,
} from "@/lib/assistant/reminders";
import { ROLE_LABELS, REGULATORY_STEP_TYPE as REG_STEP_FR } from "@/lib/labels";
import {
  REG_STEPS, hasWorkflowState, regProgress, workflowAsSteps, type RegWorkflowState,
} from "@/lib/assistant/regulatory-read";
import { geste, retardJours, retardLabel } from "@/lib/assistant/workspace/emit";
import { resultatIndisponible } from "@/lib/assistant/capability-failure";
import { resultatListe, resultatVide } from "@/lib/assistant/empty-result";
import { fichierALire, fichiersDe } from "@/lib/assistant/artifact-ref";
import { invoiceSettlementState, INVOICE_SETTLEMENT } from "@/lib/labels";
import { libelleEtape } from "@/platform/in-process/promo";
import { sansBloquer } from "@/lib/journal";

/** Le pictogramme d'un document, déduit du nom — le protocole n'en connaît que cinq. */
function docKindFromName(name: string): "pdf" | "image" | "feuille" | "texte" | "autre" {
  const e = (name.split(".").pop() ?? "").toLowerCase();
  if (e === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(e)) return "image";
  if (["xlsx", "xlsm", "xls", "csv"].includes(e)) return "feuille";
  if (["txt", "md"].includes(e)) return "texte";
  return "autre";
}

/**
 * LES OUTILS EXÉCUTIFS — « My Chief of Staff », réservé au PDG et au Super Admin.
 *
 * Le Chief of Staff n'est pas un chatbot de plus : c'est l'interface de PILOTAGE. Ces outils lui
 * donnent ce qu'un chef de cabinet fait vraiment — fouiller le Drive et LIRE les pièces,
 * reconstituer l'HISTOIRE COMPLÈTE d'un dossier (devis → BC → validateurs → facture → règlement,
 * avec les dates), dresser le BILAN FACTUEL du travail d'une personne, et PLANIFIER (« rappelle-moi
 * mardi », « tous les dimanches relance Regulatory »).
 *
 * Trois règles, non négociables :
 *   • la PERMISSION se vérifie CÔTÉ SERVEUR, ici, à chaque appel — la liste d'outils envoyée au
 *     modèle n'est qu'une suggestion (`allowed`, revérifié par `executePowerTool`) ;
 *   • les PREUVES accompagnent chaque réponse : références, dates, auteurs, LIENS internes —
 *     jamais « le paiement est bloqué » sans dire lequel, depuis quand, chez qui ;
 *   • quand une donnée n'existe pas, l'outil le DIT (« aucune trace de… ») — il n'infère pas.
 */

/** Le siège exécutif : PDG (DIRECTION) et Super Admin — c'est LE module My Chief of Staff. */
/**
 * LA TRANSCRIPTION D'UN MÉDIA DU DRIVE, PAR LE CHEMIN QUI LA PERSISTE.
 *
 * Rend `null` — et non une erreur — sur tout ce qui ne se transcrit pas à coup sûr : l'appelant
 * retombe alors sur la lecture d'octets. Une garde qui casse la lecture d'un fichier parce que
 * la parole n'a pas pu être reconnue serait pire que le défaut qu'elle corrige (§118.27).
 */
async function transcriptionPersistee(
  user: CurrentUser,
  nodeId: string,
  nom: string,
): Promise<{ name: string; text: string; note: string | null; truncated: boolean } | null> {
  try {
    const { transcrireMediaDrive } = await import("@/platform/in-process/media/transcription");
    const { texteHorodate, formatHorodatage } = await import("@/platform/in-process/media");
    const r = await transcrireMediaDrive(user, { nodeId });
    if (!r.ok) return null;
    const texte = texteHorodate(r.vue.segments, { locuteurs: false });
    if (!texte.trim()) return null;
    const duree = r.vue.dureeS ? ` — ${formatHorodatage(r.vue.dureeS)}` : "";
    return {
      name: nom,
      text: texte,
      // La réserve vient de la LIGNE persistée, pas d'une note qu'on réécrit à chaque lecture.
      note: `Transcription ${r.vue.modele}${duree}, ${r.vue.segments.length} segment(s)`
        + `${r.vue.horodate ? " horodatés" : " (sans horodatage)"}${r.vue.depuisCache ? ", relue (déjà transcrite)" : ""}`
        + `${r.vue.limites.length ? ` — limites : ${r.vue.limites.join(" ; ")}` : ""}`
        + ` — ce n'est pas un fait vérifié : à citer comme PROBABLE, avec l'instant.`
        + ` Recherche fine de l'instant : media_transcript action=chercher.`,
      truncated: false,
    };
  } catch {
    return null;
  }
}

/**
 * LA NOTE DE MÉTHODE VOYAGE AVEC LE TEXTE — §104.15 appliqué à la porte de lecture.
 *
 * Mesuré sur la campagne live (`defi-media-reunion`) : `lireMedia` écrit une réserve
 * exemplaire — « Transcription <modèle>, N segment(s) horodatés — ce n'est pas un fait vérifié :
 * à citer comme PROBABLE, avec l'instant » — et `read_document` la passait à l'INDEX puis la
 * JETAIT. Adam a donc cité une reconnaissance vocale sous l'étiquette « FAIT VÉRIFIÉ », en toute
 * bonne foi : la seule phrase qui disait le contraire n'a jamais franchi la porte.
 *
 * Même chose pour un scan océrisé, une image lue par un modèle de vision, une présentation sans
 * texte : la méthode et sa confiance sont ce qui distingue une lecture d'une citation. Livrer la
 * sortie sans la note la fait citer comme une certitude (§29).
 *
 * Rend un objet VIDE quand il n'y a rien à dire — une réserve permanente devient du bruit, et on
 * cesse de lire les réserves (§118.32).
 */
function noteDeMethode(note: string | null | undefined): { methode?: string } {
  const t = (note ?? "").trim();
  return t ? { methode: t } : {};
}

const EXEC = (u: CurrentUser): boolean => u.role === "SUPER_ADMIN" || u.role === "DIRECTION";

const str = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === "string" ? (input[key] as string).trim() : "";

const DOC_TEXT_CAP = 9_000;

/** Un instant, en heure d'Alger, lisible. */
function fr(d: Date | null | undefined): string {
  if (!d) return "—";
  const alg = new Date(d.getTime() + 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(alg.getUTCDate())}/${p(alg.getUTCMonth() + 1)}/${alg.getUTCFullYear()} ${p(alg.getUTCHours())}:${p(alg.getUTCMinutes())}`;
}

// ───────────────────────── L'HISTOIRE COMPLÈTE D'UN DOSSIER ─────────────────────────

interface TimelineEntry { at: Date; label: string; who?: string | null }

/** Les validations qui visent une entité : validateurs nommés, décisions, dates. */
async function validationsOf(entityType: string, entityId: string) {
  const rows = await prisma.validationRequest.findMany({
    where: { entityType: entityType as never, entityId },
    select: {
      reference: true, status: true,
      steps: { select: { status: true, decidedAt: true, validator: { select: { name: true } } }, orderBy: { order: "asc" } },
    },
  });
  return rows.flatMap((v) =>
    v.steps.map((s) => ({
      validateur: s.validator.name,
      decision: s.status,
      date: s.decidedAt ? fr(s.decidedAt) : "en attente",
      demande: v.reference,
    })),
  );
}

/** Le journal d'audit d'une entité — la matière première de la timeline. */
async function auditOf(entityType: string, entityId: string): Promise<TimelineEntry[]> {
  const rows = await prisma.auditLog.findMany({
    where: { entityType: entityType as never, entityId },
    include: { actor: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
    take: 60,
  });
  return rows.map((h) => ({ at: h.createdAt, label: h.summary ?? h.action, who: h.actor?.name }));
}

/** Les pièces jointes d'une entité, avec leurs liens. */
async function documentsOf(entityType: string, entityId: string) {
  const docs = await prisma.document.findMany({
    where: { entityType: entityType as never, entityId },
    select: { id: true, name: true, category: true, createdAt: true, uploadedBy: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
    take: 40,
  });
  return docs.map((d) => ({
    documentId: d.id, nom: d.name, categorie: d.category,
    deposePar: d.uploadedBy?.name ?? null, le: fr(d.createdAt),
  }));
}

function renderTimeline(entries: TimelineEntry[]): { date: string; evenement: string; par?: string | null }[] {
  return [...entries]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((e) => ({ date: fr(e.at), evenement: e.label, ...(e.who ? { par: e.who } : {}) }));
}

// ───────────────────────── LES OUTILS ─────────────────────────

export const EXECUTIVE_TOOLS: PowerTool[] = [
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

  {
    def: {
      name: "inspect_record",
      description:
        "L'HISTOIRE COMPLÈTE d'un dossier à partir de sa RÉFÉRENCE, de son IDENTIFIANT interne (id rendu par une recherche) ou d'un fragment de titre : demande de paiement (PAY-…), " +
        "règlement/ordre de dépense, document Legal (devis, BC, facture, contrat), matériel promotionnel, demande du secrétariat " +
        "(REQ-…), sponsoring Ad&Pro (SPO-…), dossier Regulatory (REG-…), facture Finances, courrier du registre, projet délégué (DOS-…), tâche. " +
        "Renvoie la fiche, la TIMELINE reconstruite (qui a fait quoi, quand), les VALIDATEURS nommés avec leurs dates, les pièces " +
        "jointes, la chaîne devis→BC→facture→règlement quand elle existe, et les LIENS cliquables. " +
        "À utiliser pour « donne-moi toute l'histoire de cet achat », « qui a validé ? », « est-ce qu'on a payé ? », « où en est ce dossier ? ».",
      input_schema: {
        type: "object",
        properties: { reference: { type: "string", description: "Référence exacte (PAY-2026-014, ORD-…, REF du BC), identifiant interne rendu par une recherche (id), ou fragment de titre d'un document Legal." } },
        required: ["reference"],
      },
    },
    allowed: EXEC,
    label: "Dossier reconstitué",
    run: async (input, user) => {
      void user;
      // `query` est accepté comme SYNONYME de `reference` : le chemin rapide et la voix ont
      // longtemps servi ce nom-là, et un outil qui refuse une clé équivalente répond « il me
      // faut une référence » à quelqu'un qui vient d'en donner une.
      const brut = str(input, "reference") || str(input, "query");
      if (brut.length < 2) {
        // MÊME FORME QUE LES ONZE FICHES (§118.20) : une phrase nue tuerait toute référence
        // qu'un plan aurait écrite sur `type` ou `precision`.
        return JSON.stringify({
          type: null, reference: brut, trouve: false,
          precision: "Aucune référence ni fragment de titre n'a été donné : rien n'a été cherché.",
        });
      }

      /**
       * LE FRAGMENT SE RELIT SANS SON MOT-CLASSE. « dossier nivolumab », « contrat hetero »,
       * « le paiement hikma » : le premier mot dit le type, jamais l'identité — et aucun titre,
       * aucune DCI ne le contient. Quand la lecture littérale ne rend rien, on retente UNE fois
       * sans lui. Jamais l'inverse : le fragment complet garde la priorité, parce qu'un titre
       * peut réellement contenir « dossier ».
       */
      const nettoyer = (f: string): string =>
        f.replace(/^(?:(?:le|la|les|l'|l’|mon|ma|mes|ce|cet|cette|ces|du|de|des|d'|d’)\s+)*(?:dossier|produit|contrat|marché|marche|demande|projet|courrier|tâche|tache|paiement|facture|règlement|reglement|fiche)\s+(?:(?:de|du|des|d'|d’|pour|sur|concernant)\s+)?/i, "").trim();
      /**
       * ── LE RETRY NE SE DÉCIDE PLUS SUR UN PRÉFIXE DE CHAÎNE (§118.20) ─────────────────
       *
       * `inspecter` rendait une phrase commençant par « Aucun dossier ne porte » quand il ne
       * trouvait rien, et du JSON sinon — et le second essai se décidait en comparant ce
       * PRÉFIXE. Deux défauts dans la même ligne : la forme de la sortie dépendait de la donnée
       * (un plan ne pouvait rien écrire contre elle), et le contrôle de flux du fichier tenait à
       * une chaîne de caractères que n'importe quelle reformulation aurait cassée en silence.
       * `inspecter` DIT désormais s'il a trouvé, et rend toujours la même forme.
       */
      const premier = await inspecter(brut);
      if (premier.trouve) return premier.charge;
      const nettoye = nettoyer(brut);
      if (nettoye.length >= 2 && nettoye.toLowerCase() !== brut.toLowerCase()) {
        const second = await inspecter(nettoye);
        if (second.trouve) return second.charge;
      }
      return premier.charge;

      async function inspecter(ref: string): Promise<{ trouve: boolean; charge: string }> {
      /**
       * UNE SEULE FORME POUR ONZE TYPES DE FICHE. Chaque branche a ses champs propres — une
       * demande de paiement et un contrat n'ont pas les mêmes —, mais QUATRE clés existent
       * toujours : `type` (null quand rien n'est trouvé), `reference`, `trouve` et `precision`.
       * Un plan peut les référencer sans parier sur ce que la lecture rendra.
       */
      const fiche = (o: Record<string, unknown> & { precision?: string }): { trouve: boolean; charge: string } => {
        const trouve = o.type != null;
        return {
          trouve,
          charge: JSON.stringify({
            type: null, reference: ref, ...o, trouve,
            precision: o.precision ?? (trouve
              ? `Fiche « ${String(o.type)} » relue dans l'ERP — ce qui n'y figure pas n'a pas été tracé.`
              : "Aucune fiche ne correspond."),
          }),
        };
      };
      /**
       * L'IDENTIFIANT INTERNE EST RÉSOLU, PAS SEULEMENT LA RÉFÉRENCE — le correctif du Run 4.
       *
       * Le pipeline direct des missions (RECHERCHER → CIBLER → LIRE) recopie l'`id` EXACT rendu
       * par une recherche — c'est la consigne, et elle est juste. Or cet outil ne cherchait que
       * `reference`/`title` : servi avec l'id que le SYSTÈME LUI-MÊME avait rendu, il répondait
       * « Aucun dossier ne porte la référence » — contradiction relevée par le juge, replan
       * vide, mission BLOCKED (mesuré : COURRIERS, FINANCES, LEGAL, TACHES). Un identifiant
       * qu'on a distribué se relit ; chaque table porte donc `{ id: ref }` dans son OR — une
       * égalité stricte, qui ne peut rien attraper d'autre.
       */

      // 1) Demande de paiement.
      const pay = await prisma.paymentRequest.findFirst({
        where: { OR: [{ id: ref }, { reference: { equals: ref, mode: "insensitive" } }, { title: { contains: ref, mode: "insensitive" } }] },
        include: { pieces: { select: { kind: true, status: true, note: true } } },
      });
      if (pay) {
        const [timeline, validators, docs, order, valChrono] = await Promise.all([
          auditOf("PAYMENT_REQUEST", pay.id),
          validationsOf("PAYMENT_REQUEST", pay.id),
          documentsOf("PAYMENT_REQUEST", pay.id),
          pay.expenseOrderId
            ? prisma.expenseOrder.findUnique({
                where: { id: pay.expenseOrderId },
                select: { reference: true, status: true, centralStatus: true, paidDate: true, amount: true, createdAt: true },
              })
            : Promise.resolve(null),
          // La CHRONOLOGIE des marches de validation — la matière de l'état exécutif dérivé
          // (qui bloque, depuis combien de jours). Requête bornée, lancée en parallèle.
          prisma.validationRequest.findMany({
            where: { entityType: "PAYMENT_REQUEST", entityId: pay.id },
            select: { createdAt: true, steps: { select: { status: true, decidedAt: true, order: true, validator: { select: { name: true } } } } },
          }),
        ]);
        return fiche({
          type: "Demande de paiement",
          // L'ÉTAT EXÉCUTIF D'ABORD — « où est le paiement ? » = qui le bloque, depuis quand,
          // la prochaine étape, les signaux. Dérivé de la chronologie tracée (executive-state.ts).
          etatExecutif: paymentExecutiveState({
            status: pay.status, dueDate: pay.dueDate, createdAt: pay.createdAt,
            validations: valChrono.map((v) => ({
              createdAt: v.createdAt,
              steps: v.steps.map((s) => ({ status: s.status, decidedAt: s.decidedAt, order: s.order, validatorName: s.validator.name })),
            })),
            order: order ? { status: order.status, centralStatus: order.centralStatus, paidDate: order.paidDate, createdAt: order.createdAt } : null,
          }),
          reference: pay.reference, objet: pay.title, beneficiaire: pay.payee,
          montantDzd: Math.round(toNumber(pay.amount)), statut: pay.status,
          echeance: pay.dueDate ? fr(pay.dueDate) : null,
          pieces: pay.pieces.map((p) => ({ nature: p.kind, etat: p.status, note: p.note })),
          validateurs: validators,
          reglement: order
            ? {
                reference: order.reference, statut: order.status, centreDePaiement: order.centralStatus,
                payeLe: order.paidDate ? fr(order.paidDate) : null, montantDzd: Math.round(toNumber(order.amount)),
                lien: "/centre-de-paiement",
              }
            : "Aucun règlement créé — le bon à payer n'a pas encore été donné.",
          documentsJoints: docs,
          timeline: renderTimeline(timeline),
          lien: `/validations/paiements/${pay.id}`,
        });
      }

      // 2) Ordre de dépense (règlement).
      const order = await prisma.expenseOrder.findFirst({
        where: { OR: [{ id: ref }, { reference: { equals: ref, mode: "insensitive" } }, { label: { contains: ref, mode: "insensitive" } }] },
        include: { requestedBy: { select: { name: true } } },
      });
      if (order) {
        const timeline = await auditOf("EXPENSE_ORDER", order.id);
        return fiche({
          type: "Règlement (ordre de dépense)",
          etatExecutif: paymentExecutiveState({
            status: order.status, dueDate: null, createdAt: order.createdAt, validations: [],
            order: { status: order.status, centralStatus: order.centralStatus, paidDate: order.paidDate, createdAt: order.createdAt },
          }),
          reference: order.reference, objet: order.label,
          montantDzd: Math.round(toNumber(order.amount)),
          statut: order.status, centreDePaiement: order.centralStatus,
          demandePar: order.requestedBy?.name ?? null,
          payeLe: order.paidDate ? fr(order.paidDate) : "pas encore payé",
          timeline: renderTimeline(timeline),
          liens: ["/finances/paiements-a-faire", "/centre-de-paiement"],
        });
      }

      // 3) Document Legal — et sa CHAÎNE devis → BC → facture → règlement.
      const legal = await prisma.legalDocument.findFirst({
        where: { OR: [{ id: ref }, { reference: { equals: ref, mode: "insensitive" } }, { title: { contains: ref, mode: "insensitive" } }] },
        select: { id: true, title: true, reference: true, kind: true, counterparty: true, amount: true, startDate: true, endDate: true, status: true, chainFromId: true, expenseOrderId: true, notes: true, signedAt: true, effectiveAt: true, driveNodeId: true },
      });
      if (legal) {
        // La chaîne se remonte par requêtes bornées — le fil est court, une boucle serait un gel.
        const byId = new Map<string, { id: string; kind: string; title: string; reference: string | null; chainFromId: string | null; amount: unknown; startDate: Date | null }>();
        const select = { id: true, kind: true, title: true, reference: true, chainFromId: true, amount: true, startDate: true } as const;
        byId.set(legal.id, { ...legal });
        for (let hop = 0; hop < 8; hop += 1) {
          const wanted = [...byId.values()].map((r) => r.chainFromId).filter((x): x is string => Boolean(x) && !byId.has(x!));
          const children = await prisma.legalDocument.findMany({ where: { OR: [{ id: { in: wanted.length ? wanted : ["-"] } }, { chainFromId: { in: [...byId.keys()] } }], id: { notIn: [...byId.keys()] } }, select });
          if (children.length === 0) break;
          for (const c of children) byId.set(c.id, c);
        }
        const docsChain: ChainDoc[] = [...byId.values()].map((r) => ({ id: r.id, kind: r.kind, chainFromId: r.chainFromId }));
        const fil = chainOf(docsChain, legal.id).map((d) => {
          const row = byId.get(d.id)!;
          return { nature: row.kind, reference: row.reference, titre: row.title, montantDzd: row.amount != null ? Math.round(toNumber(row.amount as never)) : null, lien: `/legal/${row.id}` };
        });
        // MOTEUR DE CONTRADICTION (déterministe) : devis et facture de la MÊME chaîne qui ne
        // disent pas le même montant — on ne choisit jamais l'un en silence, on SIGNALE l'écart
        // avec les deux valeurs ; au modèle de vérifier la chronologie (un avenant l'explique-t-il ?).
        const quoteAmt = fil.find((m) => m.nature === "QUOTE")?.montantDzd ?? null;
        const invoiceAmt = fil.find((m) => m.nature === "INVOICE")?.montantDzd ?? null;
        const drift = amountDrift(quoteAmt, invoiceAmt);
        const incoherences = drift != null && drift !== 0
          ? [`écart devis → facture : ${drift > 0 ? "+" : ""}${drift.toLocaleString("fr-FR")} DZD (devis ${quoteAmt?.toLocaleString("fr-FR")} / facture ${invoiceAmt?.toLocaleString("fr-FR")}) — vérifier la chronologie (avenant ?) avant de citer un montant`]
          : [];
        const [timeline, validators, docs, settlement] = await Promise.all([
          auditOf("LEGAL_DOCUMENT", legal.id),
          validationsOf("LEGAL_DOCUMENT", legal.id),
          documentsOf("LEGAL_DOCUMENT", legal.id),
          legal.expenseOrderId
            ? prisma.expenseOrder.findUnique({ where: { id: legal.expenseOrderId }, select: { reference: true, status: true, centralStatus: true, paidDate: true } })
            : Promise.resolve(null),
        ]);
        return fiche({
          type: "Document Legal", nature: legal.kind,
          reference: legal.reference, titre: legal.title, partie: legal.counterparty,
          montantDzd: legal.amount != null ? Math.round(toNumber(legal.amount)) : null,
          statut: legal.status,
          // LES NOTES DE LA FICHE FONT PARTIE DE LA FICHE : préavis, exclusivité, redevance y
          // sont souvent consignés — les taire, c'est répondre « aucune clause exploitable »
          // à côté de la clause. Le fichier signé, lui, se LIT (read_document) : on donne la porte.
          notes: legal.notes ?? null,
          signeLe: legal.signedAt ? fr(legal.signedAt) : null,
          effetLe: legal.effectiveAt ? fr(legal.effectiveAt) : null,
          documentSigne: legal.driveNodeId ? { driveNodeId: legal.driveNodeId, lien: `/drive/${legal.driveNodeId}`, lire: "read_document(driveNodeId)" } : null,
          ...(incoherences.length > 0 ? { incoherences } : {}),
          chaineAchat: fil.length > 1 ? fil : "Pièce isolée — aucun lien devis/BC/facture déclaré.",
          reglement: settlement
            ? { reference: settlement.reference, statut: settlement.status, centreDePaiement: settlement.centralStatus, payeLe: settlement.paidDate ? fr(settlement.paidDate) : null }
            : null,
          validateurs: validators,
          documentsJoints: docs,
          timeline: renderTimeline(timeline),
          lien: `/legal/${legal.id}`,
        });
      }

      // 4) Matériel promotionnel.
      const promo = await prisma.promoMaterial.findFirst({
        where: { OR: [{ id: ref }, { reference: { equals: ref, mode: "insensitive" } }, { title: { contains: ref, mode: "insensitive" } }] },
        select: { id: true, reference: true, title: true, circuitState: true, circuitVersion: true, tracksDone: true, status: true, chosenAgency: true, amount: true, chosenAmount: true },
      });
      if (promo) {
        const [timeline, docs] = await Promise.all([auditOf("PROMO_MATERIAL", promo.id), documentsOf("PROMO_MATERIAL", promo.id)]);
        return fiche({
          type: "Matériel promotionnel",
          reference: promo.reference, titre: promo.title,
          // L'étape EN CLAIR, dans le vocabulaire de son circuit — un code d'état brut
          // (« REVIEW_REQUESTER ») se recopie tel quel dans une réponse que personne ne lit.
          circuit: promo.circuitState ? libelleEtape(promo.circuitState as Parameters<typeof libelleEtape>[0], promo.circuitVersion === 2 ? 2 : 1) : promo.status,
          chantiersClos: promo.tracksDone ?? "",
          agence: promo.chosenAgency,
          montantDzd: Math.round(toNumber(promo.chosenAmount ?? promo.amount ?? 0)) || null,
          documentsJoints: docs,
          timeline: renderTimeline(timeline),
          lien: `/promo-material/${promo.id}`,
        });
      }

      // 5) Demande du secrétariat.
      const req = await prisma.administrativeRequest.findFirst({
        where: { OR: [{ id: ref }, { reference: { equals: ref, mode: "insensitive" } }, { title: { contains: ref, mode: "insensitive" } }] },
        select: { id: true, reference: true, title: true, type: true, status: true, assignedTo: { select: { name: true } } },
      });
      if (req) {
        const [timeline, docs] = await Promise.all([auditOf("ADMIN_REQUEST", req.id), documentsOf("ADMIN_REQUEST", req.id)]);
        return fiche({
          type: "Demande du secrétariat",
          reference: req.reference, titre: req.title, nature: req.type, statut: req.status,
          responsable: req.assignedTo?.name ?? null,
          documentsJoints: docs,
          timeline: renderTimeline(timeline),
          lien: `/demandes/${req.id}`,
        });
      }

      // 5 bis) Sponsoring Ad&Pro (SPO-…) — le trou mesuré en conversation réelle : Adam a déclaré
      // « SPO-2026-004 n'existe pas » sur un sponsoring parfaitement réel (ASARI), parce que cet
      // outil « universel » ne couvrait pas la table. Une vérification qui ne sait pas lire une
      // famille ne doit jamais conclure à l'inexistence — désormais elle la lit.
      const spo = await prisma.sponsoringRequest.findFirst({
        where: {
          OR: [
            { id: ref },
            { reference: { equals: ref, mode: "insensitive" } },
            { institution: { contains: ref, mode: "insensitive" } },
            { doctor: { contains: ref, mode: "insensitive" } },
          ],
        },
        select: {
          id: true, reference: true, institution: true, doctor: true, specialty: true, city: true,
          type: true, status: true, strategicImportance: true, product: true,
          amountRequested: true, amountProposed: true, amountGranted: true,
          requestDate: true, requester: { select: { name: true } },
          preliminaryAt: true, productManagerId: true, finalAt: true, finalDecision: true,
          expenseOrderId: true,
          company: { select: { shortName: true, name: true } },
        },
      });
      if (spo) {
        const [timeline, validators, docs, reglement] = await Promise.all([
          auditOf("SPONSORING", spo.id),
          validationsOf("SPONSORING", spo.id),
          documentsOf("SPONSORING", spo.id),
          spo.expenseOrderId
            ? prisma.expenseOrder.findUnique({
                where: { id: spo.expenseOrderId },
                select: { reference: true, status: true, centralStatus: true, paidDate: true, amount: true },
              })
            : Promise.resolve(null),
        ]);
        return fiche({
          type: "Sponsoring (Ad&Pro)",
          reference: spo.reference,
          institution: spo.institution, medecin: spo.doctor, specialite: spo.specialty, ville: spo.city,
          nature: spo.type, produit: spo.product,
          statut: spo.status, importanceStrategique: spo.strategicImportance,
          entite: spo.company?.shortName ?? spo.company?.name ?? null,
          demandePar: spo.requester?.name ?? null, demandeLe: fr(spo.requestDate),
          montants: {
            demandeDzd: spo.amountRequested != null ? Math.round(toNumber(spo.amountRequested)) : null,
            proposeDzd: spo.amountProposed != null ? Math.round(toNumber(spo.amountProposed)) : null,
            accordeDzd: spo.amountGranted != null ? Math.round(toNumber(spo.amountGranted)) : null,
          },
          circuit: {
            preValidationDirection: spo.preliminaryAt ? fr(spo.preliminaryAt) : "pas encore",
            analyseChefDeProduit: spo.productManagerId ? "faite ou en cours" : "pas encore",
            decisionFinale: spo.finalAt ? `${fr(spo.finalAt)}${spo.finalDecision ? ` — ${spo.finalDecision.slice(0, 160)}` : ""}` : "pas encore",
          },
          reglement: reglement
            ? {
                reference: reglement.reference, statut: reglement.status, centreDePaiement: reglement.centralStatus,
                montantDzd: Math.round(toNumber(reglement.amount)),
                payeLe: reglement.paidDate ? fr(reglement.paidDate) : "pas encore payé",
              }
            : null,
          validateurs: validators,
          documentsJoints: docs,
          timeline: renderTimeline(timeline),
          lien: `/sponsoring/${spo.id}`,
        });
      }

      // 6) Dossier Regulatory (REG-…, ou DCI / nom commercial).
      const reg = await prisma.regulatoryProduct.findFirst({
        where: { OR: [{ id: ref }, { reference: { equals: ref, mode: "insensitive" } }, { dci: { contains: ref, mode: "insensitive" } }, { brandName: { contains: ref, mode: "insensitive" } }] },
        select: {
          id: true, reference: true, dci: true, brandName: true, status: true, priority: true,
          therapeuticClass: true, partnerLab: true, targetSubmissionDate: true, targetDate: true,
          workflow: true,
          company: { select: { shortName: true, name: true } },
          responsible: { select: { name: true } },
          steps: { select: { id: true, type: true, status: true, plannedDate: true, actualDate: true }, orderBy: { order: "asc" }, take: 30 },
        },
      });
      if (reg) {
        const [timeline, docs] = await Promise.all([auditOf("REGULATORY_PRODUCT", reg.id), documentsOf("REGULATORY_PRODUCT", reg.id)]);
        const lastMove = timeline.length ? timeline[timeline.length - 1] : null;
        /**
         * LA CARTE DU DOSSIER — l'objet montré en entier, dans l'ordre de la question.
         *
         * Le PDG qui ouvre un dossier en retard ne cherche pas une fiche : il cherche POURQUOI
         * ça n'avance pas. La frise du circuit et le blocage passent donc devant tout le reste,
         * et les quatre gestes du bas sont ceux qu'on pose vraiment sur un dossier bloqué.
         *
         * ── LA FRISE LIT LA MÊME SOURCE QUE L'ÉCRAN ──────────────────────────────────────
         *
         * Le défaut mesuré en conversation réelle : la fiche annonçait « Pré-soumission, étapes
         * non démarrées » alors que le journal disait « Dépôt du dossier → fait le 15/07 ». Les
         * deux disaient vrai — sur DEUX MAGASINS : l'équipe coche `RegulatoryProduct.workflow`
         * (les 22 étapes ANPP de l'écran), et cette fiche lisait la table `RegulatoryStep`, le
         * second registre que `workflowAsSteps` a déjà déclaré mort (regulatory-workflow.ts).
         * Quand le circuit est tenu, la frise le lit ; la table ne sert plus que de repli pour
         * un dossier jamais coché.
         */
        const circuitTenu = hasWorkflowState(reg.workflow as RegWorkflowState | null);
        const etapesCircuit = circuitTenu
          ? workflowAsSteps(reg.workflow as RegWorkflowState | null).map((s, i) => ({
              id: s.type,
              type: s.type,
              label: REG_STEPS[i]?.label ?? s.type,
              status: s.status,
              actualDate: s.actualDate,
            }))
          : reg.steps.map((s) => ({
              id: s.id,
              type: s.type,
              label: REG_STEP_FR[s.type] ?? String(s.type),
              status: s.status,
              actualDate: s.actualDate,
            }));
        const avancement = circuitTenu
          ? (() => { const p = regProgress(reg.workflow as RegWorkflowState | null); return `${p.done}/${p.total}`; })()
          : null;
        const cible = reg.targetDate ?? reg.targetSubmissionDate;
        const clos = reg.status === "DECISION_OBTAINED" || reg.status === "CLOSED";
        const retard = clos ? null : retardJours(cible);
        // L'ÉTAPE COURANTE : celle en cours, sinon la première qui bloque ou n'a pas démarré.
        const etapeCourante = etapesCircuit.find((st) => st.status === "IN_PROGRESS")
          ?? etapesCircuit.find((st) => st.status === "BLOCKED" || st.status === "LATE")
          ?? etapesCircuit.find((st) => st.status === "NOT_STARTED");

        const bloc = {
          kind: "dossier",
          title: reg.reference,
          subtitle: reg.brandName ? `${reg.dci} (${reg.brandName})` : reg.dci,
          ...(retard
            ? { badge: { label: "En retard", ton: "alerte" } }
            : clos
              ? { badge: { label: "Clôturé", ton: "succes" } }
              : {}),
          fields: [
            ...(reg.responsible?.name ? [{ label: "Chargé du dossier", value: reg.responsible.name }] : []),
            ...(etapeCourante ? [{ label: "Étape courante", value: etapeCourante.label }] : []),
            ...(avancement ? [{ label: "Avancement", value: `${avancement} étapes ANPP` }] : []),
            ...(retard ? [{ label: "Retard", value: retardLabel(retard) }] : []),
            ...(cible ? [{ label: "Échéance", value: fr(cible) }] : []),
            ...(reg.partnerLab ? [{ label: "Laboratoire", value: reg.partnerLab }] : []),
            ...(reg.company?.shortName || reg.company?.name ? [{ label: "Entité", value: (reg.company.shortName ?? reg.company.name) as string }] : []),
          ],
          ...(etapesCircuit.length
            ? {
                steps: (() => {
                  // La fenêtre glisse AUTOUR de l'étape courante : montrer les étapes 1 à 7 d'un
                  // dossier rendu à la 12ᵉ ferait croire que rien n'a bougé.
                  const idx = etapeCourante ? etapesCircuit.findIndex((st) => st.id === etapeCourante.id) : etapesCircuit.length;
                  const debut = Math.max(0, Math.min(idx - 2, etapesCircuit.length - 7));
                  return etapesCircuit.slice(debut, debut + 7).map((st) => ({
                    label: st.label,
                    etat: st.status === "DONE" ? "fait" : etapeCourante && st.id === etapeCourante.id ? "courant" : "a-venir",
                  }));
                })(),
              }
            : {}),
          ...(retard
            ? { alerte: { label: `Échéance dépassée de ${retardLabel(retard)}${etapeCourante ? ` — bloqué à l'étape « ${etapeCourante.label} »` : ""}.`, ton: "alerte" } }
            : {}),
          ...(docs.length
            ? {
                docs: docs.slice(0, 6).map((d) => ({
                  nom: d.nom, href: `/api/documents/${d.documentId}`,
                  type: docKindFromName(d.nom),
                  ...(d.categorie ? { soustitre: d.categorie } : {}),
                })),
              }
            : {}),
          ...(reg.responsible?.name ? { participants: [{ nom: reg.responsible.name, poste: "Chargé du dossier" }] } : {}),
          ...(timeline.length
            ? { activite: renderTimeline(timeline).slice(-3).reverse().map((t) => ({ date: t.date, label: t.par ? `${t.par} — ${t.evenement}` : t.evenement })) }
            : {}),
          lien: `/regulatory/${reg.id}`,
          actions: [
            geste("Relancer", `Prépare un mail de relance pour ${reg.reference}`, "primaire"),
            geste("Assigner", `Réassigne ${reg.reference}`),
            geste("Faire avancer", `Avance l'étape de ${reg.reference}`),
          ],
        };

        return fiche({
          type: "Dossier Regulatory",
          reference: reg.reference, dci: reg.dci, nomCommercial: reg.brandName,
          statut: reg.status, priorite: reg.priority,
          classeTherapeutique: reg.therapeuticClass, laboratoire: reg.partnerLab,
          entite: reg.company?.shortName ?? reg.company?.name ?? null,
          chargeDuDossier: reg.responsible?.name ?? null,
          ...(retard ? { retardJours: retard } : {}),
          datesCibles: {
            soumission: reg.targetSubmissionDate ? fr(reg.targetSubmissionDate) : null,
            objectif: reg.targetDate ? fr(reg.targetDate) : null,
          },
          // LES ÉTAPES = LE CIRCUIT COCHÉ PAR L'ÉQUIPE (même source que l'écran). L'ancienne
          // table `RegulatoryStep` ne sert plus que de repli pour un dossier jamais coché.
          ...(avancement ? { avancementCircuit: `${avancement} étapes ANPP faites` } : {}),
          etapes: etapesCircuit.map((s) => ({
            etape: s.label, etat: s.status,
            fait: s.actualDate ? fr(s.actualDate) : null,
          })),
          derniereActivite: lastMove ? { le: fr(lastMove.at), quoi: lastMove.label, par: lastMove.who } : "aucune trace au journal",
          documentsJoints: docs,
          timeline: renderTimeline(timeline),
          lien: `/regulatory/${reg.id}`,
          _blocs: [bloc],
        });
      }

      // 7) Facture — un document légal de nature « facture », par n° ou objet.
      const invoice = await prisma.legalDocument.findFirst({
        where: {
          kind: "INVOICE",
          OR: [{ id: ref }, { reference: { equals: ref, mode: "insensitive" } }, { title: { contains: ref, mode: "insensitive" } }],
        },
        select: {
          id: true, kind: true, reference: true, title: true, status: true, direction: true, amount: true,
          startDate: true, endDate: true, paidDate: true, counterparty: true, expenseOrderId: true,
          settlementTx: { select: { reference: true, date: true, amount: true } },
        },
      });
      if (invoice) {
        const etat = invoiceSettlementState(invoice);
        return fiche({
          type: "Facture (document légal)",
          numero: invoice.reference, objet: invoice.title,
          sens: invoice.direction === "IN" ? "émise (on encaisse)" : "reçue (on paie)",
          montantDzd: invoice.amount != null ? Math.round(toNumber(invoice.amount)) : null,
          statut: invoice.status,
          reglementEtat: INVOICE_SETTLEMENT[etat]?.label ?? null,
          emiseLe: invoice.startDate ? fr(invoice.startDate) : null,
          echeance: invoice.endDate ? fr(invoice.endDate) : null,
          payeeLe: invoice.paidDate ? fr(invoice.paidDate) : (etat === "IN_CIRCUIT" ? "partie au règlement" : "pas encore réglée"),
          partie: invoice.counterparty,
          reglement: invoice.settlementTx
            ? { ecriture: invoice.settlementTx.reference, le: fr(invoice.settlementTx.date), montantDzd: Math.round(toNumber(invoice.settlementTx.amount)) }
            : null,
          lien: `/legal/${invoice.id}`,
        });
      }

      // 8) Courrier du registre — par référence de chrono ou objet.
      const mail = await prisma.mailEntry.findFirst({
        where: { OR: [{ id: ref }, { reference: { equals: ref, mode: "insensitive" } }, { title: { contains: ref, mode: "insensitive" } }] },
        select: {
          id: true, reference: true, title: true, direction: true, sender: true, recipient: true,
          sentAt: true, receivedAt: true, acknowledgedAt: true, carrier: true, notes: true, driveNodeId: true,
          concernedUser: { select: { name: true } }, department: { select: { name: true } },
          partner: { select: { name: true } },
          pieces: { select: { label: true, documentId: true, driveNodeId: true, recipient: true } },
        },
      });
      if (mail) {
        return fiche({
          type: "Courrier (registre)",
          reference: mail.reference, objet: mail.title,
          sens: mail.direction === "OUTGOING" ? "Départ" : "Arrivée",
          expediteur: mail.sender, destinataire: mail.recipient,
          partenaire: mail.partner?.name ?? null,
          parti: mail.sentAt ? fr(mail.sentAt) : null,
          arrive: mail.receivedAt ? fr(mail.receivedAt) : null,
          accuseDeReception: mail.acknowledgedAt ? fr(mail.acknowledgedAt) : "pas d'accusé enregistré",
          porteur: mail.carrier,
          concerne: [mail.concernedUser?.name, mail.department?.name].filter(Boolean).join(" · ") || null,
          pieces: [
            ...mail.pieces.map((p) => ({
              piece: p.label, destinataire: p.recipient,
              documentId: p.documentId, driveNodeId: p.driveNodeId,
            })),
            ...(mail.driveNodeId ? [{ piece: "Pli principal (Drive)", destinataire: null, documentId: null, driveNodeId: mail.driveNodeId }] : []),
          ],
          notes: mail.notes,
          lien: "/courriers",
        });
      }

      // 9) Projet délégué (DOS-…).
      const dossier = await prisma.dossier.findFirst({
        where: { OR: [{ id: ref }, { reference: { equals: ref, mode: "insensitive" } }, { title: { contains: ref, mode: "insensitive" } }] },
        select: {
          id: true, reference: true, title: true, status: true, priority: true, category: true, dueDate: true,
          assignedTo: { select: { name: true } }, createdBy: { select: { name: true } },
          messages: { select: { body: true, createdAt: true, author: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 3 },
        },
      });
      if (dossier) {
        const [timeline, docs] = await Promise.all([auditOf("DOSSIER", dossier.id), documentsOf("DOSSIER", dossier.id)]);
        return fiche({
          type: "Projet délégué",
          reference: dossier.reference, sujet: dossier.title, categorie: dossier.category,
          statut: dossier.status, priorite: dossier.priority,
          responsable: dossier.assignedTo?.name ?? "à assigner",
          ouvertPar: dossier.createdBy?.name ?? null,
          echeance: dossier.dueDate ? fr(dossier.dueDate) : null,
          derniersEchanges: dossier.messages.map((m) => ({ par: m.author?.name, le: fr(m.createdAt), extrait: m.body.slice(0, 160) })),
          documentsJoints: docs,
          timeline: renderTimeline(timeline),
          lien: `/dossiers/${dossier.id}`,
        });
      }

      // 10) Tâche — par fragment de titre (en dernier : les titres sont les moins spécifiques).
      const task = await prisma.task.findFirst({
        where: { OR: [{ id: ref }, { title: { contains: ref, mode: "insensitive" } }] },
        select: {
          id: true, title: true, description: true, status: true, priority: true, dueDate: true, createdAt: true,
          assignedTo: { select: { name: true } }, createdBy: { select: { name: true } },
          comments: { select: { body: true, createdAt: true, author: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 3 },
        },
        orderBy: { createdAt: "desc" },
      });
      if (task) {
        return fiche({
          type: "Tâche",
          titre: task.title, detail: task.description,
          statut: task.status, priorite: task.priority,
          assigneeA: task.assignedTo?.name ?? null, creeePar: task.createdBy?.name ?? null,
          creeeLe: fr(task.createdAt),
          echeance: task.dueDate ? fr(task.dueDate) : null,
          enRetard: task.dueDate ? task.dueDate.getTime() < Date.now() && !["DONE", "CANCELLED"].includes(task.status) : false,
          derniersCommentaires: task.comments.map((c) => ({ par: c.author?.name, le: fr(c.createdAt), extrait: c.body.slice(0, 160) })),
          lien: "/mon-espace",
        });
      }

      return fiche({
        precision: `Aucun dossier ne porte la référence « ${ref} » (essayée comme référence, comme identifiant interne `
          + "et comme fragment de titre) — ni demande de paiement, ni règlement, ni document Legal, ni matériel "
          + "promotionnel, ni demande du secrétariat, ni sponsoring, ni dossier Regulatory, ni facture, ni courrier, "
          + "ni projet, ni tâche. Je préfère le dire plutôt que d'inventer.",
      });
      }
    },
  },

  {
    def: {
      name: "person_report",
      description:
        "Le BILAN FACTUEL du travail d'une personne : tâches (ouvertes, terminées, en retard), demandes déposées, validations rendues, " +
        "activité récente. FAITS et MÉTRIQUES seulement — jamais de jugement : la conclusion appartient au lecteur. " +
        "À utiliser pour « fais-moi un bilan du travail de X », « qui est en retard sur quoi ? ».",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Nom (ou fragment) de la personne." },
          months: { type: "number", description: "Fenêtre en mois (défaut 3)." },
        },
        required: ["name"],
      },
    },
    allowed: EXEC,
    label: "Bilan d'une personne",
    run: async (input, user) => {
      void user;
      const name = str(input, "name");
      if (name.length < 2) return "Donnez le nom de la personne.";
      const months = Math.min(12, Math.max(1, Number(input.months) || 3));
      const since = new Date(Date.now() - months * 30 * 86_400_000);

      const person = await prisma.user.findFirst({
        where: { name: { contains: name, mode: "insensitive" }, isActive: true },
        select: { id: true, name: true, role: true },
      });
      if (!person) {
        // §118.20 : un plan qui référence `personne` ne meurt pas parce que le nom est inconnu.
        return JSON.stringify({
          personne: null, retenu: [], candidats: [],
          precision: `Aucun compte actif ne porte le nom « ${name} ».`,
        });
      }

      const now = new Date();
      const [emp, tasksOpen, tasksDone, tasksLate, requests, validationsDecided, auditCount, lastAudit] = await Promise.all([
        prisma.employee.findFirst({
          where: { userId: person.id },
          select: { fullName: true, position: true, departmentRef: { select: { name: true } }, manager: { select: { fullName: true } } },
        }),
        prisma.task.count({ where: { assignedToId: person.id, status: { notIn: ["DONE", "CANCELLED"] } } }),
        prisma.task.count({ where: { assignedToId: person.id, status: "DONE", updatedAt: { gte: since } } }),
        prisma.task.findMany({
          where: { assignedToId: person.id, status: { notIn: ["DONE", "CANCELLED"] }, dueDate: { lt: now } },
          // LA PREUVE VOYAGE AVEC LE RETARD. Sans elle, « en retard » est vrai au sens du champ
          // `status` et faux au sens de l'entreprise — le contrat de la consultante AVAIT été
          // déposé, personne n'avait coché la tâche, et Adam a annoncé un retard qui n'en était
          // pas un. Le rapprochement est fait en amont par le registre d'événements ; ici, on se
          // contente de ne pas le perdre en route.
          select: { title: true, dueDate: true, evidenceAt: true, evidenceNote: true },
          orderBy: { dueDate: "asc" }, take: 10,
        }),
        prisma.administrativeRequest.count({ where: { requesterId: person.id, createdAt: { gte: since } } }),
        prisma.validationStep.count({ where: { validatorId: person.id, decidedAt: { gte: since } } }),
        prisma.auditLog.count({ where: { actorId: person.id, createdAt: { gte: since } } }),
        prisma.auditLog.findFirst({ where: { actorId: person.id }, orderBy: { createdAt: "desc" }, select: { createdAt: true, summary: true } }),
      ]);

      return JSON.stringify({
        personne: person.name,
        role: ROLE_LABELS[person.role] ?? person.role,
        poste: emp?.position ?? null,
        departement: emp?.departmentRef?.name ?? null,
        responsable: emp?.manager?.fullName ?? null,
        fenetre: `${months} mois`,
        faits: {
          tachesOuvertes: tasksOpen,
          tachesTermineesSurLaFenetre: tasksDone,
          tachesEnRetard: tasksLate.map((t) => ({
            titre: t.title,
            echeance: t.dueDate ? fr(t.dueDate) : null,
            // Renseigné SEULEMENT quand une preuve existe : un champ à `null` partout habituerait
            // le modèle à l'ignorer, et il ne le lirait plus le jour où il compte.
            ...(t.evidenceAt
              ? {
                  geste_deja_accompli: {
                    le: fr(t.evidenceAt),
                    quoi: t.evidenceNote,
                    aDire:
                      "La tâche est encore marquée à faire, MAIS le geste attendu a été accompli. "
                      + "Dire les DEUX : le statut n'a pas été mis à jour. Ne pas annoncer un retard sec.",
                  },
                }
              : {}),
          })),
          demandesDeposees: requests,
          validationsRendues: validationsDecided,
          actionsAuJournal: auditCount,
          derniereActivite: lastAudit ? { le: fr(lastAudit.createdAt), quoi: lastAudit.summary } : "aucune trace au journal",
        },
        rappel: "Faits et métriques uniquement — les retards peuvent tenir à des dépendances externes : vérifier avant de conclure.",
      });
    },
  },

  // ───────────────────────── PLANIFICATION ─────────────────────────

  {
    def: {
      name: "plan_reminder",
      description:
        "PLANIFIE un rappel : « rappelle-moi mardi à 10 h de vérifier X », « dans 3 heures » (calculer la date/heure), " +
        "« tous les dimanches relance Regulatory », « tous les dimanches relance Nesrine », « chaque premier lundi du mois ». " +
        "`date` = première échéance (AAAA-MM-JJ, heure d'Alger), `time` = HH:MM (défaut 09:00). " +
        "`recurrence` : NONE (une fois), DAILY, WEEKLY, MONTHLY (même quantième), MONTHLY_WEEKDAY (même Nième jour de semaine — " +
        "pour « chaque premier lundi du mois », donner comme première échéance un premier lundi). " +
        "`target_role` (rôle à RELANCER) et/ou `target_person` (personne NOMMÉE à relancer) — sans eux, seul l'utilisateur est prévenu. " +
        "`canal` : par où le rappel ARRIVE — « notification » (défaut : notification interne + push), « email » (dans sa boîte), " +
        "« les_deux ». OUI, un e-mail différé est possible, à la minute près : « envoie-moi un mail dans 2 minutes », " +
        "« réveille-moi à 20h45 par mail » = plan_reminder avec quand=« dans 2 minutes » et canal=« email ». " +
        "`link` (optionnel) = page interne à rouvrir. Calculer soi-même la date exacte à partir de la date du jour donnée en contexte. " +
        "Pour un POINT QUOTIDIEN (« tous les jours à 8h fais-moi mon point ») : DAILY à 08:00, link=/chief-of-staff, note « Point du matin ».",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Ce qu'il faut rappeler, en quelques mots." },
          quand: {
            type: "string",
            description: "L'ÉCHÉANCE EN FRANÇAIS, telle que dite : « demain à 10h », « dans 48h », "
              + "« vendredi prochain », « chaque vendredi », « le 15 septembre ». À PRÉFÉRER à date/time : "
              + "le moteur calcule lui-même (heure d'Alger) — recopier les mots de la personne évite les "
              + "erreurs de calcul de date. Si l'expression n'est pas comprise, l'outil le dit et il faut "
              + "alors donner date/time explicites.",
          },
          date: { type: "string", description: "Première échéance, AAAA-MM-JJ (heure d'Alger) — si « quand » n'est pas fourni." },
          time: { type: "string", description: "Heure HH:MM (défaut 09:00)." },
          recurrence: { type: "string", enum: [...REMINDER_RECURRENCES], description: "NONE, DAILY, WEEKLY, MONTHLY ou MONTHLY_WEEKDAY." },
          target_role: { type: "string", enum: Object.keys(ROLE_LABELS), description: "Rôle à relancer à chaque échéance (code rôle interne — pas un nom d'équipe : « Équipe Regulatory » se dit HEAD_OF_REGULATORY ou REGULATORY_ASSISTANT)." },
          target_person: { type: "string", description: "Nom d'une personne précise à relancer à chaque échéance." },
          canal: {
            type: "string", enum: ["notification", "email", "les_deux"],
            description: "Par où le rappel arrive chez l'utilisateur : « notification » (défaut), « email », « les_deux ». "
              + "L'e-mail part vers les adresses que la personne a DÉCLARÉES pour elle-même ; sans adresse lisible ou sans boîte "
              + "connectée, le rappel retombe sur la notification et le DIT — il ne disparaît jamais en silence.",
          },
          watch_reference: { type: "string", description: "SURVEILLANCE CONDITIONNELLE : référence d'un règlement (ORD-…), d'une demande de paiement (PAY-…), d'une validation (VAL-…) ou fragment du titre d'une tâche. À l'échéance, le rappel RELIT l'entité : encore en attente → il prévient l'utilisateur ; réglée → il le dit et s'éteint. Pour « si ce paiement n'est pas validé sous 48 h, préviens-moi »." },
          note: { type: "string", description: "Le message de la relance / le détail du rappel." },
          link: { type: "string", description: "Lien interne (/regulatory, /legal/…)." },
          escalations_h: {
            type: "array", items: { type: "number" },
            description: "ÉCHELLE DE RELANCES en heures APRÈS chaque tir : « rappelle-moi demain ; "
              + "si je ne réponds pas, dans deux jours puis vendredi » = date demain + [48, 72]. "
              + "Chaque barreau se consomme ; l'échelle s'arrête seule si la condition surveillée est réglée.",
          },
          stop_on_email_from: {
            type: "string",
            description: "EXTINCTION SUR E-MAIL : le rappel (et toutes ses relances) s'éteint TOUT SEUL "
              + "dès qu'un e-mail arrive de cette personne/adresse — « rappelle-moi dans 7 jours "
              + "SEULEMENT SI Sarah n'a toujours pas répondu ».",
          },
          stop_needs_attachment: {
            type: "boolean",
            description: "Avec stop_on_email_from : l'e-mail doit porter une PIÈCE JOINTE pour éteindre "
              + "le rappel (« …n'a pas envoyé le contrat ») — une simple réponse sans pièce ne suffit pas.",
          },
        },
        required: ["title"],
      },
    },
    allowed: EXEC,
    label: "Rappel planifié",
    run: async (input, user) => {
      const title = str(input, "title");
      if (!title) return "Donnez l'objet du rappel.";

      // LE MOTEUR TEMPOREL D'ABORD (§66) : « demain à 10h », « dans 48h », « chaque vendredi »
      // se calculent en CODE, pas dans la tête du modèle — la même grammaire que les attentes de
      // mission. Le décodeur renonce sur le doute (`null`) : on demande alors la date explicite,
      // on n'attrape jamais une phrase mal comprise.
      let dueAt: Date | null = null;
      let recurrenceDeduite: ReminderRecurrence | null = null;
      const quand = str(input, "quand");
      if (quand) {
        const { interpreterExpressionTemporelle } = await import("@/lib/temporal");
        const lu = interpreterExpressionTemporelle(quand, new Date());
        if (lu) {
          dueAt = lu.echeance;
          recurrenceDeduite = lu.recurrence === "DAILY" ? "DAILY" : lu.recurrence === "WEEKLY" ? "WEEKLY" : null;
        } else if (!str(input, "date")) {
          return `Expression temporelle « ${quand} » non comprise à coup sûr — donnez date (AAAA-MM-JJ) et time (HH:MM, heure d'Alger).`;
        }
      }
      if (!dueAt) dueAt = algiersToUtc(str(input, "date"), str(input, "time"));
      if (!dueAt) return "Date illisible — attendu : « quand » en français, ou date AAAA-MM-JJ et HH:MM (heure d'Alger).";
      if (dueAt.getTime() < Date.now() - 60_000) return "Cette échéance est déjà passée — donnez une date à venir.";
      const recurrence = (REMINDER_RECURRENCES as readonly string[]).includes(str(input, "recurrence"))
        ? (str(input, "recurrence") as ReminderRecurrence)
        : (recurrenceDeduite ?? "NONE");
      const roleRaw = str(input, "target_role");
      if (roleRaw && !(roleRaw in ROLE_LABELS)) {
        return `Rôle « ${roleRaw} » inconnu. Rôles possibles : ${Object.keys(ROLE_LABELS).join(", ")}.`;
      }
      // La PERSONNE NOMMÉE se résout MAINTENANT : un rappel qui relancerait « nesrine » sans
      // savoir qui c'est finirait par relancer personne, en silence.
      let targetUserId: string | null = null;
      let targetUserName: string | null = null;
      const personRaw = str(input, "target_person");
      if (personRaw) {
        const matches = await prisma.user.findMany({
          where: { isActive: true, OR: [{ name: { contains: personRaw, mode: "insensitive" } }, { title: { contains: personRaw, mode: "insensitive" } }] },
          select: { id: true, name: true },
          take: 5,
        });
        if (matches.length === 0) return `Personne « ${personRaw} » introuvable dans l'annuaire (search_people pour vérifier).`;
        if (matches.length > 1) return `Plusieurs personnes correspondent à « ${personRaw} » : ${matches.map((m) => m.name).join(", ")}. Précisez.`;
        targetUserId = matches[0].id;
        targetUserName = matches[0].name;
      }
      const link = str(input, "link");
      // Un lien de rappel reste INTERNE : un rappel qui ouvrirait un site externe serait une
      // porte de sortie déguisée.
      if (link && !link.startsWith("/")) return "Le lien doit être une page interne (commencer par « / »).";

      // SURVEILLANCE : la référence se résout MAINTENANT, dans l'ordre des références les plus
      // spécifiques — un rappel qui surveillerait « rien » ne préviendrait jamais de rien.
      let watchType: string | null = null;
      let watchId: string | null = null;
      let watchLabel: string | null = null;
      const watchRaw = str(input, "watch_reference");
      if (watchRaw) {
        const [order, payment, validation, task] = await Promise.all([
          prisma.expenseOrder.findFirst({ where: { reference: { equals: watchRaw, mode: "insensitive" } }, select: { id: true, reference: true, label: true } }),
          prisma.paymentRequest.findFirst({ where: { reference: { equals: watchRaw, mode: "insensitive" } }, select: { id: true, reference: true, title: true } }),
          prisma.validationRequest.findFirst({ where: { reference: { equals: watchRaw, mode: "insensitive" } }, select: { id: true, reference: true, title: true } }),
          prisma.task.findFirst({ where: { title: { contains: watchRaw, mode: "insensitive" }, status: { in: ["REQUESTED", "TODO", "IN_PROGRESS"] } }, orderBy: { createdAt: "desc" }, select: { id: true, title: true } }),
        ]);
        if (order) { watchType = "EXPENSE_ORDER"; watchId = order.id; watchLabel = `${order.reference} — ${order.label}`; }
        else if (payment) { watchType = "PAYMENT_REQUEST"; watchId = payment.id; watchLabel = `${payment.reference} — ${payment.title}`; }
        else if (validation) { watchType = "VALIDATION_REQUEST"; watchId = validation.id; watchLabel = `${validation.reference} — ${validation.title}`; }
        else if (task) { watchType = "TASK"; watchId = task.id; watchLabel = task.title; }
        else {
          return JSON.stringify({
            cree: null, rappel: null, surveille: null,
            precision: `Rien à surveiller sous « ${watchRaw} » — ni règlement, ni demande de paiement, ni validation, `
              + "ni tâche ouverte. Aucun rappel n'a été créé. Vérifier la référence (inspect_record).",
          });
        }
      }

      // L'ÉCHELLE DE RELANCES — bornée (6 barreaux, 1 h à 30 jours chacun) : une échelle
      // infinie serait du harcèlement programmé, pas de la persévérance.
      const echelle = Array.isArray(input.escalations_h)
        ? (input.escalations_h as unknown[])
            .filter((h): h is number => typeof h === "number" && h >= 1 && h <= 720)
            .slice(0, 6)
        : [];

      // L'EXTINCTION SUR E-MAIL — la même grammaire d'attente que les missions : une seule
      // vérité pour « cet e-mail est-il celui-là ? ».
      const stopFrom = str(input, "stop_on_email_from");
      const stopOnEvent = stopFrom
        ? {
            event: "EMAIL_RECEIVED",
            from: stopFrom,
            ...(input.stop_needs_attachment === true ? { attachment: true as const } : {}),
          }
        : null;

      /**
       * LE CANAL — « notification » (défaut), « email », « les_deux ». On ne DEVINE pas : une
       * valeur non reconnue retombe sur la notification, jamais sur un envoi. Un e-mail parti
       * par erreur d'interprétation ne se rattrape pas.
       */
      const canalDemande = str(input, "canal").toLowerCase();
      const channel = canalDemande === "email" ? "EMAIL" : canalDemande === "les_deux" ? "LES_DEUX" : "NOTIFICATION";

      const created = await prisma.assistantReminder.create({
        data: {
          userId: user.id, title, dueAt, recurrence, channel,
          targetRole: roleRaw || null,
          targetUserId,
          watchType, watchId, watchLabel,
          note: str(input, "note") || null,
          link: link || null,
          escalationsH: echelle as never,
          stopOnEvent: (stopOnEvent ?? undefined) as never,
        },
        select: { id: true },
      });
      const relances = [
        roleRaw ? `le rôle « ${ROLE_LABELS[roleRaw] ?? roleRaw} »` : null,
        targetUserName ? targetUserName : null,
      ].filter(Boolean);
      return JSON.stringify({
        cree: created.id,
        rappel: title,
        premiereEcheance: formatAlgiersDue(dueAt),
        recurrence: RECURRENCE_LABEL[recurrence],
        relance: relances.length ? relances.join(" et ") : null,
        surveille: watchLabel,
        echelleRelances: echelle.length > 0 ? `${echelle.length} relance(s) programmée(s) (+${echelle.join(" h, +")} h)` : null,
        extinction: stopFrom
          ? `s'éteint tout seul dès qu'un e-mail ${input.stop_needs_attachment === true ? "AVEC pièce jointe " : ""}arrive de « ${stopFrom} »`
          : null,
        canal: channel === "EMAIL" ? "e-mail" : channel === "LES_DEUX" ? "e-mail et notification" : "notification",
        note: "À l'échéance : "
          + (channel === "NOTIFICATION" ? "pop-up pour vous"
            : channel === "EMAIL" ? "un e-mail vers vos adresses déclarées (sans adresse lisible, la notification prend le relais et le dit)"
              : "un e-mail vers vos adresses déclarées ET un pop-up")
          + (relances.length ? ` et relance envoyée à ${relances.join(" et ")}` : "")
          + (watchLabel ? `. Surveillance : si « ${watchLabel} » est réglé d'ici là, le rappel le dit et s'éteint ; sinon il vous prévient (vous seul).` : "") + ".",
      });
    },
  },

  {
    def: {
      name: "list_reminders",
      description: "Liste les rappels PLANIFIÉS de l'utilisateur (actifs), avec leur échéance, leur récurrence et leur identifiant (pour cancel_reminder).",
      input_schema: { type: "object", properties: {} },
    },
    allowed: EXEC,
    label: "Rappels listés",
    run: async (_input, user) => {
      const rows = await prisma.assistantReminder.findMany({
        where: { userId: user.id, active: true },
        orderBy: { dueAt: "asc" },
        include: { targetUser: { select: { name: true } } },
        take: 50,
      });
      // §118.20 : cet outil rendait une PHRASE quand la liste était vide et un TABLEAU NU
      // sinon — deux formes qui n'ont pas même la même NATURE. `resultatListe` donne aux deux
      // la même enveloppe : `items`, `count`, `message`.
      return resultatListe(rows.map((r) => ({
        id: r.id, rappel: r.title,
        prochaineEcheance: formatAlgiersDue(r.dueAt),
        recurrence: RECURRENCE_LABEL[r.recurrence as ReminderRecurrence] ?? r.recurrence,
        relanceLeRole: r.targetRole ? ROLE_LABELS[r.targetRole] ?? r.targetRole : null,
        relanceLaPersonne: r.targetUser?.name ?? null,
        surveille: r.watchLabel ?? null,
      })), rows.length === 0 ? "Aucun rappel planifié." : `${rows.length} rappel(s) actif(s).`);
    },
  },

  {
    def: {
      name: "cancel_reminder",
      description: "ANNULE un rappel planifié (le sien uniquement). `id` vient de list_reminders.",
      input_schema: {
        type: "object",
        properties: { id: { type: "string", description: "Identifiant du rappel à annuler." } },
        required: ["id"],
      },
    },
    allowed: EXEC,
    label: "Rappel annulé",
    run: async (input, user) => {
      const id = str(input, "id");
      // `updateMany` filtré par propriétaire : on n'annule pas le rappel d'un autre en devinant
      // son identifiant.
      const done = await prisma.assistantReminder.updateMany({
        where: { id, userId: user.id, active: true },
        data: { active: false },
      });
      // UN SUCCÈS SE REND STRUCTURÉ : une mission distingue ainsi « fait » d'une phrase d'excuse.
      return done.count > 0 ? JSON.stringify({ ok: true, annule: true, message: "Rappel annulé." }) : "Rappel introuvable (ou déjà éteint).";
    },
  },

  {
    def: {
      name: "snooze_reminder",
      description:
        "REPOUSSE un rappel (le sien uniquement) : « repousse-le d'une heure », « redemande-moi demain ». "
        + "`id` vient de list_reminders. Donner `minutes` OU `quand` en français (« demain à 9h », « dans 2 heures »).",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Identifiant du rappel à repousser." },
          minutes: { type: "number", description: "De combien de minutes repousser (1 à 10080)." },
          quand: { type: "string", description: "Ou l'échéance en français : « demain à 9h », « dans 2 heures »." },
        },
        required: ["id"],
      },
    },
    allowed: EXEC,
    label: "Rappel repoussé",
    run: async (input, user) => {
      const id = str(input, "id");
      let minutes = typeof input.minutes === "number" && Number.isFinite(input.minutes) ? input.minutes : 0;
      const quand = str(input, "quand");
      if (!minutes && quand) {
        // Le MÊME moteur temporel que la création : une seule grammaire, jamais deux calendriers.
        const { interpreterExpressionTemporelle } = await import("@/lib/temporal");
        const lu = interpreterExpressionTemporelle(quand, new Date());
        if (!lu) return `Expression « ${quand} » non comprise à coup sûr — donnez plutôt « minutes ».`;
        minutes = Math.round((lu.echeance.getTime() - Date.now()) / 60_000);
        if (minutes < 1) return "Cette échéance est déjà passée — donnez un moment à venir.";
      }
      if (!minutes) return "Donnez « minutes » ou « quand » (en français).";
      const { snoozeReminder } = await import("@/lib/assistant/reminders");
      const nouveau = await snoozeReminder(id, user.id, minutes);
      return nouveau
        ? JSON.stringify({ ok: true, repousse: true, prochaineEcheance: formatAlgiersDue(nouveau), message: `Rappel repoussé — prochaine échéance : ${formatAlgiersDue(nouveau)}.` })
        : "Rappel introuvable (ou déjà éteint).";
    },
  },
];

/** Le briefing du mode exécutif — annonce les pouvoirs, sinon le modèle ne les utilise pas. */
export function executiveBriefing(user: CurrentUser): string {
  if (!EXEC(user)) return "";
  void hasGlobalView;
  // COMPACT, ET C'EST VOULU. La version précédente (11 600 caractères) était le mode d'emploi
  // de trente outils — chacun porte déjà sa description dans son schéma, et le routeur choisit
  // la liste courte. Ce qui reste : le ton du chef de cabinet et les RÉFLEXES de jugement qu'un
  // schéma ne peut pas porter (quelle source fait autorité pour quelle question).
  return `

MODE EXÉCUTIF — chef de cabinet du dirigeant. Ton DIRECT, CHIFFRÉ, SOURCÉ : une question simple reçoit une ou deux
phrases avec le chiffre et sa source ; une question complexe, une synthèse structurée. Jamais de politesse de
remplissage. Réflexes : quand on ignore OÙ est la chose, la recherche fédérée (les PERSONNES et leurs coordonnées :
l'annuaire, directory_lookup / directory_list) ; « où en est », « qui a validé », « a-t-on payé » : la fiche complète
(inspect_record) ; un document se LIT (read_document) avant d'être résumé ou chiffré ; l'argent d'un produit :
product_economics, un marché PCH de la soumission à l'encaissement : pch_market_status — PAS la séquence de lectures
qu'ils remplacent ; l'état PASSÉ : time_travel, « qu'est-ce qui a changé » : what_changed ; « on avait décidé quoi ? » :
episodic_recall avant tout « je ne retrouve rien ». Une lecture qui rend zéro INDIQUE l'outil à prendre — le suivre
au lieu de relancer la même recherche.`;
}
