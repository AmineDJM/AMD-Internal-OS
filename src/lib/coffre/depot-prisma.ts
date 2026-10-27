import type { AccesDonneeSensibleJournal, DepotCoffre, DonneeSensibleStockee, RefTitulaire, ResumeDonneeSensible } from "./depot";
import { estNatureCoffre, type NatureCoffre } from "./natures";

/**
 * LE DÉPÔT PRISMA DU COFFRE — écrit contre les tables PRÉVUES `DonneeSensible` et
 * `AccesDonneeSensible` (refonte des données, R6), qui n'existent pas encore dans le schéma.
 *
 * Il ne reçoit donc pas `prisma` lui-même mais un client DÉCRIT par sa forme (`ClientPrismaCoffre`) :
 * le module compile aujourd'hui, et le jour où les tables existent, `creerDepotPrisma(prisma)` type
 * directement. Rien ne l'appelle encore.
 *
 * Colonnes attendues (noms Prisma) :
 *   DonneeSensible        id, titulairePersonneId?, titulaireOrganisationId?, nature, valeurChiffree,
 *                         empreinte, derniers4?, pieceSourceId?, valideDu?, valideAu?, deposeParId?,
 *                         createdAt — index (nature, empreinte) ; exactement un des deux titulaires.
 *   AccesDonneeSensible   id, donneeId, lecteurGenre, lecteurId?, lecteurNom?, geste, autorise,
 *                         motif, createdAt — index (donneeId, createdAt).
 */

export interface LigneDonneeSensible {
  id: string;
  titulairePersonneId: string | null;
  titulaireOrganisationId: string | null;
  nature: string;
  valeurChiffree: string;
  empreinte: string;
  derniers4: string | null;
  pieceSourceId: string | null;
  valideDu: Date | null;
  valideAu: Date | null;
  deposeParId: string | null;
  createdAt: Date;
}

export interface LigneAccesDonneeSensible {
  donneeId: string;
  lecteurGenre: string;
  lecteurId: string | null;
  lecteurNom: string | null;
  geste: string;
  autorise: boolean;
  motif: string;
  createdAt: Date;
}

type FiltreDonnee = {
  nature: string;
  empreinte: string;
  titulairePersonneId?: string;
  titulaireOrganisationId?: string;
};

export interface TransactionCoffre {
  donneeSensible: {
    create(args: { data: LigneDonneeSensible }): Promise<unknown>;
    findUnique(args: { where: { id: string } }): Promise<LigneDonneeSensible | null>;
    findMany(args: { where: FiltreDonnee; orderBy: { createdAt: "asc" | "desc" } }): Promise<LigneDonneeSensible[]>;
  };
  accesDonneeSensible: {
    create(args: { data: LigneAccesDonneeSensible }): Promise<unknown>;
  };
}

export interface ClientPrismaCoffre extends TransactionCoffre {
  $transaction<T>(fn: (tx: TransactionCoffre) => Promise<T>): Promise<T>;
}

function versStockee(l: LigneDonneeSensible): DonneeSensibleStockee {
  if (!estNatureCoffre(l.nature)) throw new Error(`Nature inconnue au coffre : ${l.nature}`);
  let titulaire: RefTitulaire;
  if (l.titulairePersonneId && !l.titulaireOrganisationId) titulaire = { genre: "PERSONNE", personneId: l.titulairePersonneId };
  else if (l.titulaireOrganisationId && !l.titulairePersonneId) titulaire = { genre: "ORGANISATION", organisationId: l.titulaireOrganisationId };
  else throw new Error(`Donnée du coffre ${l.id} : exactement un titulaire attendu.`);
  return {
    id: l.id,
    titulaire,
    nature: l.nature,
    valeurChiffree: l.valeurChiffree,
    empreinte: l.empreinte,
    derniers4: l.derniers4,
    pieceSourceId: l.pieceSourceId,
    valideDu: l.valideDu,
    valideAu: l.valideAu,
    deposeParId: l.deposeParId,
    deposeLe: l.createdAt,
  };
}

function versLigne(d: DonneeSensibleStockee): LigneDonneeSensible {
  return {
    id: d.id,
    titulairePersonneId: d.titulaire.genre === "PERSONNE" ? d.titulaire.personneId : null,
    titulaireOrganisationId: d.titulaire.genre === "ORGANISATION" ? d.titulaire.organisationId : null,
    nature: d.nature,
    valeurChiffree: d.valeurChiffree,
    empreinte: d.empreinte,
    derniers4: d.derniers4,
    pieceSourceId: d.pieceSourceId,
    valideDu: d.valideDu,
    valideAu: d.valideAu,
    deposeParId: d.deposeParId,
    createdAt: d.deposeLe,
  };
}

function versLigneAcces(a: AccesDonneeSensibleJournal): LigneAccesDonneeSensible {
  return {
    donneeId: a.donneeId,
    lecteurGenre: a.lecteurGenre,
    lecteurId: a.lecteurId,
    lecteurNom: a.lecteurNom,
    geste: a.geste,
    autorise: a.autorise,
    motif: a.motif,
    createdAt: a.le,
  };
}

export function creerDepotPrisma(client: ClientPrismaCoffre): DepotCoffre {
  return {
    async deposer(d) {
      await client.donneeSensible.create({ data: versLigne(d) });
    },

    async lireAvecJournal(id, decider) {
      return client.$transaction(async (tx) => {
        const ligne = await tx.donneeSensible.findUnique({ where: { id } });
        if (!ligne) return null;
        const donnee = versStockee(ligne);
        const acces = await decider(donnee);
        await tx.accesDonneeSensible.create({ data: versLigneAcces(acces) });
        return { donnee, acces };
      });
    },

    async chercherParEmpreinte(nature: NatureCoffre, empreinte: string, titulaire?: RefTitulaire): Promise<ResumeDonneeSensible[]> {
      const where: FiltreDonnee = { nature, empreinte };
      if (titulaire?.genre === "PERSONNE") where.titulairePersonneId = titulaire.personneId;
      if (titulaire?.genre === "ORGANISATION") where.titulaireOrganisationId = titulaire.organisationId;
      const lignes = await client.donneeSensible.findMany({ where, orderBy: { createdAt: "asc" } });
      return lignes.map((l) => {
        const { valeurChiffree: _chiffre, ...resume } = versStockee(l);
        void _chiffre;
        return resume;
      });
    },
  };
}
