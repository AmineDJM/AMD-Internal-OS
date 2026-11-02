import type { PowerTool } from "@/platform/ia/outil";
import { inProcessPlatform, principalOf } from "@/platform/in-process/adapter";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MONTRER — le geste qui manquait.
 *
 * ── CE QUE LE PDG A DEMANDÉ, ET CE QU'IL A OBTENU ────────────────────────────────────────
 *
 *   PDG   — Attendss deja exporte les dossiers regulatory
 *   Adam  — [fichier produit]
 *   PDG   — Montre le moi ici
 *   Adam  — Je ne peux pas afficher un fichier Excel.
 *
 * C'était faux. Le fichier était dans le Drive, derrière une route qui sait le servir, et le
 * serveur a de quoi le lire. Ce qui manquait n'était ni un droit ni un format : c'était un
 * OUTIL POUR MONTRER. `read_document` extrait du TEXTE — pour que le modèle résume, cite,
 * retrouve une clause. Personne ne lui avait donné de quoi mettre un document SOUS LES YEUX.
 *
 * ── LIRE ET MONTRER SONT DEUX QUESTIONS ──────────────────────────────────────────────────
 *
 *   `read_document` répond à « que dit ce contrat ? »  → du texte, pour le modèle.
 *   `show_document` répond à « montre-moi ce contrat » → un bloc, pour l'humain.
 *
 * Les confondre, c'est soit recracher quarante pages dans une conversation, soit refuser
 * d'afficher un PDF. Les deux sont arrivés.
 *
 * ── POURQUOI CE FICHIER NE TOUCHE NI LA BASE NI LE STOCKAGE ──────────────────────────────
 *
 * Ouvrir un fichier demande Prisma, le stockage, les droits du Drive ET ceux du dossier
 * porteur : écrit ici, cet outil aurait franchi la frontière Adam ↔ ERP sept fois, et le
 * cliquet de `boundary.test.ts` l'aurait signalé — à raison.
 *
 * Il passe donc par le CONTRAT (`document.show`). C'est la première lecture non-personne à
 * l'emprunter, et elle prouve ce que la frontière promettait : l'ERP ouvre le fichier et rend
 * une VUE ; Adam ne reçoit qu'un nom, un lien interne et, pour un tableur, ses lignes déjà lues.
 * Le jour où Adam devient un service à part, ce fichier ne change pas d'une ligne.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const str = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === "string" ? (input[key] as string).trim() : "";

const strings = (input: Record<string, unknown>, key: string): string[] => {
  const v = input[key];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
  // Le modèle écrit parfois « référence, produit, statut » d'un seul tenant : on l'accepte.
  if (typeof v === "string") return v.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  return [];
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « FAIS-MOI UN TABLEAU COMME JE VEUX » — et la ligne à ne pas franchir.
 *
 * LE BESOIN. « Montre les dossiers les plus avancés — dans un tableau », puis « avec la date de
 * dépôt et le responsable », puis « trie par échéance ». Un tableau figé répond à la première
 * demande et à aucune des deux autres.
 *
 * LA LIGNE. Le modèle choisit la VUE — quelle lecture, quelles colonnes, quel tri. Il ne fournit
 * JAMAIS le CONTENU : les lignes sont relues à la source canonique par le serveur, à l'instant
 * de l'affichage. C'est ce qui garantit qu'aucun chiffre affiché ne vient d'une paraphrase, et
 * c'est la seule raison pour laquelle on peut se permettre de laisser le modèle composer.
 *
 * LES SOURCES SONT FERMÉES. Une source absente de cette table ne compose rien — même règle que
 * `workspace/compose.ts`, et pour la même raison : un affichage capable de tout montrer finit
 * par tout montrer.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export const TABLE_SOURCES: Record<string, { tool: string; keys: readonly string[]; titre: string; args?: readonly string[] }> = {
  dossiers_regulatory: { tool: "regulatory_portfolio", keys: ["dossiers"], titre: "Dossiers Regulatory", args: ["partner"] },
  charge_regulatory: { tool: "regulatory_workload", keys: ["repartition"], titre: "Charge Regulatory", args: ["person"] },
  courriers: { tool: "search_courriers", keys: [], titre: "Courriers", args: ["query", "direction", "month"] },
  budget: { tool: "read_budget", keys: ["postes", "parEnveloppe"], titre: "Budget", args: ["envelope"] },
  effectif: { tool: "read_hr_overview", keys: ["parEntite", "parDepartement"], titre: "Effectif", args: ["entite"] },
  decisions: { tool: "list_pending_decisions", keys: ["elements"], titre: "En attente de votre décision", args: ["limit"] },
  annuaire: { tool: "directory_list", keys: ["salaries"], titre: "Annuaire", args: ["department"] },
};

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");

/** Les lignes d'une sortie d'outil : un tableau nu, ou le premier tableau sous une clé connue. */
export function rowsOf(raw: string, keys: readonly string[]): Record<string, unknown>[] {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return []; }
  if (Array.isArray(data)) return data.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null);
  if (typeof data !== "object" || data === null) return [];
  for (const k of keys) {
    const v = (data as Record<string, unknown>)[k];
    if (Array.isArray(v)) return v.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null);
  }
  return [];
}

