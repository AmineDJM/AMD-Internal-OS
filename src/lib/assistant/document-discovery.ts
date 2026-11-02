import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { searchDrive } from "@/lib/queries/drive-search";
import { resolveDriveAccess, canViewDrive } from "@/lib/drive";
import { inProcessPlatform, principalOf } from "@/platform/in-process/adapter";
import type { DocumentExtract } from "@/platform/contract";
import { getBlob } from "@/lib/drive-storage";
import { extractAttachmentText } from "@/platform/ia/media/assistant-files";
import { estMedia } from "@/lib/media/formats";
import { foldText } from "@/lib/assistant/memory-context";
import { driveSemanticCandidates } from "@/lib/assistant/semantic-drive";
import { classifyDocument, DOC_KIND_LABEL, type DocKind } from "@/platform/doc-kind";
import { chercherContenu, enregistrerMentions, resoudreEntitesDe, documentsLies, loteurNoeudsDrive, type Loteur } from "@/lib/fabric";
import { sansBloquer } from "@/lib/journal";

/**
 * DÉCOUVERTE DOCUMENTAIRE EN DRIVE « SALE » — retrouver un document que son NOM ne trahit pas.
 *
 * Le Drive réel n'est pas propre : « scan_0234.pdf » peut être le contrat de Khaled, rangé dans
 * le mauvais dossier. La règle : LE NOM D'UN FICHIER EST UN INDICE, PAS UNE PREUVE — la preuve,
 * c'est le CONTENU lu. Le moteur combine donc trois sources :
 *   1. les MÉTADONNÉES (nom/chemin, via la même recherche que l'écran Drive) ;
 *   2. l'INDEX TEXTUEL PROGRESSIF (`DriveTextIndex`) — le texte des fichiers déjà lus, qui
 *      grandit à chaque lecture (read_document, find_documents) : jamais de balayage massif ;
 *   3. la LECTURE À LA VOLÉE, bornée, des meilleurs candidats non encore indexés.
 *
 * Chaque résultat porte sa CONFIANCE (HAUTE = les termes sont dans le contenu lu ;
 * MOYENNE = correspondance partielle ; FAIBLE = le nom seul, contenu illisible ou non lu)
 * et sa PREUVE (extrait cité). Les DROITS Drive se revérifient nœud par nœud, y compris
 * pour l'index : un texte indexé ne s'affiche jamais à qui ne peut pas ouvrir le fichier.
 */

const EXEC = (u: CurrentUser): boolean => u.role === "SUPER_ADMIN" || u.role === "DIRECTION";

const str = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === "string" ? (input[key] as string).trim() : "";

/** Texte indexé par fichier (assez pour retrouver et citer, sans stocker le document entier). */
const INDEX_TEXT_CAP = 20_000;
/** Au-delà, pas de lecture à la volée (un .zip d'1 Go n'a rien à faire ici). */
const ON_THE_FLY_SIZE_CAP = 8 * 1024 * 1024;

/**
 * Mémorise le texte extrait d'un fichier du Drive — appelé après CHAQUE lecture réussie ET par
 * l'ingestion planifiée. Classifie au passage (le nom est un indice, le contenu la preuve).
 * Meilleur-effort : l'échec d'indexation ne casse jamais la lecture.
 */
export async function indexDriveNodeText(nodeId: string, versionId: string, text: string, note?: string | null, name?: string | null): Promise<void> {
  try {
    const capped = text.slice(0, INDEX_TEXT_CAP);
    const docKind = classifyDocument(name ?? "", capped);
    const fold = foldText(capped);
    /**
     * ── UNE LIGNE VIDE PORTE TOUJOURS SA RAISON — la garde est ICI, chez l'ÉCRIVAIN ─────
     *
     * `nodeText` refuse d'honorer un index vide SANS raison (voir plus bas) : c'est la moitié
     * LECTURE. La moitié ÉCRITURE doit être au même endroit que TOUS les écrivains, sinon on
     * répare un appelant à la fois et le suivant arrive par la porte qu'on n'a pas regardée
     * (§118.58). Recensé : `read_document` écrivait `note ?? null`, le dépôt d'une pièce écrit
     * un texte vide sans note, et l'ingestion planifiée passe par ici aussi.
     *
     * On ne devine RIEN sur le contenu : la raison ne dit que ce qu'on sait à coup sûr — aucun
     * texte n'a été extrait, et de quel FORMAT il s'agit, parce qu'un `.mp3` et un `.pdf`
     * n'appellent pas le même geste. Sans elle, la ligne se relit comme « lu, rien dedans »
     * (§104.15) et le document devient introuvable par son contenu, en silence.
     */
    const raison = capped.trim() === "" ? (note?.trim() || raisonIllisible(name ?? "")) : (note ?? null);
    await prisma.driveTextIndex.upsert({
      where: { nodeId },
      create: { nodeId, versionId, text: capped, textFold: fold, note: raison, docKind },
      update: { versionId, text: capped, textFold: fold, note: raison, docKind },
    });
    // LES MENTIONS D'ENTITÉS S'EXTRAIENT ICI (fabric F4) — au même moment que la
    // classification, pour la même raison : le travail se paie quand l'information ENTRE,
    // plus jamais à la question. Meilleur-effort, comme le reste de l'indexation.
    await enregistrerMentions(nodeId, fold).catch(sansBloquer("document-discovery.indexDriveNodeText.enregistrerMentions"));
  } catch (err) {
    console.error("[assistant] indexDriveNodeText failed", err);
  }
}

