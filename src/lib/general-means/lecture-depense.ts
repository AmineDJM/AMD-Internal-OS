import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/settings";
import { validateDocumentUpload } from "@/lib/storage";
import { proposerLecture, annuaireDeLecture, exigerLectureConfirmee, type ConfirmationPrete } from "@/lib/pieces-lues/service";
import { empreinteDe } from "@/lib/pieces-lues/lecture-fichier";
import { articleKey, normalizeArticleName } from "./catalog-normalize";
import {
  CASE_COMPAREES_DEPENSE, lectureFactureDepense, lignesProposeesDepense, prixUnitaireDe,
  type ArticleDuCatalogue, type LectureFactureDepense,
} from "./lecture-facture";
import type { ReceiptLine } from "./receipt";

/**
 * LA DÉPENSE DES MOYENS GÉNÉRAUX LUE SUR SA PIÈCE — le côté serveur (Direction, 09/11/2026). Les règles pures sont dans
 * `lecture-facture.ts` ; ici : lire le fichier (le lecteur commun, `proposerLecture`), exiger la lecture CONFIRMÉE au
 * moment d'enregistrer (la case « J'ai comparé les articles à la facture » dès qu'une ligne vient du papier), et
 * ajouter au catalogue les articles qui n'y étaient pas.
 */

async function catalogueActif(): Promise<ArticleDuCatalogue[]> {
  return prisma.officeSupplyArticle.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } });
}

/** LIRE la facture ou le ticket d'une dépense : rien n'est écrit, sinon la lecture elle-même (gardée pour la confirmation). */
export async function lireFactureDeDepense(
  user: { id: string }, fichier: File,
): Promise<{ ok: true; lecture: LectureFactureDepense } | { ok: false; error: string }> {
  const invalide = validateDocumentUpload(fichier.name, fichier.size, (await getAppSettings()).maxUploadMb);
  if (invalide) return { ok: false, error: `« ${fichier.name} » : ${invalide}` };
  const octets = Buffer.from(await fichier.arrayBuffer());
  const { annuaireVisible, groupe } = await annuaireDeLecture(user.id);
  // Une facture d'achat courant se dépose en pièce INTERNE de la dépense : sa sortie vers Luna est permise.
  const r = await proposerLecture({
    user, octets, nomFichier: fichier.name,
    contexte: { cible: "DEPARTMENT_EXPENSE", sortieCloudPermise: true, annuaireVisible, groupe },
  });
  if (!r.ok) return { ok: false, error: r.error };
  const p = r.proposition;
  const fournisseurNom = p.piece?.fournisseur.nom ?? p.fournisseur.aCreer?.nom ?? null;
  return {
    ok: true,
    lecture: lectureFactureDepense({
      lectureId: p.lectureId, nomFichier: p.nomFichier, noteMethode: p.noteMethode, sansLignes: p.sansLignes,
      entetes: p.entetes, piece: p.piece, fournisseurNom,
    }, await catalogueActif()),
  };
}

/**
 * LA LECTURE CONFIRMÉE, exigée AVANT toute écriture quand la dépense a été préremplie (`lectureId`). Le fichier joint en
 * premier doit être celui qui a été lu ; la case unique atteste chaque ligne lue gardée. Rend la confirmation à
 * consigner DANS la transaction de la dépense.
 */
export async function exigerLectureDeDepense(args: {
  lectureId: string; fichierLu: File; lignes: readonly ReceiptLine[]; comparees: boolean;
}): Promise<{ ok: true; confirmation: ConfirmationPrete } | { ok: false; error: string }> {
  const catalogue = await catalogueActif();
  return exigerLectureConfirmee({
    lectureId: args.lectureId,
    empreinte: empreinteDe(new Uint8Array(await args.fichierLu.arrayBuffer())),
    totalVerifie: args.comparees || !args.lignes.some((l) => l.lue !== undefined),
    soumises: args.lignes.map((l) => ({
      lue: l.lue ?? null, verifiee: args.comparees,
      designation: l.label, quantite: l.quantity, prixUnitaire: prixUnitaireDe(l.amount, l.quantity),
    })),
    proposees: (piece) => lignesProposeesDepense(piece, catalogue),
    caseGlobale: CASE_COMPAREES_DEPENSE,
  });
}

/**
 * LES ARTICLES NOUVEAUX ENTRENT AU CATALOGUE (Direction, 09/11/2026 : « créer les articles et les nommer ») — ceux que la
 * personne a laissé cochés. Un article du même nom (casse, accents, ponctuation ignorés) déjà au catalogue est REPRIS,
 * jamais doublé ; un article archivé du même nom revient au catalogue. La ligne est alors rattachée à l'article.
 */
export async function ajouterAuCatalogueDepuisDepense(userId: string, lignes: ReceiptLine[], origine: string): Promise<{ lignes: ReceiptLine[]; ajoutes: string[] }> {
  if (!lignes.some((l) => l.ajouterAuCatalogue && !l.articleId)) return { lignes, ajoutes: [] };
  const existants = await prisma.officeSupplyArticle.findMany({ select: { id: true, name: true, active: true } });
  const parCle = new Map(existants.map((a) => [articleKey(a.name), a]));
  const ajoutes: string[] = [];
  const out: ReceiptLine[] = [];
  for (const l of lignes) {
    if (!l.ajouterAuCatalogue || l.articleId) { out.push(l); continue; }
    const nom = normalizeArticleName(l.label);
    const cle = articleKey(nom);
    if (!cle) { out.push(l); continue; }
    let article = parCle.get(cle) ?? null;
    if (article && !article.active) {
      await prisma.officeSupplyArticle.update({ where: { id: article.id }, data: { active: true } });
    }
    if (!article) {
      const cree = await prisma.officeSupplyArticle.create({
        data: {
          name: nom, estimatedPrice: prixUnitaireDe(l.amount, l.quantity), createdById: userId,
          notes: `Ajouté au catalogue depuis une dépense des moyens généraux — ${origine}.`,
        },
        select: { id: true, name: true, active: true },
      });
      article = cree;
      parCle.set(cle, cree);
      ajoutes.push(cree.name);
    }
    out.push({ ...l, articleId: article.id, label: article.name });
  }
  return { lignes: out, ajoutes };
}
