import { prisma } from "@/lib/prisma";
import { proprietaire } from "@/platform/ia/proprietaire";
import { portsArtefact } from "@/platform/ia/artifact/ports";
import { demanderConversion } from "@/platform/ia/artifact/atelier/conversions";
import { composerDocx, MIME_DOCX, paragraphe, tableau, type Fragment } from "@/lib/artifact/factory/word";
import { construireClasseurVerifie } from "@/lib/artifact/sheets/build";
import { MIME_XLSX } from "@/lib/artifact/adapters/xlsx/adapter";
import type { DocumentLivrable } from "@/lib/missions/travaux/persona";
import type { FormatLivrable } from "@/lib/missions/travaux/plan";
import { analyserMarkdown, type MdBlock, type MdInline } from "../domaine/ui/markdown";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES LIVRABLES DES TRAVAUX (J8, décision 0023) — un VRAI document, pas seulement du Markdown au carnet.
 *
 * Le modèle rédige en Markdown (titres, paragraphes, listes, tableaux) ; ce module le met en forme avec la
 * fabrique (`composerDocx`, `construireClasseurVerifie`) et le DÉPOSE au Drive personnel de la personne, dossier
 * « Travaux », par le port du Live Office — qui l'inscrit à la Bibliothèque (J1). Le PDF passe par les
 * conversions de l'Atelier (J3) : LibreOffice du worker, ou la voie disponible ici — la voie est dite.
 *
 * LE NOM EST DÉTERMINISTE (titre + fin de l'identifiant du travail) : une reprise après un processus tué
 * pendant le dépôt RETROUVE le document au lieu d'en créer un second.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const DOSSIER_TRAVAUX = "Travaux";
const EXT: Record<Exclude<FormatLivrable, "md">, string> = { docx: "docx", pdf: "docx", xlsx: "xlsx" };

const enLigne = (xs: MdInline[], h: { gras?: boolean; italique?: boolean } = {}): Fragment[] => xs.flatMap((x): Fragment[] => {
  switch (x.t) {
    case "texte": return [{ texte: x.v, ...(h.gras ? { gras: true } : {}), ...(h.italique ? { italique: true } : {}) }];
    case "code": return [{ texte: x.v }];
    case "saut": return [{ texte: "\n" }];
    case "gras": return enLigne(x.c, { ...h, gras: true });
    case "italique": return enLigne(x.c, { ...h, italique: true });
    case "barre": return enLigne(x.c, h);
    case "lien": return enLigne(x.c, h);
  }
});
const brut = (xs: MdInline[]): string => enLigne(xs).map((f) => f.texte).join("");

/** Le Markdown du modèle → les blocs Word de la fabrique. */
export function blocsWord(md: string): string[] {
  const out: string[] = [];
  const poser = (blocs: MdBlock[], retrait = "") => {
    for (const b of blocs) {
      switch (b.t) {
        case "titre": out.push(paragraphe(enLigne(b.c), { style: b.niveau === 1 ? "Titre1" : "Titre2", garderAvecSuivant: true })); break;
        case "paragraphe": out.push(paragraphe(enLigne(b.c), { alignement: "both", apresPt: 6 })); break;
        case "liste":
          b.items.forEach((item, k) => {
            const [tete, ...reste] = item;
            const puce = b.ordonnee ? `${b.debut + k}.` : "•";
            out.push(paragraphe([{ texte: `${retrait}${puce}  ` }, ...(tete && (tete.t === "paragraphe" || tete.t === "titre") ? enLigne(tete.c) : [])], { apresPt: 2 }));
            poser(tete && tete.t !== "paragraphe" && tete.t !== "titre" ? item : reste, `${retrait}    `);
          });
          break;
        case "tableau": {
          const n = Math.max(1, b.entete.length);
          const largeur = Math.max(1.5, 16 / n);
          out.push(tableau([b.entete.map(brut), ...b.lignes.map((l) => Array.from({ length: n }, (_, j) => brut(l[j] ?? [])))], {
            colonnes: Array.from({ length: n }, () => ({ largeurCm: largeur })), entete: true,
          }));
          out.push(paragraphe("", { apresPt: 4 }));
          break;
        }
        case "code": out.push(paragraphe(b.v, { apresPt: 6 })); break;
        case "citation": poser(b.c, retrait); break;
        case "separateur": out.push(paragraphe("", { apresPt: 6 })); break;
      }
    }
  };
  poser(analyserMarkdown(md));
  return out;
}

const nombre = (v: string): number | string => {
  const t = v.replace(/[\s  ]/g, "").replace(/(DZD|DA|€|\$|%)$/i, "").replace(",", ".");
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : v;
};

/** Le Markdown → un classeur : une feuille par tableau (nombres en nombres) ; sans tableau, le texte ligne à ligne. */
export async function classeur(md: string, titre: string): Promise<Buffer> {
  const tables = analyserMarkdown(md).filter((b): b is Extract<MdBlock, { t: "tableau" }> => b.t === "tableau");
  const feuilles = tables.length
    ? tables.slice(0, 20).map((t, i) => {
      const colonnes = t.entete.map((c, j) => ({ cle: `c${j + 1}`, titre: brut(c) || `Colonne ${j + 1}` }));
      return { nom: `Tableau ${i + 1}`, colonnes, lignes: t.lignes.map((l) => Object.fromEntries(colonnes.map((c, j) => [c.cle, nombre(brut(l[j] ?? []))]))) };
    })
    : [{ nom: titre.slice(0, 28) || "Livrable", colonnes: [{ cle: "texte", titre: "Texte", largeur: 100 }], lignes: md.split("\n").filter((l) => l.trim()).map((l) => ({ texte: l })) }];
  return (await construireClasseurVerifie({ feuilles })).octets;
}

/** Le nom du fichier — le même d'un passage à l'autre pour CE livrable de CE travail. */
export const nomDuLivrable = (titre: string, travailId: string, format: Exclude<FormatLivrable, "md">) =>
  `${titre.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "Livrable"} (travail ${travailId.slice(-6)}).${EXT[format]}`;

export async function deposerLivrableTravail(principalId: string, d: {
  travailId: string; titre: string; contenu: string; format: FormatLivrable; reprise: boolean;
}): Promise<{ ok: true; document: DocumentLivrable } | { ok: false; erreur: string }> {
  if (d.format === "md") return { ok: false, erreur: "un livrable Markdown reste au carnet" };
  const user = await proprietaire(principalId);
  if (!user) return { ok: false, erreur: "le compte de la personne n'est plus actif" };
  const nom = nomDuLivrable(d.titre, d.travailId, d.format);
  const mime = d.format === "xlsx" ? MIME_XLSX : MIME_DOCX;

  // LA REPRISE : un dépôt interrompu a peut-être eu lieu — le document se retrouve par son nom, dans SON Drive.
  const existant = d.reprise
    ? await prisma.driveNode.findFirst({ where: { ownerId: principalId, name: nom, type: "FILE", isTrashed: false }, select: { id: true }, orderBy: { createdAt: "desc" } })
    : null;
  let nodeId = existant?.id ?? null;
  if (!nodeId) {
    const octets = d.format === "xlsx"
      ? await classeur(d.contenu, d.titre)
      : composerDocx({ blocs: [paragraphe(d.titre, { style: "Titre" }), ...blocsWord(d.contenu)], titre: d.titre, auteur: user.name ?? undefined }).octets;
    nodeId = (await portsArtefact.documents.creerFichier(principalId, { nom, octets, mime, dossier: DOSSIER_TRAVAUX })).nodeId;
  }
  const document: DocumentLivrable = { nodeId, nom, format: d.format === "pdf" ? "docx" : d.format, lien: `/drive/${nodeId}` };
  if (d.format !== "pdf") return { ok: true, document };

  // LE PDF : la conversion de l'Atelier, depuis le Word déposé — faite ici, ou confiée au worker (dit). Une reprise
  // retrouve le PDF déjà produit (même nom, extension changée) au lieu d'en convertir un second.
  const nomPdf = nom.replace(/\.docx$/, ".pdf");
  const pdf = existant ? await prisma.driveNode.findFirst({ where: { ownerId: principalId, name: nomPdf, type: "FILE", isTrashed: false }, select: { id: true } }) : null;
  if (pdf) return { ok: true, document: { nodeId: pdf.id, nom: nomPdf, format: "pdf", lien: `/drive/${pdf.id}` } };
  const c = await demanderConversion(user, nodeId, "PDF");
  if (!c.ok) return { ok: true, document: { ...document, note: `PDF non produit : ${c.motif ?? "conversion impossible"} — le Word est au Drive.` } };
  if (c.resultat) return { ok: true, document: { nodeId: c.resultat.nodeId, nom: c.resultat.nom, format: "pdf", lien: `/drive/${c.resultat.nodeId}`, note: c.note } };
  return { ok: true, document: { ...document, enFile: true, note: c.note ?? "PDF en file sur le worker" } };
}