/**
 * L'HYDRATATION EN LOT des candidats (fabric F6) — N candidats, UNE requête de nœuds.
 *
 * Avant : chaque boucle de vérification faisait UN `findUnique` par candidat, EN SÉRIE —
 * vingt candidats, vingt allers-retours SQL. Ici la vague entière part ensemble : l'ACL se
 * vérifie toujours NŒUD PAR NŒUD (le loteur rend des lignes, jamais un droit), mais en
 * parallèle, et les lignes `DriveNode` sont servies par le loteur en un `findMany`.
 * L'ordre d'entrée est conservé ; refusé, absent ou à la corbeille → écarté.
 */
async function hydraterCandidats<H extends { nodeId: string }>(
  user: CurrentUser,
  noeuds: Loteur<{ id: string; name: string; isTrashed: boolean }>,
  hits: readonly H[],
): Promise<{ hit: H; node: { name: string } }[]> {
  const paires = await Promise.all(hits.map(async (hit) => {
    const [acces, node] = await Promise.all([resolveDriveAccess(user, hit.nodeId), noeuds.charger(hit.nodeId)]);
    if (!canViewDrive(acces) || !node || node.isTrashed) return null;
    return { hit, node };
  }));
  return paires.filter((p): p is NonNullable<typeof p> => p !== null);
}

interface NodeText {
  name: string;
  text: string | null;
  note: string | null;
  fromIndex: boolean;
}

/**
 * Lit le texte d'un nœud : index d'abord (si la version n'a pas bougé), sinon extraction à la
 * volée + indexation. Le DROIT a déjà été vérifié par l'appelant (nœud par nœud).
 */
async function nodeText(nodeId: string): Promise<NodeText | null> {
  const node = await prisma.driveNode.findUnique({
    where: { id: nodeId },
    select: { name: true, type: true, isTrashed: true, size: true },
  });
  if (!node || node.isTrashed || node.type !== "FILE") return null;

  const version = await prisma.fileVersion.findFirst({
    where: { nodeId }, orderBy: { version: "desc" }, select: { id: true, blobId: true },
  });
  if (!version) return { name: node.name, text: null, note: "aucune version de fichier", fromIndex: false };

  const cached = await prisma.driveTextIndex.findUnique({
    where: { nodeId }, select: { versionId: true, text: true, note: true },
  });
  /**
   * ── UN INDEX VIDE N'EST PAS UNE LECTURE : C'EST UNE ABSENCE DE LECTURE ──────────────────
   *
   * MESURÉ sur la campagne live (`defi-media-reunion`). Le dépôt d'un `.mp3` écrit une ligne
   * d'index avec un texte VIDE et AUCUNE note — l'extraction d'octets ne sait rien tirer d'un
   * audio. Le cache rendait alors `{ text: null, note: null }`, c'est-à-dire, pour tout
   * appelant, « lu, il n'y a rien dedans ». Conséquences en chaîne : la découverte par CONTENU
   * ne pouvait pas trouver l'enregistrement (son index est vide), la pré-lecture a lu un autre
   * document, et Adam a répondu — honnêtement — que le contenu audio « n'est pas transcrit ni
   * lisible ». Trente-deux secondes de parole, un transcripteur qui marche, et une réponse
   * INCONNU : c'est §104.15 mot pour mot — « répondre « lu, rien dedans » ferait conclure que
   * le tampon est vierge alors que RIEN n'a été tenté ».
   *
   * Un index vide SANS raison n'est donc pas honoré : on re-tente. Un index vide AVEC sa raison
   * (« illisible », « trop volumineux ») est un acquis — c'est ce qui évite de repayer un scan
   * illisible à chaque lecture, et c'était la bonne intention du code d'origine.
   */
  const videSansRaison = cached !== null && !cached.text.trim() && !(cached.note ?? "").trim();
  if (cached && cached.versionId === version.id && !videSansRaison) {
    return { name: node.name, text: cached.text || null, note: cached.note, fromIndex: true };
  }

  if (node.size > ON_THE_FLY_SIZE_CAP) {
    return { name: node.name, text: null, note: "trop volumineux pour une lecture à la volée", fromIndex: false };
  }

  /**
   * ── UN MÉDIA SE LIT PAR LA PAROLE, ET LE TEXTE ENTRE DANS L'INDEX ───────────────────────
   *
   * `read_document` route déjà un média vers le transcripteur qui PERSISTE (§118.94) ; ce
   * chemin-ci — celui de l'indexation et de la découverte — ne le faisait pas. Le prix de cet
   * écart n'est pas seulement une lecture ratée : c'est un enregistrement INTROUVABLE par son
   * contenu, pour toujours, et payé à chaque lecture par le seul chemin qui savait le lire.
   *
   * On appelle donc le MÊME transcripteur ici, et sa sortie entre dans l'index comme n'importe
   * quel texte : la parole est transcrite UNE fois, puis relue. C'est strictement moins cher
   * qu'avant, où chaque lecture la refaisait sans rien garder.
   */
  const media = await texteDeMedia(nodeId, node.name).catch(sansBloquer("document-discovery.nodeText.texteDeMedia", null));
  if (media) {
    await indexDriveNodeText(nodeId, version.id, media.text, media.note, node.name);
    return { name: node.name, text: media.text, note: media.note, fromIndex: false };
  }

  const bytes = await getBlob(version.blobId).catch(sansBloquer("document-discovery.nodeText.getBlob", null));
  if (!bytes) return { name: node.name, text: null, note: "contenu indisponible", fromIndex: false };
  const t = await extractAttachmentText(node.name, bytes);
  // On indexe MÊME l'échec (texte vide) : inutile de re-tenter un scan illisible à chaque fois.
  // LA RAISON EST OBLIGATOIRE — sans elle, la ligne se relirait comme « lu, rien dedans » (voir
  // `videSansRaison` ci-dessus), et le prochain lecteur croirait le document vide.
  await indexDriveNodeText(nodeId, version.id, t.text ?? "", t.note ?? (t.text ? null : raisonIllisible(node.name)), node.name);
  return { name: node.name, text: t.text || null, note: t.note ?? null, fromIndex: false };
}

