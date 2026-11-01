import { CLE_ADMIN_OPENAI, lireFactureOpenAI, montantsFactures, type PageCouts } from "@/platform/ia/telemetry/facture-openai";
import { prisma } from "@/lib/prisma";
import { additionner, soustraire, type Rapprochement, type Totaux } from "../domaine/consommation-vue";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RAPPROCHEMENT AVEC LA FACTURE D'OPENAI — lot K8, décision 0035.
 *
 * Le journal dit ce que NOUS avons compté ; l'API « Costs » d'OpenAI (`/v1/organization/costs`) dit ce que le
 * fournisseur FACTURE. Les comparer est la seule preuve qu'aucun appel n'échappe au journal. Elle exige une
 * clé ADMINISTRATEUR de l'organisation (`OPENAI_ADMIN_KEY`, distincte de la clé d'API) : sans elle, l'écran
 * dit que le rapprochement n'est pas configuré — il n'invente rien.
 *
 * Limites, dites à l'écran : la facture est par JOUR UTC (le journal, au jour d'Alger) et couvre TOUTE
 * l'organisation (un autre projet sur la même organisation compte aussi) ; seuls les appels OpenAI du journal
 * sont comparés.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Somme EXACTE (au micro-dollar) de pages de l'API Costs. */
export function sommeFacture(pages: PageCouts[]): string {
  return additionner(montantsFactures(pages));
}

export async function rapprocherOpenAI(
  debut: Date, fin: Date, _total: Totaux,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<Rapprochement> {
  const lu = await lireFactureOpenAI(debut, fin, opts);
  if (lu.etat === "non_configure") {
    return {
      configure: false,
      message: `Rapprochement non configuré : aucune clé administrateur OpenAI (${CLE_ADMIN_OPENAI}) n'est posée. Les montants affichés sont ceux du journal, calculés à la grille publique — pas la facture du fournisseur.`,
    };
  }
  if (lu.etat === "erreur") return { configure: true, message: `Rapprochement impossible : ${lu.raison}.` };
  const facture = additionner(lu.montants);
  // Le journal, côté OpenAI seulement (tous les fournisseurs « openai* » : texte, audio, GPT-Live).
  const r = await prisma.$queryRawUnsafe<{ cout: string | null; sansTarif: unknown }[]>(
    `SELECT COALESCE(SUM("costUsd"),0)::text AS "cout", SUM(CASE WHEN "costUsd" IS NULL THEN 1 ELSE 0 END) AS "sansTarif"
     FROM "ModelCallLog" WHERE "at" >= $1 AND "at" < $2 AND "provider" LIKE 'openai%'`, debut, fin,
  );
  const journalise = additionner([r[0]?.cout ?? "0"]);
  const ecart = soustraire(facture, journalise);
  const f0 = Number(facture);
  const sansTarif = Number(r[0]?.sansTarif ?? 0);
  return {
    configure: true,
    factureUsd: facture, journaliseUsd: journalise, ecartUsd: ecart,
    ecartPct: f0 > 0 ? Math.round(((f0 - Number(journalise)) / f0) * 10_000) / 100 : null,
    message: `Facture OpenAI (API Costs, jours UTC, toute l'organisation) comparée au journal (appels OpenAI)`
      + `${sansTarif ? ` — ${sansTarif} appel(s) journalisé(s) sans tarif ne sont pas dans la somme` : ""}. Un écart positif = facturé mais non journalisé.`,
  };
}
