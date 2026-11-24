import { prisma } from "@/lib/prisma";
import { notifyRoles, notifyUser } from "@/lib/notify";
import { anyRoleFilter } from "@/lib/rbac";
import { sansBloquer } from "@/lib/journal";
import { bilan, type BilanTexte } from "@/lib/taches-de-fond/executer";
import { A_DECLARER_PV } from "./regles";
import { etatEcheancePv, palierAAlerterPv, type PalierPv } from "./declaration";
import { lireReglagesPv } from "./reglages";

/**
 * PHARMACOVIGILANCE — LES ALERTES DU DÉLAI DE DÉCLARATION (Super Admin, 24/11/2026). Même doctrine que les échéances
 * des marchés PCH (`pch/deadline-sweep.ts`) : la règle (paliers J-5, J-2, jour J, dépassement) est PURE dans
 * `declaration.ts` ; ce passage la pose pour toute la base et prévient À L'ENTRÉE d'un palier, une fois — jamais
 * chaque jour. L'alerte se tait dès que la déclaration est enregistrée ou le cas clos.
 *
 * QUI : le Responsable réglementaire (rôle) et le DÉCLARANT — la personne de Regulatory qui porte le cas (celle qui l'a
 * évalué, sinon celle qui a demandé des informations). Le KAM qui a signalé n'est pas prévenu : il ne déclare pas.
 */

/** Au-delà, le passage suivant reprend : la pharmacovigilance porte quelques dizaines de cas ouverts, pas des milliers. */
const MAX_CAS_PAR_PASSAGE = 500;

export const lienCasPvRegulatory = (id: string) => `/regulatory/pharmacovigilance/${id}`;

const TITRES: Record<PalierPv, (ref: string) => string> = {
  J5: (ref) => `${ref} — déclaration à l'autorité sous 5 jours`,
  J2: (ref) => `${ref} — déclaration à l'autorité sous 48 h`,
  J0: (ref) => `${ref} — déclaration à l'autorité AUJOURD'HUI`,
  DEPASSE: (ref) => `${ref} — délai de déclaration DÉPASSÉ`,
};

/** Le déclarant d'un cas : qui l'a évalué, sinon qui a demandé des informations ; `null` tant que personne ne l'a pris. */
export function declarantDuCasPv(cas: { evalueParId: string | null; investigationOpenedById: string | null }): string | null {
  return cas.evalueParId ?? cas.investigationOpenedById ?? null;
}

/** Les Responsables réglementaires actifs (rôle principal ou second). */
export async function responsablesReglementaires(): Promise<string[]> {
  return (await prisma.user.findMany({ where: { isActive: true, ...anyRoleFilter(["HEAD_OF_REGULATORY"]) }, select: { id: true } })).map((u) => u.id);
}

/** Un passage. Ne lève jamais : le planificateur ne meurt pas d'un rappel. */
export async function alerterEcheancesPv(maintenant: Date = new Date()): Promise<BilanTexte> {
  const reglages = await lireReglagesPv();
  const cas = await prisma.pharmacovigilanceCase.findMany({
    where: { declareLe: null, status: { in: [...A_DECLARER_PV] } },
    select: {
      id: true, reference: true, status: true, productLabel: true, institutionName: true, declareLe: true, dateConnaissance: true,
      evalGrave: true, severity: true, alertePalier: true, evalueParId: true, investigationOpenedById: true,
    },
    orderBy: { dateConnaissance: "asc" },
    take: MAX_CAS_PAR_PASSAGE,
  });
  let alertes = 0, envois = 0;
  let responsables: string[] | null = null;
  for (const c of cas) {
    const etat = etatEcheancePv(c, reglages.delais, maintenant);
    const palier = palierAAlerterPv(etat?.palier ?? null, c.alertePalier);
    if (!etat || !palier) continue;
    // LE VERROU : marquer AVANT d'envoyer, et seulement si personne ne l'a fait entre-temps — deux exécutants qui
    // balayent ensemble n'enverront pas deux fois.
    const pris = await prisma.pharmacovigilanceCase.updateMany({
      where: { id: c.id, alertePalier: c.alertePalier, declareLe: null },
      data: { alertePalier: palier, alertePalierLe: maintenant },
    }).catch(sansBloquer("pharmacovigilance.alerterEcheancesPv.verrou", { count: 0 }));
    if (pris.count === 0) continue;
    alertes += 1;
    responsables ??= await responsablesReglementaires().catch(sansBloquer("pharmacovigilance.alerterEcheancesPv.responsables", []));
    const declarant = declarantDuCasPv(c);
    const destinataires = [...new Set([...responsables, ...(declarant ? [declarant] : [])])];
    for (const userId of destinataires) {
      await notifyUser({
        userId, type: palier === "DEPASSE" ? "LATE" : "DEADLINE_NEAR",
        title: TITRES[palier](c.reference),
        body: `${etat.libelle} · ${c.productLabel} · ${c.institutionName} · cas ${etat.grave ? "grave" : "non grave"}`,
        link: lienCasPvRegulatory(c.id),
      }).catch(sansBloquer("pharmacovigilance.alerterEcheancesPv.notifyUser"));
      envois += 1;
    }
  }
  return bilan(`${cas.length} cas à déclarer, ${alertes} palier(s) annoncé(s), ${envois} notification(s)`);
}

/**
 * LE DG EST INFORMÉ D'UN CAS GRAVE — une seule fois par cas (signalé grave ou décès par le KAM, ou évalué grave), sous
 * verrou : la marque s'écrit avant l'envoi. Ne lève jamais.
 */
export async function informerDgCasGravePv(cas: { id: string; reference: string; productLabel: string; institutionName: string }, maintenant: Date = new Date()): Promise<boolean> {
  const pris = await prisma.pharmacovigilanceCase.updateMany({ where: { id: cas.id, dgInformeLe: null }, data: { dgInformeLe: maintenant } })
    .catch(sansBloquer("pharmacovigilance.informerDgCasGravePv.verrou", { count: 0 }));
  if (pris.count === 0) return false;
  await notifyRoles(["GENERAL_MANAGER"], {
    type: "GENERIC", title: `Cas de pharmacovigilance GRAVE — ${cas.reference}`,
    body: `${cas.productLabel} · ${cas.institutionName}. Regulatory le déclare à l'autorité dans le délai.`,
    link: lienCasPvRegulatory(cas.id),
  }).catch(sansBloquer("pharmacovigilance.informerDgCasGravePv.notifyRoles"));
  return true;
}