/**
 * LA RAISON D'UN TEXTE VIDE, jamais un silence. Elle nomme le format lu, parce que « illisible »
 * sur un `.mp3` et « illisible » sur un `.pdf` n'appellent pas le même geste.
 */
function raisonIllisible(nom: string): string {
  const ext = (/\.([a-z0-9]+)$/i.exec(nom)?.[1] ?? "").toLowerCase();
  return estMedia(nom)
    ? `média ${ext || "audio/vidéo"} : la reconnaissance de parole n'a rien rendu (fichier muet, trop court, ou moteur indisponible)`
    : `aucun texte extrait de ce ${ext || "fichier"} (scan sans OCR, format non textuel, ou fichier vide)`;
}

/**
 * LE TEXTE D'UN MÉDIA, par le transcripteur qui PERSISTE — `null` sur tout ce qui n'est pas un
 * média ou ne se transcrit pas à coup sûr, auquel cas l'appelant retombe sur les octets.
 *
 * L'import est dynamique pour la même raison qu'ailleurs : ce module est chargé par des chemins
 * qui n'ont pas besoin du moteur de parole, et le tirer statiquement l'imposerait à tous.
 */
async function texteDeMedia(nodeId: string, nom: string): Promise<{ text: string; note: string } | null> {
  if (!estMedia(nom)) return null;
  const compte = await prisma.user.findFirst({
    // LE SYSTÈME LIT SOUS SON PROPRE COMPTE, comme l'ingestion le fait déjà : ce chemin sert
    // l'INDEX, pas une réponse à une personne, et le droit de LIRE la pièce a été vérifié par
    // l'appelant, nœud par nœud (voir l'en-tête de `nodeText`).
    where: { role: "SUPER_ADMIN", isActive: true }, orderBy: { createdAt: "asc" }, select: { id: true },
  });
  if (!compte) return null;
  const { getAccess } = await import("@/lib/rbac");
  const { transcrireMediaDrive } = await import("@/platform/in-process/media/transcription");
  const { texteHorodate, formatHorodatage } = await import("@/platform/ia/media");
  const u = await prisma.user.findUnique({ where: { id: compte.id } });
  if (!u) return null;
  const acteur = { ...u, access: await getAccess(u.id, u.role) } as unknown as CurrentUser;
  const r = await transcrireMediaDrive(acteur, { nodeId });
  if (!r.ok) return null;
  const text = texteHorodate(r.vue.segments, { locuteurs: false });
  if (!text.trim()) return null;
  const duree = r.vue.dureeS ? ` — ${formatHorodatage(r.vue.dureeS)}` : "";
  // LA MÉTHODE VOYAGE AVEC LE TEXTE (§104.15) : une reconnaissance de parole n'est pas un
  // procès-verbal, et c'est cette note qui l'empêche d'être citée comme un fait vérifié.
  return {
    text,
    note: `Transcription ${r.vue.modele}${duree}, ${r.vue.segments.length} segment(s)`
      + `${r.vue.horodate ? " horodatés" : " (sans horodatage)"}`
      + ` — ce n'est pas un fait vérifié : à citer comme PROBABLE, avec l'instant.`,
  };
}

