import { prisma } from "@/lib/prisma";
import { proprietaire } from "@/platform/ia/proprietaire";
import { portsArtefact } from "@/platform/ia/artifact/ports";
import { demanderConversion } from "@/platform/ia/artifact/atelier/conversions";
import { construireClasseurDrive } from "@/platform/ia/artifact/sheets";
import type { DocumentLivrable, FormatLivrable } from "./travaux";
import { composerNoteMarkdown, texteEnLigne } from "./operations/document-modele";
import { analyserMarkdown, type MdBlock } from "../domaine/ui/markdown";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES LIVRABLES DES TRAVAUX (J8, décision 0023) — un VRAI document, pas seulement du Markdown au carnet.
 *
 * Le modèle rédige en Markdown (titres, paragraphes, listes, tableaux) ; ce module le met en forme avec la
 * fabrique (`composerDocx`, `construireClasseurVerifie`) et le DÉPOSE au Drive personnel de la personne, dossier
 * « Travaux », par le port du Live Office — qui l'inscrit à la Bibliothèque (J1) ; la mise en forme Word est celle
 * de `preparer_document` (`operations/document-modele.ts`), le classeur celui, vérifié, du socle. Le PDF passe par les
 * conversions de l'Atelier (J3) : LibreOffice du worker, ou la voie disponible ici — la voie est dite.
 *
 * LE NOM EST DÉTERMINISTE (titre + fin de l'identifiant du travail) : une reprise après un processus tué
 * pendant le dépôt RETROUVE le document au lieu d'en créer un second.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const DOSSIER_TRAVAUX = "Travaux";
const EXT: Record<Exclude<FormatLivrable, "md">, string> = { docx: "docx", pdf: "docx", xlsx: "xlsx" };

const nombre = (v: string): number | string => {
  const t = v.replace(/[\s  ]/g, "").replace(/(DZD|DA|€|\$|%)$/i, "").replace(",", ".");
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : v;
};

type SpecClasseur = Parameters<typeof construireClasseurDrive>[1]["spec"];
const brut = texteEnLigne;

/** Le Markdown → la spécification d'un classeur : une feuille par tableau (nombres en nombres) ; sans tableau, le texte ligne à ligne. */
export function classeur(md: string, titre: string): SpecClasseur {
  const tables = analyserMarkdown(md).filter((b): b is Extract<MdBlock, { t: "tableau" }> => b.t === "tableau");
  const feuilles = tables.length
    ? tables.slice(0, 20).map((t, i) => {
      const colonnes = t.entete.map((c, j) => ({ cle: `c${j + 1}`, titre: brut(c) || `Colonne ${j + 1}` }));
      return { nom: `Tableau ${i + 1}`, colonnes, lignes: t.lignes.map((l) => Object.fromEntries(colonnes.map((c, j) => [c.cle, nombre(brut(l[j] ?? []))]))) };
    })
    : [{ nom: titre.slice(0, 28) || "Livrable", colonnes: [{ cle: "texte", titre: "Texte", largeur: 100 }], lignes: md.split("\n").filter((l) => l.trim()).map((l) => ({ texte: l })) }];
  return { feuilles };
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

  // LA REPRISE : un dépôt interrompu a peut-être eu lieu — le document se retrouve par son nom, dans SON Drive.
  const existant = d.reprise
    ? await prisma.driveNode.findFirst({ where: { ownerId: principalId, name: nom, type: "FILE", isTrashed: false }, select: { id: true }, orderBy: { createdAt: "desc" } })
    : null;
  let nodeId = existant?.id ?? null;
  if (!nodeId && d.format === "xlsx") {
    // Le classeur VÉRIFIÉ du socle (formules, constats) — écrit au Drive, inscrit à la Bibliothèque, ou rien.
    const c = await construireClasseurDrive(user, { nom, spec: classeur(d.contenu, d.titre), dossier: DOSSIER_TRAVAUX });
    if (!c.ok) return { ok: false, erreur: c.motif };
    nodeId = c.nodeId;
  } else if (!nodeId) {
    const { octets, mime } = composerNoteMarkdown(d.titre, d.contenu, user.name ?? undefined);
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
