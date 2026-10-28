import type { Prisma, PrismaClient } from "@prisma/client";
import type { AccesDonneeSensibleJournal, DepotCoffre, DonneeSensibleStockee, RefTitulaire, ResumeDonneeSensible } from "./depot";
import { estNatureCoffre, type NatureCoffre } from "./natures";

/**
 * LE DÉPÔT DU COFFRE SUR LES TABLES DU RÉFÉRENTIEL R6 — `DonneeSensible` et `AccesDonneeSensible`
 * telles que la migration `20270130100000_referentiels` les a créées.
 *
 * `depot-prisma.ts` avait été écrit AVANT les tables, contre des colonnes prévues (`titulairePersonneId`,
 * chiffré en texte) qui ne sont pas celles du schéma (`titulaireType` + `titulaireId`, chiffré en octets
 * `valeurChiffree` + `iv` + `tag`). Celui-ci traduit le port (`depot.ts`) vers le schéma réel :
 *
 *   chiffré du service `c1.<id de clé>.<base64url(iv ‖ tag ‖ corps)>`
 *     → `iv` (12 octets), `tag` (16 octets), `valeurChiffree` (le corps) ;
 *     → `cleVersion` : l'identifiant de la clé (8 caractères hexadécimaux), écrit en entier signé
 *       32 bits — c'est lui qui permet de dire « chiffré avec une autre clé » à la relecture.
 *
 * Le journal d'accès garde qui (`userId` ; « ia:<modèle> » pour un modèle refusé), le geste, et
 * l'issue avec son motif (`ACCORDE:RH`, `REFUSE:MODELE_IA`) : un refus est une trace comme une autre.
 *
 * Serveur seulement (le service chiffre avec `node:crypto`). Le dépôt ne voit jamais une valeur en clair.
 */

const VERSION_CHIFFRE = "c1";

type Client = Pick<PrismaClient, "donneeSensible" | "accesDonneeSensible" | "$transaction">;

/** L'identifiant de clé (8 hex) ↔ l'entier `cleVersion`. */
export const cleVersionDe = (idCle: string): number => parseInt(idCle, 16) | 0;
export const idCleDe = (cleVersion: number): string => (cleVersion >>> 0).toString(16).padStart(8, "0");

/** Découpe le chiffré du service en colonnes ; lève sur une forme inattendue (jamais un stockage à moitié). */
export function enColonnes(chiffre: string): { valeurChiffree: Buffer; iv: Buffer; tag: Buffer; cleVersion: number } {
  const [version, idCle, charge, ...reste] = chiffre.split(".");
  if (version !== VERSION_CHIFFRE || !/^[0-9a-f]{8}$/.test(idCle ?? "") || !charge || reste.length) throw new Error("Chiffré du coffre mal formé : rien n'est stocké.");
  const brut = Buffer.from(charge, "base64url");
  if (brut.length < 28) throw new Error("Chiffré du coffre tronqué : rien n'est stocké.");
  return { iv: brut.subarray(0, 12), tag: brut.subarray(12, 28), valeurChiffree: brut.subarray(28), cleVersion: cleVersionDe(idCle) };
}

/** Recompose le chiffré du service depuis les colonnes. */
export function depuisColonnes(c: { valeurChiffree: Uint8Array; iv: Uint8Array; tag: Uint8Array; cleVersion: number }): string {
  const brut = Buffer.concat([Buffer.from(c.iv), Buffer.from(c.tag), Buffer.from(c.valeurChiffree)]);
  return `${VERSION_CHIFFRE}.${idCleDe(c.cleVersion)}.${brut.toString("base64url")}`;
}

const titulaireDe = (t: RefTitulaire) =>
  t.genre === "PERSONNE" ? { titulaireType: "PERSONNE" as const, titulaireId: t.personneId } : { titulaireType: "ORGANISATION" as const, titulaireId: t.organisationId };