/**
 * INGESTION : garantit qu'un nœud est indexé (extraction + classification si nécessaire).
 * Utilisée par la tâche planifiée d'ingestion du Drive — même chemin que la lecture à la volée.
 * Renvoie true si un index existe à l'issue de l'appel (même un index « illisible »).
 */
export async function ensureNodeIndexed(nodeId: string): Promise<boolean> {
  const t = await nodeText(nodeId).catch(sansBloquer("document-discovery.ensureNodeIndexed.nodeText", null));
  if (!t) return false;
  const row = await prisma.driveTextIndex.findUnique({ where: { nodeId }, select: { id: true } }).catch(sansBloquer("document-discovery.ensureNodeIndexed.driveTextIndex", null));
  if (row) return true;
  // Le contenu n'a pas pu être lu (blob indisponible, trop volumineux, pas de version) : un
  // index-témoin garde la RAISON — l'ingestion ne re-tente pas le même nœud à chaque passage.
  const version = await prisma.fileVersion.findFirst({ where: { nodeId }, orderBy: { version: "desc" }, select: { id: true } });
  await indexDriveNodeText(nodeId, version?.id ?? "-", "", t.note ?? "contenu non lisible", t.name);
  return true;
}

interface Finding {
  nodeId: string;
  nom: string;
  chemin?: string;
  matchedInName: number;
  matchedInContent: number;
  /** Similarité cosinus quand le candidat vient du niveau SÉMANTIQUE (repli). */
  semScore?: number;
  /** Le libellé de l'entité canonique qui LIE ce document à la requête (fabric F4). */
  entiteLiee?: string;
  excerpt?: string;
  note?: string | null;
  docKind?: string | null;
  contentChecked: boolean;
}

function tokensOf(query: string): string[] {
  return [...new Set(foldText(query).split(/[^a-z0-9]+/).filter((t) => t.length >= 3))].slice(0, 8);
}

function countMatches(foldedHaystack: string, tokens: string[]): number {
  return tokens.filter((t) => foldedHaystack.includes(t)).length;
}

function excerptAround(text: string, tokens: string[]): string | undefined {
  const folded = foldText(text);
  for (const t of tokens) {
    const at = folded.indexOf(t);
    if (at >= 0) {
      const start = Math.max(0, at - 90);
      const end = Math.min(text.length, at + t.length + 130);
      return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
    }
  }
  return undefined;
}

