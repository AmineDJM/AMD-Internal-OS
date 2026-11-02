import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { fichesDeDossierPourModele } from "@/platform/ia/lectures/connaissance";
import { bilanCtd, type PieceAClasser } from "../domaine/ctd";
import { phraseLot } from "../domaine/lecture/depot-dossier";
import { etatDesLots, lotDesigne, piecesDuLot } from "./depot-dossier";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * RÉPONDRE SUR UN DOSSIER DÉPOSÉ (lot J11, décision 0030) — « classe ces 300 fichiers par module CTD », « quelles
 * pièces manquent », « où en est la lecture ».
 *
 * Une seule lecture : les fichiers sous la racine du lot (le Drive), puis leurs fiches de la Bibliothèque en LOT
 * (titre, nature, début du texte lu — sous les droits de la personne, coffre et confidentiel sans texte). Le classement
 * CTD est fait ICI, par règles (`domaine/ctd.ts`) : aucun fichier relu, aucun appel au modèle par fichier. La sortie
 * est bornée (au plus 25 chemins par section) : le modèle résume, la personne ouvre le dossier dans son Drive.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const OUTIL_DOSSIER_DEPOSE = "lire_dossier_depose";
const PAR_SECTION_MAX = 25;

const borne = (l: string[]): string[] => (l.length > PAR_SECTION_MAX ? [...l.slice(0, PAR_SECTION_MAX), `… et ${l.length - PAR_SECTION_MAX} autres`] : l);

export function lectureDossierDepose(user: CurrentUser): PowerTool {
  return {
    def: {
      name: OUTIL_DOSSIER_DEPOSE,
      description: "Lit un DOSSIER que la personne a déposé dans la conversation (recréé dans son Drive) : l'état de sa lecture, "
        + "le CLASSEMENT de ses fichiers par module et section CTD, et les PIÈCES ATTENDUES qui MANQUENT. Sans `dossier`, le plus récent. "
        + "Le classement vient de la Bibliothèque (noms, chemins, texte déjà lu) : ne relis pas les fichiers un à un. "
        + "C'est une aide à la relecture : dis-le, et nomme les fichiers non classés.",
      input_schema: {
        type: "object",
        properties: {
          dossier: { type: "string", description: "Fragment du nom du dossier déposé ; vide = le plus récent." },
          analyse: { type: "string", enum: ["ctd", "manquantes", "etat", "liste"], description: "ctd (classement), manquantes, etat (lecture), liste (fichiers)." },
        },
      },
    },
    allowed: (u) => u.id === user.id,
    label: "Dossier déposé lu",
    run: async (entree, u) => {
      if (u.id !== user.id) return JSON.stringify({ statut: "REFUS", raison: "Cet outil a été préparé pour une autre personne." });
      const lot = await lotDesigne(u, typeof entree.dossier === "string" ? entree.dossier : null);
      if (!lot) return JSON.stringify({ statut: "VIDE", note: "Aucun dossier déposé dans la conversation (ou aucun ne porte ce nom)." });
      const [etat] = await etatDesLots(u, { lotId: lot.id, max: 1 });
      const contenu = await piecesDuLot(u, lot.id);
      if (!etat || !contenu) return JSON.stringify({ statut: "VIDE", note: "Ce dossier n'est plus accessible." });
      const analyse = typeof entree.analyse === "string" ? entree.analyse : "ctd";
      const lecture = { dossier: lot.nom, lien: `/drive/${etat.racineId}`, etat: phraseLot(etat), fichiers: etat.annonces, arrives: etat.televerses, lus: etat.lus, enFile: etat.enFile, echoues: etat.echoues };
      if (analyse === "etat") return JSON.stringify(lecture);

      const fiches = new Map((await fichesDeDossierPourModele(u, contenu.pieces.flatMap((p) => (p.pieceId ? [p.pieceId] : [])))).map((f) => [f.pieceId, f]));
      if (analyse === "liste") {
        return JSON.stringify({ ...lecture, liste: borne(contenu.pieces.map((p) => `${p.relatif}${fiches.get(p.pieceId ?? "")?.statut === "FAITE" ? "" : " (pas encore lu)"}`)) });
      }
      const pieces: PieceAClasser[] = contenu.pieces.map((p) => {
        const f = p.pieceId ? fiches.get(p.pieceId) : undefined;
        return { chemin: p.relatif, titre: f?.titre ?? null, nature: f?.nature ?? null, extrait: f?.extrait ?? null };
      });
      const b = bilanCtd(pieces);
      const nonLus = contenu.pieces.filter((p) => fiches.get(p.pieceId ?? "")?.statut !== "FAITE").length;
      const avertissements = [
        "Classement par règles (numéros de section, mots des chemins et du texte déjà lu) : une aide à la relecture, pas un avis réglementaire.",
        ...(nonLus ? [`${nonLus} fichier(s) pas encore lu(s) par la Bibliothèque : classés par leur nom et leur chemin seulement.`] : []),
        ...(etat.annonces > etat.televerses ? [`${etat.annonces - etat.televerses} fichier(s) annoncé(s) pas encore arrivé(s) dans le Drive.`] : []),
      ];
      if (analyse === "manquantes") {
        return JSON.stringify({ ...lecture, manquantes: b.manquantes, nonClassees: borne(b.nonClassees), avertissements });
      }
      return JSON.stringify({
        ...lecture, parModule: b.parModule,
        sections: b.sections.map((s) => ({ section: s.code, libelle: s.libelle, nombre: s.pieces.length, pieces: borne(s.pieces) })),
        nonClassees: borne(b.nonClassees), manquantes: b.manquantes, avertissements,
      });
    },
  };
}
