import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { portsArtefact } from "@/platform/ia/artifact/ports";
import { ouvrirOffice, type VueContenu } from "@/lib/actions/internes/primitives/office";
import { anomaliesClasseur, observerFeuille } from "../../domaine/primitives/observation";
import { observer, type Observation, type ValeurObservee } from "../../domaine/observation/contrat";
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

type Projection = Record<string, ValeurObservee | undefined>;

/**
 * La PROJECTION d'un contenu Office, à plat (le contrat d'I1 : textes, nombres, listes) : ce qui compte pour confronter le
 * livrable à la demande. Pour un classeur : la PREMIÈRE feuille en clair (colonnes, lignes, totaux), les autres résumées.
 */
export function projectionDe(vue: VueContenu): Projection {
  if (vue.kind === "XLSX") {
    const feuilles = vue.feuilles.map((f) => observerFeuille(f.nom, grille(f)));
    const p = feuilles[0];
    const anomalies = anomaliesClasseur(feuilles);
    return {
      format: "xlsx", feuille: p?.nom, colonnes: p?.colonnes.filter(Boolean), lignes: p?.lignes ?? 0,
      totaux: p?.totaux.length ? p.totaux.map((t) => `${t.libelle} : ${t.colonnes.join(", ")}`) : "aucun",
      anomalies: anomalies.length ? anomalies : "aucune",
      ...(feuilles.length > 1 ? { autresFeuilles: feuilles.slice(1).map((f) => `${f.nom} (${f.lignes} lignes)`) } : {}),
      apercu: p?.apercu.slice(0, 3).map((l) => l.filter(Boolean).join(" | ")),
    };
  }
  if (vue.kind === "DOCX") {
    const texte = vue.blocs.filter((b) => b.type === "paragraphe").map((b) => b.texte).filter(Boolean).join("\n");
    const tableaux = vue.blocs.filter((b) => b.type === "tableau");
    return {
      format: "docx", pages: vue.pages, paragraphes: vue.blocs.filter((b) => b.type === "paragraphe" && b.texte.trim()).length,
      tableaux: tableaux.length, entetesTableaux: tableaux.slice(0, 3).map((t) => (t.lignes[0] ?? []).join(" | ")),
      couleurs: [...new Set(vue.blocs.map((b) => b.style?.color).filter((c): c is string => typeof c === "string" && !!c))].slice(0, 8),
      texte: texte.slice(0, TEXTE_MAX),
    };
  }
  if (vue.kind === "PPTX") {
    return { format: "pptx", diapos: vue.diapos.length, titres: vue.diapos.map((d) => d.titre).slice(0, 12), texte: vue.diapos.flatMap((d) => d.formes.map((f) => f.texte)).join("\n").slice(0, TEXTE_MAX) };
  }
  return { format: "pdf", pages: vue.pages.length, texte: vue.pages.map((p) => p.apercu).join("\n").slice(0, TEXTE_MAX) };
}

/** L'objet observé : un fichier du Drive, son écran. */
export const fichierObserve = (id: string) => ({ type: "fichier_drive", id, lien: `/drive/${id}` });

/** OBSERVER des octets : la projection, ou l'échec (un fichier qui ne se rouvre pas est une observation, pas un silence). */
export async function observerOctets(id: string, etat: string, octets: Buffer, nom: string, mime: string | null, extra: Projection = {}): Promise<Observation> {
  if (/\.csv$/i.test(nom)) {
    const lignes = octets.toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
    return observer("fichier", fichierObserve(id), etat, { nom, format: "csv", colonnes: (lignes[0] ?? "").split(/[;,]/), lignes: Math.max(0, lignes.length - 1), ...extra });
  }
  const o = await ouvrirOffice(octets, nom, mime);
  if ("erreur" in o) return observer("fichier", fichierObserve(id), "ECHEC", { nom, erreur: o.erreur, octets: octets.length, ...extra });
  return observer("fichier", fichierObserve(id), etat, { nom, octets: octets.length, ...projectionDe(o.vue), ...extra });
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
  return observerOctets(p.id, "LU", octets, fiche.nom, fiche.mime, { version: fiche.version, versions });
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
      return JSON.stringify("erreur" in o ? { statut: "REFUS", raison: o.erreur } : { statut: "OBSERVE", observation: o, _observations: [o] });
    },
  };
}
