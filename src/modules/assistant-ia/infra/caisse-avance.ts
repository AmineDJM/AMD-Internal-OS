import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { getGeneralMeans, resolveGeneralMeansDepartment, type GeneralMeansView } from "@/lib/queries/general-means";
import { cashWarning } from "@/lib/general-means/continuous-cash";
import { resultatVide } from "@/platform/ia/lectures/empty-result";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CAISSE D'AVANCE — « LES MOYENS GÉNÉRAUX » D'ADVENTUM (Direction, 02/11/2026 : « moyens généraux en réalité c'est que la
 * caisse d'avance gérée par l'assistante de direction »). Lot T3, décision 0051.
 *
 * Une seule lecture, celle de l'ÉCRAN (`getGeneralMeans`, mêmes droits, même calcul du fond que les actions qui le
 * revérifient) : le solde en main, ce qui attend sa réception, les remises, la prochaine recharge, les rallonges, les
 * dépenses (avec ou sans justificatif, classées ou non), l'alerte de solde bas. Le modèle ne compte rien : les totaux,
 * les manques et les alertes sont calculés ici.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const OUTIL_CAISSE = "lire_caisse_avance";

/** La caisse de la personne — la vue de l'écran, ou la phrase du refus (même règle : module, détentrice, budget). */
export async function caisseDe(user: CurrentUser, annee = new Date().getFullYear()): Promise<{ vue: GeneralMeansView; departementId: string } | { refus: string }> {
  const departementId = await resolveGeneralMeansDepartment(user);
  if (!departementId) return { refus: "Aucune caisse d'avance (moyens généraux) n'est rattachée à votre compte." };
  const vue = await getGeneralMeans(user, departementId, annee);
  if (!vue) return { refus: "La caisse d'avance (moyens généraux) ne vous est pas ouverte : elle est tenue par l'assistante de direction ; le module « Moyens généraux » se règle en Administration › Accès." };
  return { vue, departementId };
}

const dzd = (n: number) => `${new Intl.NumberFormat("fr-FR").format(Math.round(n))} DZD`;

export function lectureCaisseAvance(user: CurrentUser): PowerTool {
  return {
    def: {
      name: OUTIL_CAISSE,
      description: "Lit la CAISSE D'AVANCE (« moyens généraux », « caisse », « petite caisse ») : solde en main, somme à confirmer, remises, prochaine recharge, "
        + "rallonges et leur état, dépenses (libellé, montant, date, justificatif joint ou non, nature), dépenses SANS justificatif, non classées, alerte de solde bas. "
        + "`mois` (AAAA-MM) limite les dépenses listées ; `vue` = synthese (défaut), depenses, sans_justificatif, rallonges, remises.",
      input_schema: {
        type: "object",
        properties: {
          vue: { type: "string", enum: ["synthese", "depenses", "sans_justificatif", "rallonges", "remises"] },
          mois: { type: "string", description: "AAAA-MM" },
        },
      },
    } as PowerTool["def"],
    label: "Caisse d'avance consultée",
    allowed: (u) => u.id === user.id,
    run: async (e, u) => {
      const mois = typeof e.mois === "string" && /^\d{4}-\d{2}$/.test(e.mois) ? e.mois : null;
      const c = await caisseDe(u, mois ? Number(mois.slice(0, 4)) : undefined);
      if ("refus" in c) return JSON.stringify({ statut: "REFUS", raison: c.refus });
      const v = c.vue;
      const vue = typeof e.vue === "string" ? e.vue : "synthese";
      const depenses = v.expenses.filter((x) => x.fromPettyCash && (!mois || x.date.startsWith(mois)));
      const sansPiece = depenses.filter((x) => x.documents.length === 0);
      const nonClassees = depenses.filter((x) => x.toClassify);
      const fond = v.cash?.fund ?? null;
      const ligne = (x: (typeof depenses)[number]) => ({ date: x.date.slice(0, 10), libelle: x.label, montant_dzd: x.amount, justificatif: x.documents.length ? x.documents.map((d) => d.name).join(", ") : null, nature: x.nature, saisie_par: x.createdBy });
      const synthese = {
        departement: v.department.path,
        detentrice: v.cash?.holder ?? v.plan?.holder ?? null,
        vous_detenez_la_caisse: v.isHolder,
        solde_en_main_dzd: fond?.remaining ?? 0,
        recu_dzd: fond?.received ?? 0,
        depense_dzd: fond?.spent ?? 0,
        a_confirmer_dzd: fond?.awaitingAmount ?? 0,
        alerte: cashWarning(fond, dzd),
        solde_bas: fond?.lowOnCash ?? false,
        plan: v.plan ? { montant_mensuel_dzd: v.plan.monthlyAmount, jour_de_recharge: v.plan.rechargeDay, prochaine_recharge: v.plan.nextRechargeAt?.slice(0, 10) ?? null } : null,
        rallonges_en_attente: v.topUps.filter((t) => t.status === "PENDING").map((t) => ({ montant_dzd: t.amountRequested, motif: t.reason, demandee_le: t.createdAt.slice(0, 10) })),
        depenses: { periode: mois ?? `${v.year}`, nombre: depenses.length, total_dzd: depenses.reduce((s, x) => s + x.amount, 0), sans_justificatif: sansPiece.length, non_classees: nonClassees.length },
      };
      if (vue === "synthese") return JSON.stringify(synthese);
      if (vue === "sans_justificatif") return sansPiece.length ? JSON.stringify({ nombre: sansPiece.length, total_dzd: sansPiece.reduce((s, x) => s + x.amount, 0), depenses: sansPiece.map(ligne) }) : resultatVide("Toutes les dépenses de la caisse ont leur justificatif.");
      if (vue === "rallonges") return v.topUps.length ? JSON.stringify(v.topUps.map((t) => ({ montant_demande_dzd: t.amountRequested, accorde_dzd: t.amountGranted, statut: t.status, motif: t.reason, demandee_par: t.requester, le: t.createdAt.slice(0, 10), decision: t.decisionNote }))) : resultatVide("Aucune demande de rallonge.");
      if (vue === "remises") return JSON.stringify({ en_cours: v.cash?.remittances.map((r) => ({ remise_le: r.remittedAt.slice(0, 10), montant_dzd: r.amount, depense_dzd: r.spent, statut: r.status, recue_le: r.receivedAt?.slice(0, 10) ?? null })) ?? [], soldees: v.history.map((r) => ({ periode: r.period, montant_dzd: r.amount, depense_dzd: r.spent })) });
      if (!depenses.length) return resultatVide("Aucune dépense sur la caisse pour cette période.");
      const parNature: Record<string, number> = {};
      for (const x of depenses) parNature[x.nature ?? "Non classée"] = (parNature[x.nature ?? "Non classée"] ?? 0) + x.amount;
      return JSON.stringify({ ...synthese.depenses, par_nature_dzd: parNature, lignes: depenses.slice(0, 80).map(ligne) });
    },
  };
}