export const DOCUMENT_DISCOVERY_TOOLS: PowerTool[] = [
  {
    def: {
      name: "find_documents",
      description:
        "RETROUVE des documents dans le Drive même MAL NOMMÉS ou MAL RANGÉS (« retrouve le contrat de Khaled », « la facture " +
        "du fournisseur X de mars ») : cherche dans les NOMS, dans le TEXTE INDEXÉ des fichiers (une ingestion planifiée indexe " +
        "progressivement TOUT le Drive — un document jamais ouvert et mal nommé devient trouvable par son CONTENU), puis LIT " +
        "les meilleurs candidats pour VÉRIFIER. Chaque résultat porte sa CONFIANCE (HAUTE = termes trouvés dans le contenu lu ; " +
        "MOYENNE = partiel ; FAIBLE = nom seul, contenu non vérifiable), sa PREUVE (extrait) et sa NATURE détectée (contrat de " +
        "travail, facture, devis, BC…). Le nom d'un fichier est un indice, pas une preuve. Plus lent que search_drive.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Ce que l'on cherche : nature du document + entité (« contrat Khaled Benali », « facture Sarl Imprimerie mars »)." },
          kind: {
            type: "string",
            description: "Filtre optionnel par NATURE détectée : employment_contract | amendment | job_description | invoice | quote | purchase_order | contract | identity_document | regulatory_document | correspondence | corporate_document.",
          },
          max_reads: { type: "number", description: "Nombre maximum de fichiers lus à la volée pour vérification (défaut 6, max 10)." },
        },
        required: ["query"],
      },
    },
    allowed: EXEC,
    label: "Découverte documentaire (contenu vérifié)",
    run: async (input, user) => {
      const query = str(input, "query");
      if (query.length < 3) return "Donnez ce que vous cherchez (nature du document + nom/entité).";
      const maxReads = Math.min(Math.max(Math.round(Number(input.max_reads) || 6), 1), 10);
      const kindFilter = str(input, "kind") in DOC_KIND_LABEL ? (str(input, "kind") as DocKind) : null;
      const tokens = tokensOf(query);
      if (tokens.length === 0) return "Termes trop courts — donnez au moins un mot de 3 caractères.";

      const findings = new Map<string, Finding>();

      // 1) MÉTADONNÉES — la même recherche que l'écran Drive (droits déjà appliqués).
      //    La requête entière, puis chaque terme séparément : un fichier « BENALI_scan.pdf »
      //    doit sortir même si « contrat » n'est pas dans son nom.
      const metaQueries = [query, ...tokens.filter((t) => !foldText(query).startsWith(t))].slice(0, 4);
      const metaResults = await Promise.all(metaQueries.map((q) => searchDrive(user, q).catch(sansBloquer("document-discovery.run.searchDrive", { rows: [], truncated: false }))));
      for (const out of metaResults) {
        for (const r of out.rows.slice(0, 15)) {
          const prev = findings.get(r.id);
          const matchedInName = countMatches(foldText(`${r.name} ${r.path ?? ""}`), tokens);
          if (!prev) {
            findings.set(r.id, { nodeId: r.id, nom: r.name, chemin: r.path, matchedInName, matchedInContent: 0, contentChecked: false });
          } else if (matchedInName > prev.matchedInName) prev.matchedInName = matchedInName;
        }
      }

      /**
       * 2) INDEX TEXTUEL — les fichiers déjà lus dont le CONTENU porte les termes.
       *
       * ── LA FABRIC A REMPLACÉ LE SCAN (F2) ─────────────────────────────────────────────
       *
       * Ce bloc faisait deux `findMany` en `contains` sur `textFold` — un LIKE '%…%' sans
       * index, donc un parcours du corpus ENTIER à chaque question, le seul endroit où la
       * latence croissait linéairement avec le nombre de documents. `chercherContenu` passe
       * par l'index FTS (mots, classés, préfixes) et retombe sur le LIKE — désormais servi
       * par l'index trigramme — en le DISANT. La politique de l'entonnoir ne change pas :
       * mêmes candidats AND-puis-OR, et le droit reste revérifié NŒUD PAR NŒUD ci-dessous,
       * AVANT toute exploitation — un index n'est jamais une porte dérobée.
       */
      const kindWhere = kindFilter ? { docKind: kindFilter } : {};
      // Le loteur de CETTE recherche (fabric F6) : sa mesure {logiques, physiques} est celle
      // de cette recherche-là, et elle est DITE dans la couverture — jamais affirmée.
      const noeudsEnLot = loteurNoeudsDrive();
      const contenu = await chercherContenu("drive", tokens, { limit: 15, docKind: kindFilter ?? null });
      const indexed = contenu.candidats.length === 0 ? [] : await prisma.driveTextIndex.findMany({
        where: { nodeId: { in: contenu.candidats.map((c) => c.id) } },
        select: { nodeId: true, text: true, note: true, docKind: true },
      });
      // L'ordre du RANG est conservé : `findMany(in:)` rend dans un ordre quelconque.
      const rangDe = new Map(contenu.candidats.map((c, i) => [c.id, i]));
      indexed.sort((a, b) => (rangDe.get(a.nodeId) ?? 99) - (rangDe.get(b.nodeId) ?? 99));
      const semanticByNode = new Map<string, number>();
      // L'ACL reste vérifiée nœud par nœud (jamais le contenu d'autrui) — en PARALLÈLE, et
      // les nœuds arrivent par le loteur : une vague, une requête (fabric F6).
      for (const { hit, node } of await hydraterCandidats(user, noeudsEnLot, indexed)) {
        const matchedInContent = countMatches(foldText(hit.text), tokens);
        const f = findings.get(hit.nodeId) ?? { nodeId: hit.nodeId, nom: node.name, matchedInName: countMatches(foldText(node.name), tokens), matchedInContent: 0, contentChecked: false };
        f.matchedInContent = Math.max(f.matchedInContent, matchedInContent);
        // Un candidat SÉMANTIQUE peut n'avoir AUCUN terme exact : son extrait est le début du
        // texte (le sens ne se surligne pas), et son score de similarité est porté à part.
        f.semScore = semanticByNode.get(hit.nodeId) ?? f.semScore;
        f.excerpt = f.excerpt ?? excerptAround(hit.text, tokens) ?? (f.semScore ? hit.text.slice(0, 180).trim() : undefined);
        f.contentChecked = true;
        f.note = hit.note;
        f.docKind = hit.docKind;
        findings.set(hit.nodeId, f);
      }

      /**
       * 2-ter) LIENS D'ENTITÉS (fabric F4) — LE FRANCHISSEMENT D'ALIAS.
       *
       * Si la requête nomme une entité CANONIQUE (« Keytruda », « pembrolizumab » — deux noms,
       * un seul produit), les documents LIÉS à cette entité par les mentions extraites à
       * l'ingestion deviennent des candidats — y compris ceux qui ne portent AUCUN terme de la
       * requête, parce qu'ils ne citent que l'autre nom. C'est le cas qu'aucune recherche
       * texte ne peut couvrir, et c'est exactement ce que le lien persistant achète.
       * L'ACL reste revérifiée nœud par nœud, comme partout.
       */
      const entitesResolues = await resoudreEntitesDe(query);
      for (const ent of entitesResolues.slice(0, 3)) {
        const lies = await documentsLies(ent.type, ent.id, { limit: 8 });
        if (lies.length === 0) continue;
        const rows = await prisma.driveTextIndex.findMany({
          where: { nodeId: { in: lies.map((l) => l.nodeId) }, ...kindWhere },
          select: { nodeId: true, text: true, note: true, docKind: true },
        });
        for (const { hit, node } of await hydraterCandidats(user, noeudsEnLot, rows)) {
          const f = findings.get(hit.nodeId) ?? { nodeId: hit.nodeId, nom: node.name, matchedInName: countMatches(foldText(node.name), tokens), matchedInContent: 0, contentChecked: false };
          f.matchedInContent = Math.max(f.matchedInContent, countMatches(foldText(hit.text), tokens));
          f.entiteLiee = f.entiteLiee ?? ent.label;
          f.excerpt = f.excerpt ?? excerptAround(hit.text, tokens) ?? hit.text.slice(0, 180).trim();
          f.contentChecked = true;
          f.note = hit.note;
          f.docKind = hit.docKind;
          findings.set(hit.nodeId, f);
        }
      }

      // 2-bis) NIVEAU SÉMANTIQUE (repli) — quand AUCUN candidat FORT par le contenu n'existe
      //    (un OR faible sur un mot banal ne suffit pas), les vecteurs cherchent par le SENS
      //    (« durée de conservation » ↔ « shelf life »). Jamais bloquant : sans clé / sans
      //    vecteurs → [], le lexical reste seul et la couverture le dit. L'ACL est revérifiée
      //    nœud par nœud, comme pour tout le reste.
      let semanticUsed = false;
      const needStrong = Math.min(tokens.length, 2);
      const hasStrongContent = [...findings.values()].some((f) => f.matchedInContent >= needStrong);
      if (!hasStrongContent) {
        const semanticHits = await driveSemanticCandidates(query, 6);
        if (semanticHits.length) {
          semanticUsed = true;
          for (const h of semanticHits) semanticByNode.set(h.nodeId, h.score);
          const rows = await prisma.driveTextIndex.findMany({
            where: { nodeId: { in: semanticHits.map((h) => h.nodeId) }, ...kindWhere },
            select: { nodeId: true, text: true, note: true, docKind: true },
          });
          for (const { hit, node } of await hydraterCandidats(user, noeudsEnLot, rows)) {
            const f = findings.get(hit.nodeId) ?? { nodeId: hit.nodeId, nom: node.name, matchedInName: countMatches(foldText(node.name), tokens), matchedInContent: 0, contentChecked: false };
            f.semScore = semanticByNode.get(hit.nodeId);
            f.matchedInContent = Math.max(f.matchedInContent, countMatches(foldText(hit.text), tokens));
            f.excerpt = f.excerpt ?? excerptAround(hit.text, tokens) ?? hit.text.slice(0, 180).trim();
            f.contentChecked = true;
            f.note = hit.note;
            f.docKind = hit.docKind;
            findings.set(hit.nodeId, f);
          }
        }
      }

      // 3) VÉRIFICATION par LECTURE des meilleurs candidats « nom seul » (bornée).
      const toVerify = [...findings.values()]
        .filter((f) => !f.contentChecked)
        .sort((a, b) => b.matchedInName - a.matchedInName)
        .slice(0, maxReads);
      let unreadable = 0;
      for (const f of toVerify) {
        if (!canViewDrive(await resolveDriveAccess(user, f.nodeId))) { findings.delete(f.nodeId); continue; }
        const t = await nodeText(f.nodeId);
        if (!t) { findings.delete(f.nodeId); continue; }
        f.contentChecked = true;
        f.note = t.note;
        if (t.text) {
          f.matchedInContent = countMatches(foldText(t.text), tokens);
          f.excerpt = excerptAround(t.text, tokens);
        } else {
          unreadable += 1;
        }
      }

      if (findings.size === 0) {
        const total = await prisma.driveTextIndex.count();
        // COUVERTURE EXPLICITE : « aucune trace » n'est prononçable qu'avec elle — et jamais
        // au-delà de ce qu'elle couvre réellement. Les CLÉS sont celles du cas plein (§118.20) :
        // `illisibles`, `indexTextuel` et `hydratation` existent aussi ici, à zéro et à null —
        // un plan qui les référence ne meurt pas le jour où la recherche ne trouve rien.
        return JSON.stringify({
          recherche: query,
          resultats: [],
          illisibles: 0,
          indexTextuel: `${total} fichier(s) du Drive indexés en texte — l'index s'enrichit à chaque lecture.`,
          couverture: {
            sourcesInterrogees: [
              "noms de fichiers du Drive (périmètre ACL)",
              `contenu des ${total} fichier(s) déjà indexés`,
              ...(semanticUsed ? ["similarité SÉMANTIQUE sur les fichiers vectorisés"] : []),
            ],
            sourcesRestantes: [
              "fichiers JAMAIS indexés (l'index grandit à chaque lecture et par l'ingestion planifiée)",
              ...(semanticUsed ? [] : ["similarité sémantique (aucun candidat / vecteurs ou clé indisponibles)"]),
              "recherche fédérée métier (search_everything)",
              "investigation d'événement (investigate_event)",
            ],
            hydratation: null,
          },
          rappel: `Aucun document pour « ${query} » dans les sources couvertes ci-dessus. NE PAS conclure « aucune trace » tout court : dire ce qui a été couvert, et interroger une source restante si elle est pertinente.`,
        });
      }

      // CONFIANCE : le CONTENU prime toujours sur le nom.
      const need = Math.min(tokens.length, 2);
      const ranked = [...findings.values()]
        .map((f) => {
          const confiance = f.matchedInContent >= need
            ? "HAUTE"
            : f.entiteLiee
              // Le document peut ne porter AUCUN terme de la requête : il est lié par
              // l'ENTITÉ (l'autre nom du même produit). C'est une preuve de LIEN, pas de
              // pertinence — le libellé le dit, et la lecture tranche.
              ? `ENTITÉ (lié à « ${f.entiteLiee} » — alias franchi par l'entité canonique)`
              : f.matchedInContent >= 1
                ? "MOYENNE"
                : f.semScore
                  ? "SENS (similarité sémantique — vérifier par lecture avant de citer)"
                  : "FAIBLE";
          return { ...f, confiance };
        })
        .sort((a, b) => (b.matchedInContent - a.matchedInContent)
          || ((b.entiteLiee ? 1 : 0) - (a.entiteLiee ? 1 : 0))
          || ((b.semScore ?? 0) - (a.semScore ?? 0)) || (b.matchedInName - a.matchedInName))
        .slice(0, 12);

      const total = await prisma.driveTextIndex.count();
      return JSON.stringify({
        recherche: query,
        resultats: ranked.map((f) => ({
          nom: f.nom,
          chemin: f.chemin,
          lien: `/drive/${f.nodeId}`,
          driveNodeId: f.nodeId,
          confiance: f.confiance,
          // `null`, jamais `undefined` : `JSON.stringify` efface une clé indéfinie, et un élément
          // de liste dont les clés changent d'un élément à l'autre est le défaut §118.20 un cran
          // plus bas — l'éventail déploie ces objets tels quels sur les étapes suivantes.
          typeDetecte: f.docKind && f.docKind !== "unknown" ? DOC_KIND_LABEL[f.docKind as DocKind] ?? f.docKind : null,
          preuve: f.excerpt ?? (f.confiance === "FAIBLE" ? "correspondance sur le NOM seulement — contenu non vérifiable" : null),
          termesDansContenu: `${f.matchedInContent}/${tokens.length}`,
          entiteLiee: f.entiteLiee ?? null,
          note: f.note ?? null,
        })),
        illisibles: unreadable,
        indexTextuel: `${total} fichier(s) du Drive indexés en texte — l'index s'enrichit à chaque lecture.`,
        couverture: {
          sourcesInterrogees: [
            "noms de fichiers du Drive (périmètre ACL)",
            "contenu des fichiers indexés",
            "liens d'entités canoniques (mentions extraites à l'ingestion — les alias se franchissent)",
            ...(semanticUsed ? ["similarité SÉMANTIQUE (repli — le lexical n'avait rien par le contenu)"] : []),
            "lecture de vérification bornée des meilleurs candidats",
          ],
          sourcesRestantes: [
            "fichiers JAMAIS indexés (l'index grandit à chaque lecture et par l'ingestion planifiée)",
            "recherche fédérée métier (search_everything)",
            "investigation d'événement (investigate_event)",
          ],
          // La mesure du LOT (fabric F6) : N hydratations logiques servies en K requêtes.
          // Dite, jamais affirmée — c'est le compteur du loteur de CETTE recherche.
          hydratation: (() => {
            const m = noeudsEnLot.mesure();
            return m.logiques > 0 ? `${m.logiques} candidat(s) hydratés en ${m.physiques} requête(s) (lot fabric)` : null;
          })(),
        },
        rappel: "Le nom d'un fichier est un INDICE, pas une preuve : ne conclure qu'à partir des résultats HAUTE/MOYENNE (contenu vérifié), et lire le document (read_document) avant d'en citer un chiffre.",
      });
    },
  },
];

