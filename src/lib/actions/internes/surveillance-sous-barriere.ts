import { prismaBrut } from "@/lib/prisma";
import { ADAM_EMAIL } from "@/lib/missions/agent/account";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE GESTE JOUÉ SOUS UNE BARRIÈRE NE S'ADRESSE QU'AUX COMPTES DE SON BANC — tests seulement (F1, 03/11/2026).
 *
 * Le cycle de R2 (`approbation-achat-flow`) : une barrière (`bancs-concurrents.ts`) tient sa table ; le geste joué
 * dessous notifie « toutes les assistantes actives », dont le compte d'un banc voisin ; ce voisin retire son compte à
 * cet instant et attend la barrière (`ON DELETE SET NULL` vers la table tenue) ; la notification attend ce retrait ; la
 * barrière attend la notification. Postgres ne voit pas le cycle (la barrière sonde), et le banc tombe au délai.
 * Ce module en MESURE le premier maillon, à chaque cas des bancs à barrière.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les comptes PERMANENTS de la base de tests, qu'aucun banc ne retire : les notifier sous une barrière ne noue rien. */
const COMPTES_PERMANENTS = ["siege-dg@banc-de-tests.local", ADAM_EMAIL];
/**
 * L'état est celui du PROCESSUS, comme le client de base qui le porte (`globalThis`) : chaque fichier de test réévalue
 * ses modules, et un intergiciel posé à chaque fichier s'empilerait. Les comptes que ce processus a créés (ses bancs),
 * les écarts relevés, et le juge « une barrière de ce processus est ouverte » du fichier en cours.
 */
type Etat = { comptes: Set<string>; ecarts: string[]; ouverte: () => Promise<boolean>; installee: boolean };
const ETAT: Etat = ((globalThis as { __surveillanceSousBarriere?: Etat }).__surveillanceSousBarriere ??=
  { comptes: new Set(), ecarts: [], ouverte: async () => false, installee: false });
const destinatairesDe = (data: unknown): string[] =>
  [data].flat().map((d) => (d as { userId?: unknown } | null)?.userId).filter((u): u is string => typeof u === "string");

/**
 * LA SURVEILLANCE (posée au chargement de `bancs-concurrents.ts` — avant que les bancs ne créent leurs comptes). Une
 * notification écrite pendant qu'une barrière de ce processus tient sa table, à un compte que ce processus n'a pas
 * créé, est le premier maillon du cycle R2 : ce compte appartient à un banc voisin, qui peut le retirer à cet instant
 * et attendre la barrière (`ON DELETE SET NULL` vers la table tenue) — la notification attend ce retrait, la barrière
 * attend la notification, et rien ne bouge jusqu'au délai. L'écart est noté AVANT l'écriture (une écriture prise dans
 * le cycle ne revient jamais) et fait échouer le cas qui l'a commis, avec le destinataire.
 */
function surveillerLesDestinataires(): void {
  prismaBrut.$use(async (params, next) => {
    if (params.model === "Notification" && ["create", "createMany", "upsert"].includes(params.action)) {
      const a = params.args as { data?: unknown; create?: unknown };
      const etrangers = [...new Set(destinatairesDe(a.data ?? a.create))].filter((u) => !ETAT.comptes.has(u));
      if (etrangers.length > 0 && (await ETAT.ouverte())) {
        const qui = await prismaBrut.user.findMany({ where: { id: { in: etrangers }, email: { notIn: COMPTES_PERMANENTS } }, select: { email: true, role: true } });
        for (const u of qui) ETAT.ecarts.push(`${u.email} (${u.role})`);
      }
    }
    const r = await next(params);
    // Les comptes NÉS ici, pas ceux qu'on y lit (la liste des assistantes que l'annulation va prévenir en est une lecture).
    if (params.model === "User" && ["create", "createMany", "upsert"].includes(params.action)) {
      for (const u of [r].flat()) if (u && typeof (u as { id?: unknown }).id === "string") ETAT.comptes.add((u as { id: string }).id);
      if (params.action === "createMany") {
        const emails = [(params.args as { data?: unknown }).data].flat().map((d) => (d as { email?: unknown } | null)?.email).filter((e): e is string => typeof e === "string");
        for (const u of await prismaBrut.user.findMany({ where: { email: { in: emails } }, select: { id: true } })) ETAT.comptes.add(u.id);
      }
    }
    return r;
  });
}

/** Les écarts relevés depuis le dernier appel — et la liste remise à zéro (le cas suivant repart propre). */
export function ecartsDesGestesSousBarriere(): string[] {
  return ETAT.ecarts.splice(0);
}

/**
 * Appelée par `bancs-concurrents.ts` à chaque fichier de test qui le charge : l'intergiciel est posé une fois par
 * processus, le juge de barrière est celui du fichier, et le cas qui a commis un écart échoue (`afterEach`).
 */
export async function surveillerSousBarriere(barriereOuverteIci: () => Promise<boolean>): Promise<void> {
  ETAT.ouverte = barriereOuverteIci;
  if (!ETAT.installee) { ETAT.installee = true; surveillerLesDestinataires(); }
  const { afterEach } = await import("vitest");
  afterEach(() => {
    const e = ecartsDesGestesSousBarriere();
    if (e.length > 0) {
      throw new Error(`Sous la barrière, le geste a notifié ${e.length} compte(s) qui ne sont pas à ce banc : ${[...new Set(e)].join(", ")}. `
        + "Un compte voisin retiré à cet instant noue un cycle de verrous que Postgres ne voit pas (R2) : le geste joué sous la barrière ne "
        + "s'adresse qu'aux comptes du banc — une demande confiée, un destinataire nommé (bancs-concurrents.ts).");
    }
  });
}

