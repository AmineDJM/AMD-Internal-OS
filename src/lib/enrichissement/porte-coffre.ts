import { prisma } from "@/lib/prisma";
import { chargerCles, empreinte, type ClesCoffre } from "@/modules/coffre/api";
import { creerServiceCoffre, type EntreeDepot, type ResultatDepot, creerDepotReferentiel } from "@/modules/coffre/api-lecture";
import { normaliser, type NatureCoffre } from "@/modules/coffre/partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PORTE D'ÉCRITURE DE L'ENRICHISSEMENT VERS LE COFFRE — déposer, et calculer une empreinte.
 * JAMAIS LIRE.
 *
 * Le moteur d'enrichissement range au coffre ce qu'il lit sur une pièce (n° de passeport, NIN, RIB,
 * salaire) et retrouve une personne par l'EMPREINTE d'un identifiant — sans jamais déchiffrer quoi
 * que ce soit. Tout son usage du coffre passe par ici, et seulement ces deux gestes : déposer ne
 * révèle rien que l'appelant ne tienne déjà, une empreinte HMAC ne se renverse pas.
 *
 * C'est pourquoi `src/modules/coffre/frontiere.test.ts` reconnaît ce module comme une PORTE D'ÉCRITURE :
 * le graphe d'imports de l'ERP étant presque entièrement connexe (le battement et l'aiguillage des
 * actions rejoignent l'assistant), le test arrête la remontée ici — et vérifie, en échange, que ce
 * fichier n'appelle ni `lire`, ni `chercher`, ni `dechiffrer`. Ajouter une lecture ici casserait le test.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface PorteCoffre {
  deposer(e: EntreeDepot): Promise<ResultatDepot>;
  /** L'empreinte de recherche d'une valeur, ou `null` si elle ne se normalise pas pour cette nature. */
  empreinteDe(nature: NatureCoffre, valeur: string): string | null;
}

export function porteDuCoffre(cles: () => ClesCoffre = () => chargerCles(), horloge?: () => Date): PorteCoffre {
  const service = creerServiceCoffre({ depot: creerDepotReferentiel(prisma), cles, ...(horloge ? { horloge } : {}) });
  return {
    deposer: (e) => service.deposer(e),
    empreinteDe(nature, valeur) {
      const n = normaliser(nature, valeur);
      return n.ok ? empreinte(cles(), nature, n.valeur) : null;
    },
  };
}
