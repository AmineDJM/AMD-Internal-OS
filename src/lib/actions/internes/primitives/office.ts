import { adaptateurPour, formatDeFichier, mimeDe } from "@/lib/artifact/adapters/registry";
import type { DocumentOuvert } from "@/lib/artifact/adapters/contract";
import type { ArtifactFormat } from "@/lib/artifact/object-model/model";
import { vueDuModele, type VueContenu } from "@/lib/artifact/render/view";
import { composerDocx, paragraphe, tableau, MIME_DOCX, type Cellule, type Fragment } from "@/lib/artifact/factory/word";
import { docxToPdf } from "@/lib/payslip/to-pdf";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FICHIERS OFFICE POUR LES PRIMITIVES `produire`, `fichier`, `observer` (lot I3, décision 0065).
 *
 * Rien de neuf : les ADAPTATEURS de l'Atelier (Word, Excel, PowerPoint, PDF — les mêmes qui éditent en place, styles et
 * mise en page conservés), la vue qu'en tire l'écran (`vueDuModele` : ce que la personne VOIT), la composition Word de la
 * fabrique (`composerDocx`) et le rendu PDF intégré (`docxToPdf`, sans LibreOffice). Ce fichier n'en est que la porte,
 * pour le module de l'Assistant IA.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type { DocumentOuvert, VueContenu };
export type FormatOffice = ArtifactFormat;
export { mimeDe as mimeOffice, MIME_DOCX };

/** Ouvrir des octets (Word, Excel, PowerPoint, PDF) : l'objet éditable et la vue de l'écran. */
export async function ouvrirOffice(octets: Buffer, nom: string, mime?: string | null): Promise<{ format: FormatOffice; doc: DocumentOuvert; vue: VueContenu } | { erreur: string }> {
  const format = formatDeFichier(nom, mime);
  if (!format) return { erreur: `« ${nom} » n'est ni un Word, ni un Excel, ni un PowerPoint, ni un PDF` };
  try {
    const doc = await adaptateurPour(format).ouvrir(octets);
    return { format, doc, vue: vueDuModele(doc.modele()) };
  } catch (e) {
    return { erreur: `le fichier « ${nom} » n'a pas pu être ouvert : ${(e as Error).message}` };
  }
}

export const vueDe = (doc: DocumentOuvert): VueContenu => vueDuModele(doc.modele());

// ─── Composer un Word depuis des blocs (titres, paragraphes, listes, tableaux) ─────────────

interface MorceauW { texte: string; gras?: boolean; italique?: boolean; couleur?: string | null }
export type BlocW =
  | { type: "titre"; niveau: 1 | 2 | 3; morceaux: MorceauW[]; couleur: string | null; alignement: string | null }
  | { type: "paragraphe"; morceaux: MorceauW[]; couleur: string | null; alignement: string | null }
  | { type: "liste"; ordonnee: boolean; items: MorceauW[][] }
  | { type: "tableau"; lignes: { cellules: { morceaux: MorceauW[]; entete: boolean; fond: string | null; couleur: string | null }[] }[] }
  | { type: "separateur" };

const ALIGN: Record<string, "left" | "center" | "right" | "both"> = { left: "left", center: "center", right: "right", justify: "both" };
const frag = (m: MorceauW, defaut: string | null, taille?: number): Fragment => ({
  texte: m.texte, gras: m.gras || undefined, italique: m.italique || undefined, couleur: (m.couleur ?? defaut) ?? undefined, taillePt: taille,
});
const TAILLE_TITRE = { 1: 18, 2: 14, 3: 12 } as const;
const LARGEUR_UTILE_CM = 16.5;

/** Un `.docx` neuf depuis des blocs. `couleurTitres` : la charte quand le modèle n'a rien dit. */
export function docxDepuisBlocs(blocs: readonly BlocW[], o: { titre: string; couleurTitres?: string | null }): Buffer {
  const xml: string[] = [];
  for (const b of blocs) {
    if (b.type === "titre") {
      xml.push(paragraphe(b.morceaux.map((m) => frag({ ...m, gras: true }, b.couleur ?? o.couleurTitres ?? null, TAILLE_TITRE[b.niveau])),
        { alignement: b.alignement ? ALIGN[b.alignement] : undefined, avantPt: 10, apresPt: 6, garderAvecSuivant: true }));
    } else if (b.type === "paragraphe") {
      xml.push(paragraphe(b.morceaux.map((m) => frag(m, b.couleur)), { alignement: b.alignement ? ALIGN[b.alignement] : undefined, apresPt: 6 }));
    } else if (b.type === "liste") {
      b.items.forEach((it, i) => xml.push(paragraphe([{ texte: b.ordonnee ? `${i + 1}. ` : "•  " }, ...it.map((m) => frag(m, null))], { apresPt: 2 })));
    } else if (b.type === "tableau") {
      const n = Math.max(...b.lignes.map((l) => l.cellules.length), 1);
      const cellules: Cellule[][] = b.lignes.map((l) => Array.from({ length: n }, (_, i) => {
        const c = l.cellules[i];
        if (!c) return "";
        return { contenu: c.morceaux.map((m) => frag(m, c.couleur)), gras: c.entete || undefined, fond: c.fond ?? undefined, couleur: c.couleur ?? undefined };
      }));
      xml.push(tableau(cellules, { colonnes: Array.from({ length: n }, () => ({ largeurCm: LARGEUR_UTILE_CM / n })), entete: b.lignes[0]?.cellules.every((c) => c.entete) ?? false }));
      xml.push(paragraphe("", { apresPt: 4 }));
    } else {
      xml.push(paragraphe("────────────────────────", { alignement: "center" }));
    }
  }
  return composerDocx({ blocs: xml, titre: o.titre, couleurTitres: o.couleurTitres ?? undefined }).octets;
}

/** Le PDF d'un Word, par le rendu intégré (sans LibreOffice : la cible de déploiement n'en a pas). */
export async function pdfDepuisDocx(octets: Buffer): Promise<{ octets: Buffer; limites: string[] }> {
  const r = await docxToPdf(octets);
  if (!r.ok) throw new Error(r.error);
  return { octets: Buffer.from(r.pdf), limites: r.limites ?? [] };
}
