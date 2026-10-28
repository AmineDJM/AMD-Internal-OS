import { reduire, type ResultatReduction } from "./reduction";
import { profilReduction } from "./politique";
import { sansBloquer } from "@/lib/journal";

/**
 * LA MÉMOIRE DES RÉDUCTIONS — pour qu'un fichier regardé dans le menu puis téléchargé ne soit pas
 * réduit DEUX fois.
 *
 * Choix assumé : un cache EN MÉMOIRE du processus, borné et à durée de vie courte — pas une table.
 * La version réduite n'est jamais un fait stocké (elle se recalcule à l'identique depuis
 * l'original) ; la ranger en base doublerait le stockage et créerait une seconde vérité qui
 * prendrait du retard (§118.5). Perdue au redémarrage, elle se recalcule : un coût, jamais une erreur.
 *
 * Clé = l'EMPREINTE du clair (`FileBlob.sha256`) + la version du réducteur : le contenu change,
 * la clé change — rien de périmé ne peut être servi. Sans empreinte (ancien fichier sur disque),
 * pas de cache.
 */

/** À changer dès que le résultat d'une réduction peut changer pour les mêmes octets. */
export const VERSION_REDUCTION = 1;

const TTL_MS = 15 * 60_000;
const BUDGET_OCTETS = 96 * 1024 * 1024;
/** Au-delà, le verdict (la taille) est gardé mais pas les octets : on recalcule au téléchargement. */
const MAX_OCTETS_PAR_ENTREE = 24 * 1024 * 1024;
const DELAI_MAX_MS = 90_000;

interface Entree { resultat: ResultatReduction; garde: boolean; expire: number; poids: number }
const cache = new Map<string, Entree>();
const enVol = new Map<string, Promise<ResultatReduction>>();
let poidsTotal = 0;

function purger() {
  const maintenant = Date.now();
  for (const [k, e] of cache) if (e.expire <= maintenant) { poidsTotal -= e.poids; cache.delete(k); }
  // LRU : la Map garde l'ordre d'insertion ; une lecture ré-insère. On retire les plus anciennes.
  while (poidsTotal > BUDGET_OCTETS && cache.size > 0) {
    const [k, e] = cache.entries().next().value as [string, Entree];
    poidsTotal -= e.poids; cache.delete(k);
  }
}

export interface DemandeReduction {
  /** Empreinte du clair d'origine ; nul = pas de cache. */
  empreinte: string | null;
  nom: string;
  mime: string | null;
  /** Taille connue sans lire : le profil statique est jugé AVANT de charger quoi que ce soit. */
  taille: number | null;
  charger: () => Promise<Buffer | null>;
}

/**
 * La réduction, avec cache et appel unique (deux demandes simultanées du même fichier n'en lancent
 * qu'une). `avecOctets: false` pour une simple estimation : un verdict en cache suffit.
 */
export async function obtenirReduction(d: DemandeReduction, opts: { avecOctets: boolean }): Promise<ResultatReduction> {
  const profil = profilReduction(d.nom, d.mime, d.taille);
  if (!profil.nature) return { ok: false, raison: profil.raison || "Déjà optimisé." };
  const cle = d.empreinte ? `${VERSION_REDUCTION}:${d.empreinte}` : null;
  if (cle) {
    const e = cache.get(cle);
    if (e && e.expire > Date.now()) {
      // Verdict négatif, ou verdict positif dont on n'a pas besoin des octets, ou octets gardés : on répond.
      if (!e.resultat.ok || !opts.avecOctets || e.garde) { cache.delete(cle); cache.set(cle, e); return e.resultat; }
    }
    const lance = enVol.get(cle);
    if (lance) return lance;
  }
  const travail = (async (): Promise<ResultatReduction> => {
    const octets = await d.charger();
    if (!octets) return { ok: false, raison: "Fichier introuvable." };
    let delai: NodeJS.Timeout | undefined;
    const limite = new Promise<ResultatReduction>((r) => { delai = setTimeout(() => r({ ok: false, raison: "L'optimisation a pris trop de temps — original seulement." }), DELAI_MAX_MS); });
    const r = await Promise.race([reduire(octets, d.nom, d.mime), limite]).finally(() => delai && clearTimeout(delai));
    if (cle) {
      const garde = !r.ok || r.octets.length <= MAX_OCTETS_PAR_ENTREE;
      const poids = r.ok && garde ? r.octets.length : 0;
      purger();
      const ancien = cache.get(cle);
      if (ancien) { poidsTotal -= ancien.poids; cache.delete(cle); }
      cache.set(cle, { resultat: r, garde, expire: Date.now() + TTL_MS, poids });
      poidsTotal += poids;
      purger();
    }
    return r;
  })();
  if (cle) {
    enVol.set(cle, travail);
    travail.finally(() => enVol.delete(cle)).catch(sansBloquer("reduction-cache.obtenirReduction"));
  }
  return travail;
}

/** Pour les bancs : vide la mémoire. */
export function _viderCacheReductions(): void { cache.clear(); enVol.clear(); poidsTotal = 0; }
export function _etatCacheReductions(): { entrees: number; octets: number } { return { entrees: cache.size, octets: poidsTotal }; }
