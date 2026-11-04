/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE L'ÉCRAN DIT D'UNE CARTE QUI N'ATTEND PLUS (lot C1, décision 0068) — pur, sans import.
 *
 * La Direction, 04/11 : « la carte disparaît, en tout cas le bouton pour appuyer disparaît ». Une carte quitte l'état
 * « à valider » pour une raison qui est TOUJOURS au journal de l'intention (`events`) : la personne l'a ignorée, l'a
 * annulée par un message, l'a corrigée, une nouvelle carte l'a remplacée pour le même objet, elle a expiré, elle a
 * échoué. L'écran ne la fait plus disparaître : il DIT cette raison, à la place des boutons. Ce module lit le journal et
 * rend la phrase ; il ne décide d'aucun retrait.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Un événement du journal d'une intention — `{ status, at }`, plus le contexte d'un retrait quand il y en a un. */
export interface EvenementCarte {
  status?: string;
  at?: string;
  /** Retrait par remplacement : l'identifiant et le libellé de la carte qui la remplace. */
  par?: string;
  parTitre?: string;
  /** Retrait par correction ou annulation dite dans la conversation : un extrait du message. */
  message?: string;
}

/** Les événements d'un journal, lus sans confiance (JSON en base). */
export function evenementsDeCarte(v: unknown): EvenementCarte[] {
  return Array.isArray(v) ? (v.filter((e) => e && typeof e === "object") as EvenementCarte[]) : [];
}

/** Le dernier événement de retrait (CANCELLED*) du journal — c'est lui qui porte la raison. */
function dernierRetrait(events: EvenementCarte[]): EvenementCarte | null {
  for (let k = events.length - 1; k >= 0; k--) if (events[k]?.status?.startsWith("CANCELLED")) return events[k]!;
  return null;
}

const RIEN = "rien n'a été exécuté";

/**
 * LA PHRASE QUI REMPLACE LES BOUTONS, ou `null` quand la carte attend encore (ou a été exécutée : le reçu parle).
 * `expirationH` : le délai réglé par le Super Admin (24 h par défaut), dit dans la phrase d'expiration.
 */
export function motifDeLaCarte(status: string, events: unknown, opts: { expirationH?: number; erreur?: string | null } = {}): string | null {
  const ev = evenementsDeCarte(events);
  switch (status) {
    case "EXPIRED":
      return `Carte expirée : non confirmée dans les ${opts.expirationH ?? 24} h — ${RIEN}. Redemandez-la à Adam si elle est toujours utile.`;
    case "FAILED":
      return `L'exécution n'a pas abouti : ${(opts.erreur ?? "erreur inconnue").replace(/\.$/, "")}. Vérifiez, puis réessayez.`;
    case "CANCELLED": {
      const r = dernierRetrait(ev);
      switch (r?.status) {
        case "CANCELLED_SUPERSEDED":
          if (r.parTitre) return `Carte retirée : remplacée par « ${r.parTitre} » — ${RIEN}.`;
          return r.message
            ? `Carte retirée : vous l'avez corrigée (« ${r.message} ») — ${RIEN}.`
            : `Carte retirée : remplacée par une carte plus récente — ${RIEN}.`;
        case "CANCELLED_BY_USER_MESSAGE":
          return `Carte retirée : vous avez demandé de l'annuler${r.message ? ` (« ${r.message} »)` : ""} — ${RIEN}.`;
        default:
          return `Carte ignorée — ${RIEN}.`;
      }
    }
    default:
      return null;
  }
}

/** Un extrait court et lisible d'un message, pour le journal (jamais le message entier). */
export function extraitDeMessage(message: string, max = 90): string {
  const t = (message ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}
