import { prisma } from "@/lib/prisma";
import { proprietaire } from "@/platform/ia/proprietaire";
import { portsArtefact } from "@/platform/ia/artifact/ports";
import { demanderConversion } from "@/platform/ia/artifact/atelier/conversions";
import { construireClasseurDrive } from "@/platform/ia/artifact/sheets";
import type { DocumentLivrable, FormatLivrable, LectureRendue } from "./travaux";
import { composerNoteMarkdown } from "./operations/document-modele";
import { tableauxDe } from "../domaine/analyse/jeux";
import { limitesDuJeu, verificationDe } from "../domaine/primitives/tables";
import { controlerLivrable, observerLecture } from "../domaine/observation/controle";
import { celluleLisible } from "./primitives/produire";

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

type SpecClasseur = Parameters<typeof construireClasseurDrive>[1]["spec"];

/** Le nom du fichier — le même d'un passage à l'autre pour CE livrable de CE travail. */
export const nomDuLivrable = (titre: string, travailId: string, format: Exclude<FormatLivrable, "md">) =>
  `${titre.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "Livrable"} (travail ${travailId.slice(-6)}).${EXT[format]}`;

const vide = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** Les JEUX qu'ont rendus les étapes LECTURE : chaque sortie tabulaire (`lignes` de `lire`, ou le plus grand tableau d'une lecture). */
function jeuxLus(lectures: readonly LectureRendue[]): { titre: string; lignes: Record<string, unknown>[]; colonnes: string[]; filtres: string[] }[] {
  return lectures.filter((l) => l.statut === "DONE").flatMap((l) => {
    const o = (l.sortie ?? {}) as { lignes?: unknown; colonnes?: unknown; filtresAppliques?: unknown };
    const lignes = Array.isArray(o.lignes) ? (o.lignes as Record<string, unknown>[]) : tableauxDe(JSON.stringify(l.sortie ?? null))[0]?.lignes ?? [];
    if (!lignes.length) return [];
    const colonnes = Array.isArray(o.colonnes) ? (o.colonnes as string[]) : [...new Set(lignes.slice(0, 20).flatMap((x) => Object.keys(x)))];
    return [{ titre: l.titre, lignes, colonnes: colonnes.filter((c) => c !== "id"), filtres: Array.isArray(o.filtresAppliques) ? (o.filtresAppliques as string[]) : [] }];
  });
}

/**
 * I4 (décision 0067) — LE TABLEUR VIENT DES DONNÉES : une feuille par jeu lu (chaque ligne lue, sa colonne SOURCE = le lien de sa
 * fiche, sa colonne VÉRIFICATION = à jour / ancienne / incomplète), puis une feuille « Synthèse » : ce que le modèle a écrit, et
 * les LIMITES CALCULÉES (colonnes vides, dates de mise à jour) — le modèle n'écrit ni une ligne de données ni une limite.
 */
