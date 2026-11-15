import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { lireClasseur } from "./classeur";
import { lireNomenclature } from "../domaine/nomenclature";
import { lireIqvia } from "../domaine/iqvia";

/**
 * DÉPOSER UN FICHIER DE DONNÉES MARCHÉ. La nature se reconnaît à l'en-tête (pas au nom du fichier) ; le même fichier
 * (même empreinte) ne fait rien ; le fichier original est gardé ; les lignes s'écrivent par lots. Le plus récent
 * dépôt d'une nature fait foi (`importCourant`) — les anciens restent, consultables.
 */

const LOT = 1000;
export type NatureMarche = "NOMENCLATURE" | "IQVIA";
export type ResultatDepot =
  | { ok: true; nature: NatureMarche; importId: string; lignes: number; periode: string | null; deja: boolean; rapport: Record<string, unknown> }
  | { ok: false; erreur: string };

const dateOuNul = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`) : null);

export async function deposerFichierMarche(nomFichier: string, buffer: Buffer, auteurId: string | null): Promise<ResultatDepot> {
  const empreinte = createHash("sha256").update(buffer).digest("hex");
  const existant = await prisma.marcheImport.findUnique({ where: { empreinte }, select: { id: true, nature: true, lignes: true, periode: true, rapport: true } });
  if (existant) {
    return { ok: true, nature: existant.nature as NatureMarche, importId: existant.id, lignes: existant.lignes, periode: existant.periode, deja: true, rapport: (existant.rapport ?? {}) as Record<string, unknown> };
  }
  let feuilles;
  try { feuilles = lireClasseur(buffer); } catch { return { ok: false, erreur: "Ce fichier ne s'ouvre pas comme un classeur Excel." }; }

  const nom = lireNomenclature(feuilles);
  if (nom && nom.lignes.length) {
    const rapport = { parOnglet: nom.parOnglet, dateArrete: nom.dateArrete };
    const imp = await prisma.marcheImport.create({
      data: { nature: "NOMENCLATURE", nomFichier, empreinte, taille: buffer.length, fichier: buffer, periode: nom.dateArrete, lignes: nom.lignes.length, rapport, auteurId },
      select: { id: true },
    });
    for (let i = 0; i < nom.lignes.length; i += LOT) {
      await prisma.nomenclatureLigne.createMany({
        data: nom.lignes.slice(i, i + LOT).map((l) => ({
          ...l, importId: imp.id, dateInitiale: dateOuNul(l.dateInitiale), dateFinale: dateOuNul(l.dateFinale), dateRetrait: dateOuNul(l.dateRetrait),
        })),
      });
    }
    return { ok: true, nature: "NOMENCLATURE", importId: imp.id, lignes: nom.lignes.length, periode: nom.dateArrete, deja: false, rapport };
  }

  const iq = lireIqvia(feuilles);
  if (iq && iq.presentations.length) {
    const rapport = { totalAnnonce: iq.totalAnnonce, totalRecompte: iq.totalRecompte, controle: iq.totalAnnonce == null ? null : Math.abs(iq.totalAnnonce - iq.totalRecompte) < 1 };
    const imp = await prisma.marcheImport.create({
      data: { nature: "IQVIA", nomFichier, empreinte, taille: buffer.length, fichier: buffer, periode: iq.periode, lignes: iq.presentations.length, rapport, auteurId },
      select: { id: true },
    });
    for (let i = 0; i < iq.presentations.length; i += LOT) {
      await prisma.iqviaLigne.createMany({ data: iq.presentations.slice(i, i + LOT).map((p) => ({ ...p, importId: imp.id })) });
    }
    return { ok: true, nature: "IQVIA", importId: imp.id, lignes: iq.presentations.length, periode: iq.periode, deja: false, rapport };
  }

  return { ok: false, erreur: "Ni nomenclature ni IQVIA : l'en-tête attendu (CODE, DCI, STATUT — ou ATC4, PRODUIT, PRESENTATION, MOLECULE, LABORATOIRE) est introuvable." };
}

/** Le dépôt qui fait foi pour une nature : le plus récent. */
export function importCourant(nature: NatureMarche) {
  return prisma.marcheImport.findFirst({
    where: { nature }, orderBy: { createdAt: "desc" },
    select: { id: true, nature: true, nomFichier: true, periode: true, lignes: true, rapport: true, createdAt: true },
  });
}

/** Les derniers dépôts (écran). */
export function derniersDepots(n = 20) {
  return prisma.marcheImport.findMany({
    orderBy: { createdAt: "desc" }, take: n,
    select: { id: true, nature: true, nomFichier: true, periode: true, lignes: true, rapport: true, createdAt: true, taille: true },
  });
}
