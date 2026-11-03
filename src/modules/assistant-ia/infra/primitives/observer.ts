import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { portsArtefact } from "@/platform/ia/artifact/ports";
import { ouvrirOffice, type VueContenu } from "@/lib/actions/internes/primitives/office";
import { anomaliesClasseur, observationDe, observerFeuille, type FeuilleObservee, type Observation } from "../../domaine/primitives/observation";
import { resoudrePiece } from "../operations/pieces";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT I3 — `observer` côté FICHIER (décision 0065, AU2 §6.1 (f)) : ce que la personne verra, RELU depuis le fichier écrit.
 *
 * Le code rouvre les octets par l'adaptateur de l'Atelier (Word, Excel, PowerPoint, PDF) et en tire la vue de l'écran :
 * feuilles, colonnes, lignes, totaux (et ceux qui additionnent un téléphone), texte, tableaux. Jamais le modèle.
 * `produire` et `fichier` la rendent à chaque appel ; l'outil `observer` la relit seul (« relis ce que tu as fait »).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const OUTIL_OBSERVER = "observer";
const TEXTE_MAX = 900;

/** Une feuille de la vue Excel, remise en grille (lignes × colonnes) pour l'observer. */
function grille(f: Extract<VueContenu, { kind: "XLSX" }>["feuilles"][number]): string[][] {
  const g: string[][] = [];
  for (const c of f.cellules) {
    (g[c.row - 1] ??= [])[c.col - 1] = c.formule ? `=${c.formule}` : c.valeur;
  }
  return Array.from({ length: g.length }, (_, i) => Array.from({ length: Math.max(0, ...g.map((l) => l?.length ?? 0)) }, (_, j) => g[i]?.[j] ?? ""));
}

/** La PROJECTION d'un contenu Office : ce qui compte pour confronter le livrable à la demande. */
export function projectionDe(vue: VueContenu): Record<string, unknown> {
  if (vue.kind === "XLSX") {
    const feuilles: FeuilleObservee[] = vue.feuilles.map((f) => observerFeuille(f.nom, grille(f)));
    const anomalies = anomaliesClasseur(feuilles);
    return { format: "xlsx", feuilles: feuilles.map((f) => ({ ...f, apercu: f.apercu.slice(0, 3) })), ...(anomalies.length ? { anomalies } : { anomalies: "aucune" }) };
  }
  if (vue.kind === "DOCX") {
    const texte = vue.blocs.filter((b) => b.type === "paragraphe").map((b) => b.texte).filter(Boolean).join("\n");
    const tableaux = vue.blocs.filter((b) => b.type === "tableau");
    return {
      format: "docx", pages: vue.pages, paragraphes: vue.blocs.filter((b) => b.type === "paragraphe" && b.texte.trim()).length,
      tableaux: tableaux.length, tableauxApercu: tableaux.slice(0, 2).map((t) => t.lignes.slice(0, 3)),
      couleurs: [...new Set(vue.blocs.map((b) => b.style?.color).filter((c): c is string => typeof c === "string" && !!c))].slice(0, 8),
      texte: texte.slice(0, TEXTE_MAX), ...(texte.length > TEXTE_MAX ? { texteTronque: true } : {}),
    };
  }
  if (vue.kind === "PPTX") {
    return { format: "pptx", diapos: vue.diapos.length, titres: vue.diapos.map((d) => d.titre).slice(0, 20), texte: vue.diapos.flatMap((d) => d.formes.map((f) => f.texte)).join("\n").slice(0, TEXTE_MAX) };
  }
  const texte = vue.pages.map((p) => p.apercu).join("\n");
  return { format: "pdf", pages: vue.pages.length, texte: texte.slice(0, TEXTE_MAX) };
}

/** OBSERVER des octets : la projection, ou l'échec (un fichier qui ne se rouvre pas est une observation, pas un silence). */
export async function observerOctets(objet: { type: string; id: string; lien: string | null }, etat: string, octets: Buffer, nom: string, mime: string | null, extra: Record<string, unknown> = {}): Promise<Observation> {
  if (/\.csv$/i.test(nom)) {
    const lignes = octets.toString("utf8").split(/\r?\n/).filter(Boolean);
    return observationDe(objet, etat, { format: "csv", colonnes: (lignes[0] ?? "").split(/[;,]/), lignes: Math.max(0, lignes.length - 1), ...extra });
  }
  const o = await ouvrirOffice(octets, nom, mime);
  if ("erreur" in o) return observationDe(objet, "ILLISIBLE", { erreur: o.erreur, octets: octets.length, ...extra });
  return observationDe(objet, etat, { nom, octets: octets.length, ...projectionDe(o.vue), ...extra });
}

/** Le TEXTE intégral d'un fichier Office (paragraphes, cellules, diapositives, pages) — pour vérifier un remplacement. */
export async function texteIntegral(octets: Buffer, nom: string, mime: string | null): Promise<string> {
  const o = await ouvrirOffice(octets, nom, mime);
  if ("erreur" in o) return "";
  const v = o.vue;
  if (v.kind === "DOCX") return v.blocs.map((b) => [b.texte, ...b.lignes.flat()].join("\n")).join("\n");
  if (v.kind === "XLSX") return v.feuilles.flatMap((f) => f.cellules.map((c) => c.valeur)).join("\n");
  if (v.kind === "PPTX") return v.diapos.flatMap((d) => d.formes.map((f) => f.texte)).join("\n");
  return v.pages.map((p) => p.apercu).join("\n");
}

/** Observer un fichier du Drive que la personne voit (dernière version). */
export async function observerFichier(u: CurrentUser, ref: string): Promise<Observation | { erreur: string }> {
  const p = await resoudrePiece(u, ref);
  if ("erreur" in p) return p;
  const fiche = await portsArtefact.documents.decrire(u.id, p.id);
  if (!fiche) return { erreur: "Ce fichier ne vous est pas accessible." };
  const octets = await portsArtefact.documents.lire(u.id, p.id, fiche.version);
  if (!octets) return { erreur: "Le contenu du fichier n'a pas pu être lu." };
  const versions = await prisma.fileVersion.count({ where: { nodeId: p.id } });
  return observerOctets({ type: "fichier", id: p.id, lien: `/drive/${p.id}` }, `VERSION_${fiche.version}`, octets, fiche.nom, fiche.mime, { versions });
}

export function outilObserver(user: CurrentUser): PowerTool {
  return {
    def: {
      name: OUTIL_OBSERVER,
      description: "OBSERVE un fichier du Drive tel que la personne le verra (dernière version) : feuilles, colonnes, nombre de lignes, totaux (et ceux qui "
        + "additionnent une colonne qui ne s'additionne pas), texte, tableaux, pages, nombre de versions. Pour vérifier un livrable avant de dire qu'il est fait.",
      input_schema: { type: "object", properties: { fichier: { type: "string", description: "Nom ou identifiant Drive du fichier." } }, required: ["fichier"] },
    },
    allowed: (u) => u.id === user.id,
    label: "Fichier observé",
    run: async (e, u) => {
      const ref = typeof e.fichier === "string" ? e.fichier : "";
      const o = await observerFichier(u, ref);
      return JSON.stringify("erreur" in o ? { statut: "REFUS", raison: o.erreur } : { statut: "OBSERVE", observation: o });
    },
  };
}