export function classeurDesLectures(jeux: ReturnType<typeof jeuxLus>, synthese: string, maintenant = new Date()): SpecClasseur {
  const feuilles = jeux.slice(0, 10).map((j, i) => {
    // Une colonne vide sur TOUT le jeu n'est pas une fiche incomplète : c'est une colonne que personne ne tient — elle sort.
    const donnees = j.colonnes.filter((c) => c !== "lien" && c !== "majLe" && j.lignes.some((l) => !vide(l[c])));
    const colonnes = [...donnees, ...(j.colonnes.includes("majLe") ? ["majLe"] : []), "source", "verification"].map((c) => ({ cle: c, titre: c === "source" ? "Source (fiche)" : c === "verification" ? "Vérification" : c === "majLe" ? "Mise à jour" : c }));
    return {
      nom: `${i + 1}. ${j.titre}`.replace(/[\\/?*[\]:]/g, "-").slice(0, 28),
      colonnes,
      lignes: j.lignes.map((l) => ({
        ...Object.fromEntries(donnees.map((c) => [c, celluleLisible(l[c])])), majLe: celluleLisible(l.majLe),
        source: typeof l.lien === "string" ? l.lien : "", verification: verificationDe(l, donnees, j.colonnes.includes("majLe") ? "majLe" : null, maintenant),
      })),
    };
  });
  const limites = jeux.flatMap((j) => limitesDuJeu(j.lignes, j.colonnes.filter((c) => c !== "lien" && j.lignes.some((l) => !vide(l[c]))), j.colonnes.includes("majLe") ? "majLe" : null, maintenant).map((t) => `${j.titre} — ${t}`));
  const texte = [
    // Une ligne de TABLEAU dans la synthèse n'est pas reprise : les lignes du tableur viennent des données, pas du texte.
    ...synthese.split("\n").filter((l) => !l.trim().startsWith("|")).map((l) => l.replace(/^\s*#+\s*|\*\*|__|`/g, "").replace(/^\s*[-*]\s+/, "• ").trim()).filter(Boolean),
    "", "LIMITES (calculées par le serveur sur les lignes lues)", ...limites,
    "", "SOURCES", ...jeux.map((j) => `${j.titre} : ${j.lignes.length} ligne(s)${j.filtres.length ? ` — ${j.filtres.join(" · ")}` : ""}`),
  ];
  return { feuilles: [...feuilles, { nom: "Synthèse", colonnes: [{ cle: "texte", titre: "Synthèse et limites", largeur: 110 }], lignes: texte.map((t) => ({ texte: t })) }] };
}

export async function deposerLivrableTravail(principalId: string, d: {
  travailId: string; titre: string; contenu: string; format: FormatLivrable; reprise: boolean; lectures?: readonly LectureRendue[];
}): Promise<{ ok: true; document: DocumentLivrable } | { ok: false; erreur: string; definitif?: boolean }> {
  if (d.format === "md") return { ok: false, erreur: "un livrable Markdown reste au carnet" };
  // I4 — LE CONTRÔLE FINAL : aucune ligne issue d'une lecture réussie → ÉCHEC nommé, jamais « livré » (contrat Observation d'I1).
  const lectures = d.lectures ?? [];
  const jeux = jeuxLus(lectures);
  const verdict = controlerLivrable(lectures.map((l) => observerLecture(l)), { format: d.format, lignes: jeux.reduce((n, j) => n + j.lignes.length, 0) });
  if (!verdict.ok) return { ok: false, erreur: verdict.raison, definitif: true };
  const user = await proprietaire(principalId);
  if (!user) return { ok: false, erreur: "le compte de la personne n'est plus actif" };
  const nom = nomDuLivrable(d.titre, d.travailId, d.format);

  // LA REPRISE : un dépôt interrompu a peut-être eu lieu — le document se retrouve par son nom, dans SON Drive.
  const existant = d.reprise
    ? await prisma.driveNode.findFirst({ where: { ownerId: principalId, name: nom, type: "FILE", isTrashed: false }, select: { id: true }, orderBy: { createdAt: "desc" } })
    : null;
  let nodeId = existant?.id ?? null;
  if (!nodeId && d.format === "xlsx") {
    // Le classeur VÉRIFIÉ du socle, construit DEPUIS les lignes lues (le contrôle final a garanti qu'il y en a) — I4 : un
    // tableur que le modèle aurait rédigé en Markdown (« Non disponible » partout) n'existe plus.
    const c = await construireClasseurDrive(user, { nom, spec: classeurDesLectures(jeux, d.contenu), dossier: DOSSIER_TRAVAUX });
    if (!c.ok) return { ok: false, erreur: c.motif };
    nodeId = c.nodeId;
  } else if (!nodeId) {
    // Un document rédigé sur des lectures garde, à la fin, leurs LIMITES CALCULÉES (jamais laissées au modèle).
    const limites = jeux.flatMap((j) => limitesDuJeu(j.lignes, j.colonnes.filter((c) => c !== "lien" && j.lignes.some((l) => !vide(l[c]))), j.colonnes.includes("majLe") ? "majLe" : null, new Date()).map((t) => `- ${j.titre} — ${t}`));
    const { octets, mime } = composerNoteMarkdown(d.titre, limites.length ? `${d.contenu}\n\n## Limites (calculées sur les lignes lues)\n\n${limites.join("\n")}` : d.contenu, user.name ?? undefined);
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
