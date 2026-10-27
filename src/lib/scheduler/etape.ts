/**
 * UNE ÉTAPE DU PASSAGE PLANIFIÉ — son échec est DIT, et n'arrête jamais les suivantes.
 *
 * `runScheduledJobs()` enchaîne une cinquantaine de balayages en série. Avant ce module, sept
 * d'entre eux (rappels de réunion, rappels, paie, jobs réglementaires, veille ANPP, lots IA,
 * Pulse) n'avaient pas de `.catch` : le premier qui levait sautait au `catch` global et TOUT ce
 * qui suivait — missions durables, file du site web, balayage Gmail — était perdu pour ce passage.
 * Une erreur déterministe (colonne pas encore migrée, ligne corrompue) les arrêtait donc À CHAQUE
 * passage, sans autre trace qu'un « run failed » anonyme. Une vingtaine d'autres avaient le défaut
 * inverse : `.catch(() => 0)`, l'erreur avalée sans un mot.
 *
 * Ici, chaque étape porte un NOM, s'exécute isolée, et son échec part au journal sous ce nom.
 * Pour ne pas noyer le journal (un passage par minute), une même erreur répétée sur la même étape
 * n'est réécrite qu'une fois l'heure ; un message DIFFÉRENT est toujours écrit, et le retour à la
 * normale aussi.
 */

const RAPPEL_MS = 60 * 60_000;

type Trace = { message: string; ecritA: number; repetitions: number };
const dernieres = new Map<string, Trace>();

type Journal = (...args: unknown[]) => void;

function messageDe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * Exécute `travail` ; ne lève JAMAIS. Renvoie `true` si l'étape a réussi.
 * `journal` et `maintenant` ne servent qu'aux tests.
 */
export async function etape(
  nom: string,
  travail: () => unknown,
  journal: Journal = console.error,
  maintenant: () => number = Date.now,
): Promise<boolean> {
  try {
    await travail();
    const prec = dernieres.get(nom);
    if (prec) {
      dernieres.delete(nom);
      console.info(`[scheduled] ${nom} : rétabli (après ${prec.repetitions} échec(s))`);
    }
    return true;
  } catch (e) {
    const t = maintenant();
    const message = messageDe(e);
    const prec = dernieres.get(nom);
    if (!prec || prec.message !== message || t - prec.ecritA >= RAPPEL_MS) {
      const suffixe = prec && prec.message === message ? ` (répété ${prec.repetitions + 1} fois)` : "";
      journal(`[scheduled] ${nom} : échec${suffixe}`, e);
      dernieres.set(nom, { message, ecritA: t, repetitions: 1 });
    } else {
      prec.repetitions += 1;
    }
    return false;
  }
}

/** Tests uniquement : oublie les échecs mémorisés. */
export function oublierEchecsEtapes(): void {
  dernieres.clear();
}
