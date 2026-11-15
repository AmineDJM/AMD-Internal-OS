import { prisma } from "@/lib/prisma";
import { importCourant } from "./imports";

/**
 * LES FLUX LUS PAR LE SERVICE PORTEFEUILLE DCI (`/api/donnees-marche/v1/*`). Toujours le dépôt qui fait foi ; les
 * réceptions hospitalières viennent de l'import des ventes PCH (`PchReceptionLigne`) : seulement les médicaments
 * (`gamme` MED) reçus d'un fournisseur (`type` FO) — un transfert entre annexes (TR), un retour client (RC) ou une
 * correction de stock (CO) compterait deux fois la même boîte. Les montants restent en DA, quelle que soit la devise
 * écrite dans le fichier (la PCH l'a déjà convertie).
 */

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export async function etatDesDonnees() {
  const [nom, iq, rec] = await Promise.all([
    importCourant("NOMENCLATURE"),
    importCourant("IQVIA"),
    prisma.pchVenteImport.findFirst({ where: { nature: "RECEPTIONS", remplaceParId: null }, orderBy: { createdAt: "desc" }, select: { id: true, createdAt: true } }),
  ]);
  const ligne = (i: Awaited<ReturnType<typeof importCourant>>) => (i ? { id: i.id, periode: i.periode, lignes: i.lignes, depose: i.createdAt.toISOString(), fichier: i.nomFichier } : null);
  return { nomenclature: ligne(nom), iqvia: ligne(iq), receptions: rec ? { id: rec.id, depose: rec.createdAt.toISOString() } : null };
}

export async function fluxNomenclature(onglet?: string) {
  const imp = await importCourant("NOMENCLATURE");
  if (!imp) return { import: null, lignes: [] };
  const lignes = await prisma.nomenclatureLigne.findMany({
    where: { importId: imp.id, ...(onglet ? { onglet } : {}) },
    orderBy: [{ onglet: "asc" }, { numero: "asc" }],
    select: {
      onglet: true, numEnregistrement: true, code: true, dci: true, marque: true, forme: true, dosage: true, conditionnement: true,
      liste: true, p1: true, p2: true, obs: true, laboratoire: true, paysLaboratoire: true, dateInitiale: true, dateFinale: true,
      type: true, statut: true, dateRetrait: true, motifRetrait: true,
    },
  });
  return {
    import: { id: imp.id, periode: imp.periode, depose: imp.createdAt.toISOString() },
    lignes: lignes.map((l) => ({ ...l, dateInitiale: iso(l.dateInitiale), dateFinale: iso(l.dateFinale), dateRetrait: iso(l.dateRetrait) })),
  };
}

export async function fluxIqvia() {
  const imp = await importCourant("IQVIA");
  if (!imp) return { import: null, presentations: [] };
  const presentations = await prisma.iqviaLigne.findMany({
    where: { importId: imp.id },
    select: {
      atc4: true, produit: true, presentation: true, molecules: true, laboratoire: true, matUnites: true, matValeur: true,
      matCroissance: true, ytdUnites: true, ytdValeur: true, moisUnites: true, moisValeur: true,
    },
  });
  return { import: { id: imp.id, periode: imp.periode, depose: imp.createdAt.toISOString() }, presentations };
}

export async function fluxReceptionsHopital() {
  const lignes = await prisma.pchReceptionLigne.findMany({
    where: { type: "FO", gamme: { in: ["MED", "MED "] }, import: { remplaceParId: null } },
    orderBy: [{ mois: "asc" }],
    select: {
      mois: true, dateStockage: true, classe: true, fournisseur: true, codePro: true, designation: true, molecule: true,
      conditionnement: true, qte: true, coutUnit: true,
    },
  });
  return {
    lignes: lignes.map((l) => ({
      mois: iso(l.mois), dateStockage: iso(l.dateStockage), classe: l.classe, fournisseur: l.fournisseur, codePro: l.codePro,
      designation: l.designation, molecule: l.molecule, conditionnement: l.conditionnement?.trim() ?? null, qte: l.qte,
      coutUnitDa: l.coutUnit == null ? null : Number(l.coutUnit),
    })),
  };
}