export const KNOWLEDGE_TOOLS: PowerTool[] = [
  {
    def: {
      name: "search_documents",
      description:
        "CHERCHE DANS LE CONTENU des documents indexés (PDF, Word, Excel, présentations, courriels, scans) — "
        + "pas dans leurs titres. À utiliser pour « que dit le contrat sur… ? », « quelle est la clause de… ? », "
        + "« qu'y avait-il dans le courrier de l'ANPP ? », « quelle est la posologie indiquée dans la notice ? ». "
        + "Rend l'EXTRAIT exact avec sa page ou sa feuille, pour pouvoir citer. "
        + "Complémentaire de `search_everything`, qui trouve OÙ est rangé un document mais ne lit pas dedans : "
        + "si l'on cherche une phrase, une clause, un chiffre écrit dans un document, c'est CET outil.",
      input_schema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "La question en langage naturel, telle qu'elle a été posée — pas des mots-clés.",
          },
        },
        required: ["question"],
      },
    },
    // Aucun droit spécifique : la garde est APRÈS, document par document. Ouvrir l'outil ne
    // donne accès à rien — c'est `knowledgeAccessFor` qui décide, et il refuse par défaut.
    allowed: () => true,
    label: "Contenu des documents consulté",
    run: async (input, user) => {
      /**
       * ── UNE SEULE FORME, QUOI QU'IL ARRIVE (§118.20) ──────────────────────────────────
       *
       * Cet outil rendait une PHRASE dans trois cas (question trop courte, service indisponible,
       * aucun extrait) et un OBJET quand il trouvait. Un plan qui écrit `{{docs.extraits.0.ou}}`
       * meurt donc le jour où la recherche ne rend rien — et une étape morte coûte une
       * replanification entière. Les clés sont les mêmes partout ; c'est la liste `extraits`,
       * vide, qui dit l'absence, et `precision` qui dit POURQUOI elle est vide : « aucun
       * extrait » et « je n'ai pas cherché » se ressemblent pour qui lit la réponse, et ne se
       * corrigent pas de la même façon.
       */
      const repondre = (r: {
        question: string; examines: number;
        extraits?: { document: string | null; ou: string | null; extrait: string; pourquoi: readonly string[] }[];
        precision: string;
      }): string => JSON.stringify({ question: r.question, examines: r.examines, rendus: r.extraits?.length ?? 0, extraits: r.extraits ?? [], precision: r.precision });

      const question = typeof input.question === "string" ? input.question.trim() : "";
      if (question.length < 3) {
        return repondre({
          question, examines: 0,
          precision: "La liste est vide parce que la QUESTION n'a pas été fournie — donner la question telle qu'elle a été posée.",
        });
      }

      // PAR LE CONTRAT, PAS PAR L'INDEX. Adam demande « cherche dans les documents » ; il ne
      // sait pas qu'il existe un routeur, un index trigramme et un reclassement, et il n'a pas
      // à le savoir pour poser la question. C'est le test de frontière qui a imposé ce détour,
      // et il avait raison : brancher l'entonnoir en direct aurait ajouté une dépendance qu'une
      // ligne du contrat exprime mieux.
      const res = await inProcessPlatform
        .query(principalOf(user), { kind: "document.search", question, limit: 5 })
        .catch(sansBloquer("document-discovery.run.query", null));
      const r = res?.kind === "document.search" ? res : null;

      if (!r) {
        return repondre({
          question, examines: 0,
          precision: "La recherche documentaire est momentanément indisponible : la liste est vide parce que la SOURCE n'a pas répondu, "
            + "pas parce qu'aucun document ne correspond. Réessayer, ou passer par search_everything.",
        });
      }
      if (r.extracts.length === 0) {
        return repondre({
          question, examines: r.examined,
          precision: `Aucun extrait ne correspond, sur ${r.examined} document(s) examiné(s). `
            + "Le contenu n'est peut-être pas encore indexé, ou la personne n'y a pas accès.",
        });
      }

      return repondre({
        question,
        examines: r.examined,
        extraits: r.extracts.map((e: DocumentExtract) => ({ document: e.document, ou: e.at, extrait: e.text, pourquoi: e.because })),
        precision: `${r.extracts.length} extrait(s) rendus sur ${r.examined} document(s) examiné(s) — citer depuis l'extrait, pas depuis le titre.`,
      });
    },
  },
];
