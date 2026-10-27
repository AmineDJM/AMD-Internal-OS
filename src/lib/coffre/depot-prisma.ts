import { decomposer } from "./chiffrement";
import { recomposer } from "./dechiffrement";
import type { AccesDonneeSensibleJournal, DepotCoffre, DonneeSensibleStockee, RefTitulaire, ResumeDonneeSensible } from "./depot";
import { estNatureCoffre, type NatureCoffre } from "./natures";

/**
 * LE DÉPÔT PRISMA DU COFFRE — écrit contre les tables `DonneeSensible` et `AccesDonneeSensible`
 * (migrations `20270130100000_referentiels` et `20270131170000_coffre_double_lecture`).
 *
 * Il reçoit un client DÉCRIT par sa forme (`ClientPrismaCoffre`) : `prisma` y entre tel quel, et un
 * client en mémoire suffit aux bancs. Le chiffré du service (`c1.<clé>.<…>`) est rangé en colonnes
 * (`valeurChiffree`, `iv`, `tag`, `cleVersion`, `cleId`) par `decomposer`, relu par `recomposer`.
 *
 * Ce dépôt sert les dépôts « par titulaire » (moteur d'enrichissement, V2-A). Les copies de colonnes
 * historiques (V2-E) passent par `copies.ts`, qui sait d'où vient la valeur ; seules les copies
 * COURANTES (`remplaceeLe` nul) sont cherchées.
 */

export interface LigneDonneeSensible {
  id: string;
  titulaireType: "PERSONNE" | "ORGANISATION" | null;
  titulaireId: string | null;
  nature: string;
  valeurChiffree: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  cleVersion: number;
  cleId: string | null;
  empreinteHmac: string;
  derniersCaracteres: string | null;
  pieceId: string | null;
  valideDu: Date | null;
  valideAu: Date | null;
  creeParId: string | null;
  createdAt: Date;
}

export interface LigneAccesDonneeSensible {
  donneeSensibleId: string | null;
  titulaireType: "PERSONNE" | "ORGANISATION" | null;
  titulaireId: string | null;
  nature: string;
  userId: string | null;
  lecteurNom: string | null;
  geste: string;
  autorise: boolean;
  motif: string | null;
  createdAt: Date;
}

type FiltreDonnee = {
  nature: string;
  empreinteHmac: string;
  remplaceeLe: null;
  titulaireType?: "PERSONNE" | "ORGANISATION";
  titulaireId?: string;
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

function titulaireDe(l: Pick<LigneDonneeSensible, "id" | "titulaireType" | "titulaireId">): RefTitulaire {
  if (l.titulaireType === "PERSONNE" && l.titulaireId) return { genre: "PERSONNE", personneId: l.titulaireId };
  if (l.titulaireType === "ORGANISATION" && l.titulaireId) return { genre: "ORGANISATION", organisationId: l.titulaireId };
  throw new Error(`Donnée du coffre ${l.id} : sans titulaire (copie d'une colonne, lue par copies.ts).`);
}

function colonnesTitulaire(t: RefTitulaire): Pick<LigneDonneeSensible, "titulaireType" | "titulaireId"> {
  return t.genre === "PERSONNE" ? { titulaireType: "PERSONNE", titulaireId: t.personneId } : { titulaireType: "ORGANISATION", titulaireId: t.organisationId };
}

function versStockee(l: LigneDonneeSensible): DonneeSensibleStockee {
  if (!estNatureCoffre(l.nature)) throw new Error(`Nature inconnue au coffre : ${l.nature}`);
  return {
    id: l.id,
    titulaire: titulaireDe(l),
    nature: l.nature,
    valeurChiffree: recomposer(l),
    empreinte: l.empreinteHmac,
    derniers4: l.derniersCaracteres,
    pieceSourceId: l.pieceId,
    valideDu: l.valideDu,
    valideAu: l.valideAu,
    deposeParId: l.creeParId,
    deposeLe: l.createdAt,
  };
}

function versLigne(d: DonneeSensibleStockee): LigneDonneeSensible {
  return {
    id: d.id,
    ...colonnesTitulaire(d.titulaire),
    nature: d.nature,
    ...decomposer(d.valeurChiffree),
    empreinteHmac: d.empreinte,
    derniersCaracteres: d.derniers4,
    pieceId: d.pieceSourceId,
    valideDu: d.valideDu,
    valideAu: d.valideAu,
    creeParId: d.deposeParId,
    createdAt: d.deposeLe,
  };
}

function versLigneAcces(a: AccesDonneeSensibleJournal, d: DonneeSensibleStockee): LigneAccesDonneeSensible {
  return {
    donneeSensibleId: a.donneeId,
    ...colonnesTitulaire(d.titulaire),
    nature: d.nature,
    userId: a.lecteurId,
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
        await tx.accesDonneeSensible.create({ data: versLigneAcces(acces, donnee) });
        return { donnee, acces };
      });
    },

    async chercherParEmpreinte(nature: NatureCoffre, empreinte: string, titulaire?: RefTitulaire): Promise<ResumeDonneeSensible[]> {
      const where: FiltreDonnee = { nature, empreinteHmac: empreinte, remplaceeLe: null };
      if (titulaire) Object.assign(where, colonnesTitulaire(titulaire));
      const lignes = await client.donneeSensible.findMany({ where, orderBy: { createdAt: "asc" } });
      return lignes.filter((l) => l.titulaireId).map((l) => {
        const { valeurChiffree: _chiffre, ...resume } = versStockee(l);
        void _chiffre;
        return resume;
      });
    },
  };
}
