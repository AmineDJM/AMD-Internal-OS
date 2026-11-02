import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { getAppSettings } from "@/lib/settings";
import { canOpenCorpusPage } from "@/lib/org-chart-access";
import { regCan } from "../access";
import { regAudit } from "../audit";
import { watchAnppPages } from "./ingest-catalog";
import { ANPP_WATCH_PAGES } from "./catalog";
import { sansBloquer } from "@/lib/journal";

/**
 * VEILLE AUTOMATIQUE DES PUBLICATIONS ANPP — une fois par jour.
 *
 * Pourquoi automatiser : l'ANPP publie et met à jour **sans préavis**. Une ligne directrice qui
 * change sans qu'on le sache, ce n'est pas une nouvelle qu'on rate — c'est une analyse qui
 * devient fausse en silence, puis une réserve qu'on n'aura pas vue venir. La veille manuelle
 * suppose qu'on y pense ; celle-ci non.
 *
 * Ce que la veille fait, et surtout ce qu'elle NE fait PAS :
 *   • elle compare l'empreinte des pages surveillées à celle du dernier relevé ;
 *   • elle **prévient** les personnes qui peuvent agir quand quelque chose a bougé ;
 *   • elle **n'ingère rien** et **n'active rien** : décider qu'un texte entre au corpus et fait
 *     foi reste un acte humain.
 *
 * Idempotence sans nouvelle table : le dernier passage se lit dans le journal d'audit
 * (`CORPUS_WATCHED`). Un relevé par jour au plus, quel que soit le nombre de ticks.
 */

const WATCH_INTERVAL_MS = 24 * 60 * 60_000;

const watchEnabled = () => (process.env.REG_ANPP_WATCH ?? "1") !== "0";

/** Le relevé est-il dû ? Vrai si aucun n'a eu lieu depuis 24 h. */
async function isDue(): Promise<boolean> {
  try {
    const last = await prisma.regulatoryAuditLog.findFirst({
      where: { action: "CORPUS_WATCHED" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    return !last || Date.now() - last.createdAt.getTime() >= WATCH_INTERVAL_MS;
  } catch (e) {
    console.error("[corpus] lecture du dernier relevé impossible", e);
    return false; // en cas de doute on ne relève pas : mieux vaut rater un jour que marteler l'ANPP
  }
}

/**
 * Relève les pages ANPP si c'est dû, et prévient qui de droit en cas de changement.
 * Ne lève jamais : une veille en panne ne doit pas arrêter les autres tâches périodiques.
 */
export async function runAnppWatchIfDue(): Promise<void> {
  if (!watchEnabled() || ANPP_WATCH_PAGES.length === 0) return;
  if (!(await isDue())) return;

  try {
    // Marqueur écrit AVANT le relevé : si le réseau met deux minutes à répondre, un autre tick
    // ne doit pas lancer un second relevé en parallèle.
    await regAudit({
      actorId: "system", action: "CORPUS_WATCHED",
      detail: `Veille ANPP automatique lancée sur ${ANPP_WATCH_PAGES.length} page(s).`,
    });

    const findings = await watchAnppPages(null);
    const changed = findings.filter((f) => f.changed);
    const failed = findings.filter((f) => !f.ok);

    await regAudit({
      actorId: "system", action: "CORPUS_WATCH_RESULT",
      detail: changed.length > 0
        ? `Veille ANPP : ${changed.length} page(s) modifiée(s) depuis le dernier relevé — ${changed.map((c) => c.title).join(" ; ")}.`
        : `Veille ANPP : aucun changement${failed.length > 0 ? ` (${failed.length} page(s) injoignable(s))` : ""}.`,
    });

    if (changed.length > 0) await alertRegulatory(changed.length);
  } catch (e) {
    console.error("[corpus] veille automatique impossible", e);
  }
}

/**
 * Qui reçoit l'alerte : ceux qui gèrent le corpus ET pour qui l'écran s'ouvre. Sans ce second
 * critère la notification menait à « Introuvable » (module Analyse CTD non débloqué, ou Super Admin
 * seulement en rôle secondaire) : le lien ne doit jamais pointer vers un écran fermé.
 */
export function corpusAlertTargets<U extends { role: UserRole; secondaryRole?: UserRole | null }>(
  users: U[],
  settings: { regEnrollmentEnabled: boolean; regEnrollmentRoles: string[] },
): U[] {
  return users.filter((u) => regCan(u, "regulatory.corpus.manage") && canOpenCorpusPage(u, settings));
}

/**
 * Prévient les personnes qui peuvent réellement agir : celles qui gèrent le corpus. Inutile
 * d'alerter tout le monde d'une chose que personne d'autre ne peut traiter.
 */
async function alertRegulatory(changedCount: number): Promise<void> {
  try {
    const users = await prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, role: true, secondaryRole: true },
      take: 200,
    });
    const settings = await getAppSettings();
    const targets = corpusAlertTargets(users, settings);
    await Promise.all(targets.map((u) =>
      notifyUser({
        userId: u.id,
        type: "GENERIC",
        title: "L'ANPP a publié ou modifié un texte",
        body: `${changedCount} page${changedCount > 1 ? "s ont" : " a"} changé depuis le dernier relevé. À vérifier avant la prochaine soumission.`,
        link: "/regulatory/enregistrement/corpus",
      }).catch(sansBloquer("watch-schedule.alertRegulatory.notifyUser")),
    ));
  } catch (e) {
    console.error("[corpus] alerte de veille impossible", e);
  }
}