type Ligne = Prisma.DonneeSensibleGetPayload<Record<string, never>>;

/** Les colonnes que ce dépôt lit d'une ligne du coffre (sans le chiffré). */
type LigneLue = Pick<Ligne, "id" | "titulaireType" | "titulaireId" | "nature" | "empreinteHmac" | "derniersCaracteres" | "pieceId" | "valideDu" | "valideAu" | "creeParId" | "createdAt">;

function versResume(l: LigneLue): ResumeDonneeSensible {
  if (!estNatureCoffre(l.nature)) throw new Error(`Nature inconnue au coffre : ${l.nature}`);
  // Depuis V2-E une copie peut attendre son titulaire (la fiche d'origine n'a pas encore de Personne/Organisation) :
  // ce dépôt-ci ne sert que des valeurs rattachées — l'appelant filtre (`aUnTitulaire`).
  if (!l.titulaireType || !l.titulaireId) throw new Error(`Donnée sensible ${l.id} sans titulaire`);
  return {
    id: l.id,
    titulaire: l.titulaireType === "PERSONNE" ? { genre: "PERSONNE", personneId: l.titulaireId } : { genre: "ORGANISATION", organisationId: l.titulaireId },
    nature: l.nature,
    empreinte: l.empreinteHmac,
    derniers4: l.derniersCaracteres,
    pieceSourceId: l.pieceId,
    valideDu: l.valideDu,
    valideAu: l.valideAu,
    deposeParId: l.creeParId,
    deposeLe: l.createdAt,
  };
}

const aUnTitulaire = (l: { titulaireType: unknown; titulaireId: string | null }) => Boolean(l.titulaireType && l.titulaireId);

const versStockee = (l: Ligne): DonneeSensibleStockee => ({ ...versResume(l), valeurChiffree: depuisColonnes(l) });

function versAcces(d: DonneeSensibleStockee, a: AccesDonneeSensibleJournal) {
  return {
    donneeSensibleId: a.donneeId,
    ...titulaireDe(d.titulaire),
    nature: d.nature,
    userId: a.lecteurId ?? `ia:${a.lecteurNom ?? "inconnu"}`,
    geste: a.geste,
    motif: `${a.autorise ? "ACCORDE" : "REFUSE"}:${a.motif}`,
    createdAt: a.le,
  };
}

export function creerDepotReferentiel(client: Client): DepotCoffre {
  return {
    async deposer(d) {
      await client.donneeSensible.create({
        data: {
          id: d.id,
          ...titulaireDe(d.titulaire),
          nature: d.nature,
          ...enColonnes(d.valeurChiffree),
          empreinteHmac: d.empreinte,
          derniersCaracteres: d.derniers4,
          pieceId: d.pieceSourceId,
          valideDu: d.valideDu,
          valideAu: d.valideAu,
          creeParId: d.deposeParId,
          createdAt: d.deposeLe,
        },
      });
    },

    async lireAvecJournal(id, decider) {
      return client.$transaction(async (tx) => {
        const ligne = await tx.donneeSensible.findUnique({ where: { id } });
        if (!ligne) return null;
        const donnee = versStockee(ligne);
        const acces = await decider(donnee);
        await tx.accesDonneeSensible.create({ data: versAcces(donnee, acces) });
        return { donnee, acces };
      });
    },

    async chercherParEmpreinte(nature: NatureCoffre, empreinte: string, titulaire?: RefTitulaire) {
      const lignes = await client.donneeSensible.findMany({
        where: { nature, empreinteHmac: empreinte, ...(titulaire ? titulaireDe(titulaire) : {}) },
        select: {
          id: true, titulaireType: true, titulaireId: true, nature: true, empreinteHmac: true, derniersCaracteres: true,
          pieceId: true, valideDu: true, valideAu: true, creeParId: true, createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      });
      return lignes.filter(aUnTitulaire).map(versResume);
    },
  };
}
