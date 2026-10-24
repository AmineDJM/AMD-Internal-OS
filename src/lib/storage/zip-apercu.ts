import { fluxEntreeZip, ErreurZip, type EntreeZip, type SourceZip } from "@/lib/storage/zip-lecteur";
import { dispositionPourBucket } from "@/lib/http/types-actifs";
import { headObjectSize, presignGetUrl, putObjectStream } from "@/lib/storage/object-storage";
import { contentDisposition } from "@/lib/http/content-disposition";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CACHE D'APERÇU DES ENTRÉES D'ARCHIVE — une grosse entrée compressée est décompressée UNE FOIS dans le bucket,
 * puis le navigateur la lit dans le bucket, PAR PLAGES (Direction, 06/10 : « je ne veux pas ce ressenti »).
 *
 *  • Une seule extraction par entrée : les demandes simultanées (survol, clic, « Nouvel onglet ») partagent la même
 *    promesse ; une entrée déjà extraite (même par une autre instance, avant un redémarrage) est reconnue par un HEAD.
 *  • Deux extractions au plus à la fois : le pic mémoire reste celui de deux téléversements en plusieurs parties.
 *  • L'objet n'apparaît dans le bucket qu'à la finalisation du multipart : un objet présent est un objet COMPLET.
 *  • Un échec se souvient 30 s (pas de martèlement), puis on réessaie.
 *
 * Règles pures (seuils, clé, plages) : `zip-apercu-regles.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Validité de l'adresse signée : le lecteur PDF continue de demander des plages pendant la lecture. */
const VALIDITE_APERCU_S = 2 * 3600;
const MAX_SIMULTANEES = 2;
const MAX_PRETS_MEMORISES = 2000;
const OUBLI_ECHEC_MS = 30_000;

export interface EtatApercu {
  pret: boolean;
  octets: number;
  total: number;
  /** L'extraction a échoué : `zip` si l'archive elle-même est en cause (message lisible), sinon une panne de stockage. */
  echec?: { message: string; zip: boolean };
}

interface Extraction { promesse: Promise<void>; octets: number; total: number; echec?: { message: string; zip: boolean } }

const extractions = new Map<string, Extraction>();
/** Clés déjà extraites (mémoire de l'instance, bornée) : on s'épargne le HEAD. */
const prets = new Map<string, true>();

let actives = 0;
const enAttente: (() => void)[] = [];
function prendre(): Promise<void> {
  if (actives < MAX_SIMULTANEES) { actives++; return Promise.resolve(); }
  return new Promise((r) => enAttente.push(r));
}
function rendre(): void {
  const suivant = enAttente.shift();
  if (suivant) suivant(); // la place passe directement au suivant
  else actives--;
}

function marquerPret(cle: string): void {
  prets.delete(cle);
  prets.set(cle, true);
  if (prets.size > MAX_PRETS_MEMORISES) prets.delete(prets.keys().next().value as string);
}

/** Démarre (ou rejoint) l'extraction de l'entrée vers `cle`. Ne lève jamais : l'échec est dans la promesse. */
function lancer(cle: string, source: SourceZip, entree: EntreeZip, type: string): Extraction {
  const deja = extractions.get(cle);
  if (deja) return deja;
  const ex: Extraction = { promesse: Promise.resolve(), octets: 0, total: entree.taille };
  ex.promesse = (async () => {
    if ((await headObjectSize(cle).catch(() => null)) === entree.taille) { ex.octets = entree.taille; return; }
    await prendre();
    try {
      const flux = await fluxEntreeZip(source, entree);
      const compte = async function* (): AsyncGenerator<Buffer> {
        for await (const morceau of flux) { ex.octets += (morceau as Buffer).length; yield morceau as Buffer; }
        // Un flux qui s'arrête AVANT la taille annoncée est une entrée tronquée : on n'en fait pas un aperçu.
        if (ex.octets !== entree.taille) throw new ErreurZip("Entrée corrompue (taille décompressée inattendue).");
      };
      await putObjectStream(cle, compte(), type);
    } finally {
      rendre();
    }
  })();
  extractions.set(cle, ex);
  ex.promesse.then(
    () => { marquerPret(cle); extractions.delete(cle); },
    (e: unknown) => {
      const zip = e instanceof ErreurZip;
      ex.echec = { message: zip ? (e as Error).message : "Préparation de l'aperçu impossible.", zip };
      if (!zip) console.error("[zip-apercu] extraction", cle, e instanceof Error ? e.message : e);
      setTimeout(() => { if (extractions.get(cle) === ex) extractions.delete(cle); }, OUBLI_ECHEC_MS).unref?.();
    },
  );
  return ex;
}

/** Attend que l'entrée soit dans le cache (l'extrait si besoin). Lève l'échec d'extraction. */
export async function assurerApercu(cle: string, source: SourceZip, entree: EntreeZip, type: string): Promise<void> {
  if (prets.has(cle)) return;
  const ex = lancer(cle, source, entree, type);
  if (ex.echec) throw ex.echec.zip ? new ErreurZip(ex.echec.message) : new Error(ex.echec.message);
  await ex.promesse;
}

/** Où en est-on ? Démarre l'extraction si personne ne l'a fait, et laisse jusqu'à `attenteMs` pour finir. */
export async function etatApercu(cle: string, source: SourceZip, entree: EntreeZip, type: string, attenteMs = 1200): Promise<EtatApercu> {
  if (prets.has(cle)) return { pret: true, octets: entree.taille, total: entree.taille };
  const ex = lancer(cle, source, entree, type);
  if (!ex.echec) {
    let minuteur: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([ex.promesse.catch(() => undefined), new Promise<void>((r) => { minuteur = setTimeout(r, attenteMs); })]);
    clearTimeout(minuteur);
  }
  if (ex.echec) return { pret: false, octets: ex.octets, total: ex.total, echec: ex.echec };
  return { pret: prets.has(cle), octets: ex.octets, total: ex.total };
}

/** Déjà extraite ? (sans rien démarrer) — pour un téléchargement, qu'on ne fait pas attendre. */
export async function apercuDisponible(cle: string, taille: number): Promise<boolean> {
  if (prets.has(cle)) return true;
  if ((await headObjectSize(cle).catch(() => null)) !== taille) return false;
  marquerPret(cle);
  return true;
}

/** L'adresse signée de l'entrée extraite — le bucket sert les plages ; nom et type sont imposés à la réponse. */
export function adresseApercu(cle: string, nom: string, type: string, dl: boolean): string | null {
  return presignGetUrl(cle, VALIDITE_APERCU_S, {
    // Le bucket ne porte pas de CSP : un type actif (HTML, SVG, XML) s'y télécharge (`lib/http/types-actifs.ts`).
    "response-content-disposition": contentDisposition(nom, dispositionPourBucket(type, dl ? "attachment" : "inline")),
    "response-content-type": type,
  });
}
