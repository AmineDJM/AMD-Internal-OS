import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { sansBloquer } from "@/lib/journal";
import { moisDe, moisPrecedent } from "../domaine/mois";
import { joursAvant, rappelDu } from "../domaine/registres";
import { assurerDepartementInformatique, responsablesInformatique } from "./departement";
import { enveloppeInformatique } from "./budget";
import { dernierTauxFixe, imputerCoutIaDuMois } from "./imputation";

/**
 * LES TÂCHES DE FOND DU DÉPARTEMENT INFORMATIQUE — appelées par `runScheduledJobs` (`lib/scheduled.ts`), bornées dans le
 * processus : un passage toutes les quelques minutes ne relit pas le journal du mois à chaque fois.
 */

const SIX_HEURES = 6 * 3_600_000;
const UNE_HEURE = 3_600_000;
let dernierCoutIa = 0;
let dernierRappel = 0;

/**
 * LE COÛT DE L'IA, IMPUTÉ CHAQUE MOIS — d'abord, le budget Informatique de l'année existe pour chaque société active (montants
 * à zéro) ; puis le mois en cours est recalculé (le budget suit la consommation), et le mois écoulé l'est encore pendant les
 * cinq premiers jours (les appels tardifs du dernier soir y entrent). Au DERNIER TAUX fixé par une personne ; sans taux fixé,
 * rien n'est imputé — l'écran « Consommation IA » demande de le fixer.
 */
export async function tacheCoutIa(maintenant: Date = new Date(), force = false): Promise<{ mois: string[]; ignore?: string }> {
  if (!force && maintenant.getTime() - dernierCoutIa < SIX_HEURES) return { mois: [], ignore: "passage récent" };
  dernierCoutIa = maintenant.getTime();
  const societes = await prisma.company.findMany({ where: { isActive: true }, select: { id: true } });
  for (const s of societes) {
    await assurerDepartementInformatique(s.id).catch(sansBloquer("informatique.tache.departement"));
    await enveloppeInformatique(s.id, maintenant, null).catch(sansBloquer("informatique.tache.enveloppe"));
  }
  const taux = await dernierTauxFixe();
  if (taux === null) return { mois: [], ignore: "aucun taux USD → DZD fixé" };
  const courant = moisDe(maintenant);
  const jourAlger = new Date(maintenant.getTime() + UNE_HEURE).getUTCDate();
  const mois = jourAlger <= 5 ? [moisPrecedent(courant), courant] : [courant];
  for (const m of mois) await imputerCoutIaDuMois({ mois: m, taux, acteurId: null });
  return { mois };
}

/**
 * LE RAPPEL DE RENOUVELLEMENT D'UN ABONNEMENT — une fois par échéance, au responsable du département Informatique de la
 * société (à défaut, à qui a saisi l'abonnement). Le rappel est RÉSERVÉ avant l'envoi (écriture conditionnelle) : deux
 * passages simultanés n'envoient pas deux fois.
 */
export async function tacheRappelsAbonnements(maintenant: Date = new Date(), force = false): Promise<number> {
  if (!force && maintenant.getTime() - dernierRappel < UNE_HEURE) return 0;
  dernierRappel = maintenant.getTime();
  const horizon = new Date(maintenant.getTime() + 366 * 86_400_000);
  const abonnements = await prisma.abonnementInformatique.findMany({
    where: { statut: "ACTIF", echeance: { not: null, lte: horizon } },
    select: { id: true, companyId: true, fournisseur: true, objet: true, statut: true, echeance: true, rappelJours: true, rappelEnvoyePour: true, createdById: true },
  });
  const dus = abonnements.filter((a) => rappelDu(a, maintenant));
  if (dus.length === 0) return 0;
  const responsables = await responsablesInformatique([...new Set(dus.map((a) => a.companyId))]);
  let envoyes = 0;
  for (const a of dus) {
    const reserve = await prisma.abonnementInformatique.updateMany({
      where: { id: a.id, statut: "ACTIF", echeance: a.echeance, OR: [{ rappelEnvoyePour: null }, { rappelEnvoyePour: { not: a.echeance! } }] },
      data: { rappelEnvoyePour: a.echeance },
    });
    if (reserve.count === 0) continue;
    const destinataire = responsables.get(a.companyId) ?? a.createdById;
    if (!destinataire) continue;
    const j = joursAvant(a.echeance!, maintenant);
    await notifyUser({
      userId: destinataire, type: "DEADLINE_NEAR",
      title: `Renouvellement : ${a.fournisseur} — ${a.objet}`,
      body: j >= 0 ? `Échéance dans ${j} jour(s), le ${a.echeance!.toISOString().slice(0, 10)}.` : `Échéance dépassée depuis ${-j} jour(s).`,
      link: `/informatique/abonnements?abonnement=${a.id}`,
    });
    envoyes += 1;
  }
  return envoyes;
}
