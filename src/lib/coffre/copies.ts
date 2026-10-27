import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { chargerCles, type ClesCoffre } from "./cle";
import { chiffrer, decomposer, empreinte } from "./chiffrement";
import { champsDe, classerValeur, type ModeleSensible } from "./champs";
import { derniersCaracteres } from "./natures";
import type { RefTitulaire } from "./depot";

/**
 * LA COPIE D'UNE COLONNE AU COFFRE (refonte V2-E) — le chemin d'ÉCRITURE, partagé par la reprise et par
 * la double écriture : une seule règle, donc une reprise rejouée après un enregistrement ne trouve rien
 * à refaire.
 *
 * Pour chaque colonne sensible PRÉSENTE dans `valeurs` (une colonne absente n'est pas touchée) :
 *   - vide (ou salaire à zéro)        → la copie courante, s'il y en a une, est datée `remplaceeLe` (EFFACEE) ;
 *   - mal formée                      → rien n'entre au coffre ; une copie courante devenue fausse est datée
 *                                       (IGNOREE — la colonne reste seule à porter la valeur) ;
 *   - même empreinte, même clé        → rien (INCHANGEE), ou le titulaire posé s'il manquait (LIEE) ;
 *   - autre valeur                    → l'ancienne copie est datée, une nouvelle est chiffrée (CREEE / REMPLACEE).
 *
 * Une copie n'est jamais effacée : elle est remplacée et datée. L'unicité partielle
 * `DonneeSensible_origine_courante_key` garantit une seule copie courante par colonne.
 *
 * Ce module CHIFFRE et ne déchiffre jamais (il n'importe pas `dechiffrement.ts`) : les actions qui
 * l'appellent peuvent être atteintes par l'assistant sans que l'assistant puisse lire le coffre.
 * Aucun message ne recopie une valeur.
 */

export type IssueCopie = "CREEE" | "REMPLACEE" | "INCHANGEE" | "LIEE" | "EFFACEE" | "VIDE" | "IGNOREE";

export interface ResultatCopie {
  champ: string;
  issue: IssueCopie;
  /** Pour IGNOREE : pourquoi (jamais la valeur). */
  raison?: string;
}

export interface EntreeCopie {
  modele: ModeleSensible;
  origineId: string;
  /** Les colonnes écrites, telles qu'en base (`Decimal` compris). Une colonne absente n'est pas touchée. */
  valeurs: Record<string, unknown>;
  /** La fiche du référentiel, quand elle existe ; sinon la copie est tenue par son origine. */
  titulaire: RefTitulaire | null;
  parId: string | null;
}

export interface DependancesCopie {
  cles?: () => ClesCoffre;
  horloge?: () => Date;
}

/** Ce que la copie lit et écrit — `prisma` ou le client d'une transaction (`tx`). */
export type ClientCopie = Pick<Prisma.TransactionClient, "donneeSensible">;

function colonnesTitulaire(t: RefTitulaire | null): { titulaireType: "PERSONNE" | "ORGANISATION" | null; titulaireId: string | null } {
  if (!t) return { titulaireType: null, titulaireId: null };
  return t.genre === "PERSONNE" ? { titulaireType: "PERSONNE", titulaireId: t.personneId } : { titulaireType: "ORGANISATION", titulaireId: t.organisationId };
}

export async function copierAuCoffre(client: ClientCopie, e: EntreeCopie, dep: DependancesCopie = {}): Promise<ResultatCopie[]> {
  const cles = (dep.cles ?? (() => chargerCles()))();
  const maintenant = (dep.horloge ?? (() => new Date()))();
  const titulaire = colonnesTitulaire(e.titulaire);
  const resultats: ResultatCopie[] = [];

  for (const c of champsDe(e.modele)) {
    if (!(c.champ in e.valeurs)) continue;
    const origine = { origineModele: e.modele, origineId: e.origineId, origineChamp: c.champ };
    const courante = await client.donneeSensible.findFirst({
      where: { ...origine, remplaceeLe: null },
      select: { id: true, nature: true, empreinteHmac: true, cleId: true, titulaireId: true },
    });
    const retirer = async () => {
      if (courante) await client.donneeSensible.update({ where: { id: courante.id }, data: { remplaceeLe: maintenant } });
    };
    const k = classerValeur(c, e.valeurs[c.champ]);

    if (!k.ok && k.vide) {
      await retirer();
      resultats.push({ champ: c.champ, issue: courante ? "EFFACEE" : "VIDE" });
      continue;
    }
    if (!k.ok) {
      await retirer();
      resultats.push({ champ: c.champ, issue: "IGNOREE", raison: k.erreur });
      continue;
    }

    const emp = empreinte(cles, k.nature, k.valeur);
    if (courante && courante.empreinteHmac === emp && courante.nature === k.nature && courante.cleId === cles.id) {
      if (titulaire.titulaireId && courante.titulaireId !== titulaire.titulaireId) {
        await client.donneeSensible.update({ where: { id: courante.id }, data: titulaire });
        resultats.push({ champ: c.champ, issue: "LIEE" });
      } else {
        resultats.push({ champ: c.champ, issue: "INCHANGEE" });
      }
      continue;
    }

    await retirer();
    const id = crypto.randomUUID();
    await client.donneeSensible.create({
      data: {
        id,
        ...titulaire,
        ...origine,
        nature: k.nature,
        ...decomposer(chiffrer(cles, k.nature, id, k.valeur)),
        empreinteHmac: emp,
        derniersCaracteres: derniersCaracteres(k.nature, k.valeur),
        creeParId: e.parId,
        createdAt: maintenant,
      },
    });
    resultats.push({ champ: c.champ, issue: courante ? "REMPLACEE" : "CREEE" });
  }
  return resultats;
}