export const SHOW_TOOLS: PowerTool[] = [
  {
    def: {
      name: "show_document",
      description:
        "AFFICHE un document DANS la conversation, sous les yeux de l'utilisateur : PDF et contrats dans une visionneuse, images en aperçu, "
        + "classeurs Excel et CSV rendus en TABLEAU lisible (utile pour relire un export AVANT de l'envoyer). "
        + "Trois portes : `driveNodeId` (fichier du Drive, via search_drive / list_artifacts), `documentId` (pièce jointe d'un dossier, via inspect_record), "
        + "ou `nom` (on cherche le fichier dans le Drive visible). "
        + "À utiliser dès qu'on dit « montre-moi », « affiche », « fais voir », « montre le moi ici », « je veux le voir avant de l'envoyer ». "
        + "⚠️ Ne réponds JAMAIS « je ne peux pas afficher ce fichier » sans avoir appelé cet outil. "
        + "Pour LIRE le contenu et le résumer, c'est `read_document` — celui-ci MONTRE.",
      input_schema: {
        type: "object",
        properties: {
          driveNodeId: { type: "string", description: "Identifiant d'un fichier du Drive." },
          documentId: { type: "string", description: "Identifiant d'une pièce jointe (table Document)." },
          nom: { type: "string", description: "Mots du nom du fichier, si l'identifiant est inconnu." },
        },
      },
    },
    // Le droit d'AFFICHER est celui du DOCUMENT, jugé pièce par pièce par la plateforme. Exiger
    // ici un droit global en plus serait un second cloisonnement, différent de celui des écrans —
    // donc une règle de plus à maintenir, et une occasion de plus de diverger.
    allowed: () => true,
    label: "Document affiché",
    run: async (input, user) => {
      const res = await inProcessPlatform.query(principalOf(user), {
        kind: "document.show",
        ...(str(input, "driveNodeId") ? { driveNodeId: str(input, "driveNodeId") } : {}),
        ...(str(input, "documentId") ? { documentId: str(input, "documentId") } : {}),
        ...(str(input, "nom") ? { name: str(input, "nom") } : {}),
      });
      if (res.kind !== "document.show") return "Lecture inattendue.";
      // UN REFUS SE DIT, il ne se traduit pas en « rien trouvé ». « Ce fichier ne vous est pas
      // ouvert » et « aucun fichier de ce nom » appellent deux réactions différentes.
      if (!res.document) return res.refusal ?? "Document indisponible.";

      const d = res.document;
      // Ce que le MODÈLE lit reste court — il n'a pas besoin du contenu pour dire « le voici » —
      // et `_blocs` porte ce que l'ÉCRAN affiche.
      return JSON.stringify({
        affiche: d.name,
        format: d.kind,
        ...(d.sheet ? { lignesDansLeFichier: d.sheet.total } : {}),
        _blocs: [{
          kind: "document",
          title: d.sheet ? "Aperçu du fichier" : "Document",
          docs: [{
            nom: d.name, href: d.href, type: d.kind,
            ...(d.subtitle ? { soustitre: d.subtitle } : {}),
            ...(d.size ? { taille: d.size } : {}),
            ...(d.sheet ? { feuille: d.sheet } : {}),
          }],
          ...(d.kind === "feuille" && !d.sheet
            ? { note: "Le contenu de ce classeur n'a pas pu être lu — le fichier reste téléchargeable." }
            : {}),
        }],
      });
    },
  },

  {
    def: {
      name: "show_table",
      description:
        "COMPOSE un tableau À LA DEMANDE à partir d'une lecture canonique, avec les colonnes et le tri voulus. "
        + "À utiliser quand on dit « dans un tableau », « en tableau avec la date et le responsable », « trie par échéance », "
        + "« ajoute une colonne », « juste le nom et le statut ». "
        + "Sources : dossiers_regulatory (partner), charge_regulatory (person), courriers (query/direction/month), "
        + "budget (envelope), effectif (entite), decisions, annuaire (department). "
        + "Les LIGNES sont relues à la source au moment de l'affichage — tu choisis la VUE, jamais le contenu. "
        + "Sans `colonnes`, les colonnes les plus partagées sont retenues. Appelle d'abord la lecture correspondante "
        + "si tu veux connaître les noms de colonnes disponibles : ils sont rendus dans la réponse.",
      input_schema: {
        type: "object",
        properties: {
          source: { type: "string", description: "dossiers_regulatory | charge_regulatory | courriers | budget | effectif | decisions | annuaire" },
          colonnes: { type: "array", items: { type: "string" }, description: "Colonnes voulues, dans l'ordre (noms approximatifs acceptés). Omettre pour un choix automatique." },
          tri: { type: "string", description: "Colonne de tri." },
          ordre: { type: "string", description: "asc (défaut) ou desc." },
          limite: { type: "number", description: "Nombre de lignes (défaut 25, max 50)." },
          titre: { type: "string", description: "Titre du tableau, si celui par défaut ne convient pas." },
          partner: { type: "string" }, person: { type: "string" }, query: { type: "string" },
          direction: { type: "string" }, month: { type: "string" }, envelope: { type: "string" },
          entite: { type: "string" }, department: { type: "string" }, limit: { type: "number" },
        },
        required: ["source"],
      },
    },
    // Aucun droit propre : la SOURCE porte le sien, et `executePowerTool` le revérifie à
    // l'exécution. Poser un garde ici en dupliquerait un autre, avec le risque de diverger.
    allowed: () => true,
    label: "Tableau composé",
    run: async (input, user) => {
      const key = fold(str(input, "source"));
      const src = Object.entries(TABLE_SOURCES).find(([k]) => fold(k) === key)?.[1];
      if (!src) return `Source inconnue. Sources disponibles : ${Object.keys(TABLE_SOURCES).join(", ")}.`;

      // Import PARESSEUX : `power-tools` importe ce fichier, un import statique ferait un cycle.
      const { executePowerTool } = await import("@/lib/assistant/power-tools");
      const args: Record<string, unknown> = {};
      for (const a of src.args ?? []) if (input[a] !== undefined) args[a] = input[a];
      const raw = await executePowerTool(src.tool, args, user);
      // `null` = outil inconnu ; une chaîne non-JSON = refus de droit ou réponse en clair.
      if (raw === null) return "Cette lecture n'est pas disponible.";
      const rows = rowsOf(raw, src.keys);
      if (rows.length === 0) return raw;

      // LES COLONNES DISPONIBLES sont celles que les lignes portent réellement.
      const counts = new Map<string, number>();
      for (const r of rows) for (const k of Object.keys(r)) counts.set(k, (counts.get(k) ?? 0) + 1);
      const available = [...counts.keys()].filter((k) => !["id", "lien", "href", "url"].includes(k));

      // CE QUE LE PDG A DEMANDÉ, rapproché de ce qui existe — « date de dépôt » → `dateDepot`.
      const wanted = strings(input, "colonnes");
      let keys = wanted
        .map((w) => available.find((k) => fold(k) === fold(w)) ?? available.find((k) => fold(k).includes(fold(w)) || fold(w).includes(fold(k))))
        .filter((k): k is string => Boolean(k));
      const unknown = wanted.filter((w) => !available.some((k) => fold(k) === fold(w) || fold(k).includes(fold(w)) || fold(w).includes(fold(k))));
      if (keys.length === 0) {
        // Choix automatique : les clés que PARTAGE la majorité des lignes.
        keys = available.filter((k) => (counts.get(k) ?? 0) >= rows.length * 0.6).slice(0, 6);
      }
      if (keys.length === 0) return raw;

      const triKey = str(input, "tri")
        ? available.find((k) => fold(k) === fold(str(input, "tri"))) ?? available.find((k) => fold(k).includes(fold(str(input, "tri"))))
        : undefined;
      const desc = fold(str(input, "ordre")) === "desc";
      const cell = (r: Record<string, unknown>, k: string): string => {
        const v = r[k];
        if (v === null || v === undefined) return "—";
        if (typeof v === "boolean") return v ? "oui" : "non";
        if (typeof v === "object") return "—";
        return String(v);
      };
      const sorted = triKey
        ? [...rows].sort((a, b) => {
            const av = a[triKey]; const bv = b[triKey];
            const n = typeof av === "number" && typeof bv === "number" ? av - bv : cell(a, triKey).localeCompare(cell(b, triKey), "fr");
            return desc ? -n : n;
          })
        : rows;

      const limite = Math.max(1, Math.min(50, typeof input.limite === "number" ? Math.round(input.limite) : 25));
      const shown = sorted.slice(0, limite);
      const humanize = (k: string) => k.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/\s+/).map((w, i) => (w.length > 1 && w === w.toUpperCase() ? w : i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w.toLowerCase()))
        .join(" ");

      return JSON.stringify({
        source: src.tool,
        colonnesDisponibles: available,
        ...(unknown.length ? { colonnesIntrouvables: unknown } : {}),
        lignes: rows.length,
        _blocs: [{
          kind: "table",
          title: str(input, "titre") || src.titre,
          columns: keys.map((k) => ({
            key: k, label: humanize(k),
            numeric: shown.every((r) => r[k] === undefined || typeof r[k] === "number"),
          })),
          rows: shown.map((r) => {
            const line: Record<string, string> = {};
            for (const k of keys) line[k] = cell(r, k);
            return line;
          }),
          total: rows.length,
        }],
      });
    },
  },
];
