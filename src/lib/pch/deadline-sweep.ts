import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { anyRoleFilter, rolesWithModule } from "@/lib/rbac";
import { doitRappelerDepot, type ZoneDepot } from "@/lib/pch/market-math";
import { predicatEntitePermise } from "@/lib/company";
import { sansBloquer } from "@/lib/journal";

/**
 * LE BALAYAGE DES ÉCHÉANCES DE DÉPÔT (§53) — même doctrine que le balayage Legal : la règle
 * (zones J-7 / J-2 / dépassement) vit dans `market-math.ts`, PURE et testée ; ce module pose
 * la question tous les jours pour toute la base et prévient À L'ENTRÉE d'une zone, jamais
 * quotidiennement — une notification par jour est une notification qu'on coupe, et l'on rate
 * alors la vraie.
 *
 * QUI est prévenu : le RESPONSABLE du dossier d'abord (c'est lui qu'on appelle quand
 * l'échéance approche), et ceux qui peuvent agir (droit Modifier sur PCH). Le rappel se tait
 * dès que le dépôt est fait (`submittedAt`) ou que le marché est sorti du chemin (annulé,
 * suspendu, perdu, clôturé).
 */

const MAX_TENDERS_PER_RUN = 100;

const MESSAGES: Record<ZoneDepot, (ref: string, date: string) => { title: string; body: string }> = {
  PROCHE: (ref, date) => ({
    title: `Dépôt ${ref} sous 7 jours`,
    body: `La date limite de dépôt du marché ${ref} est le ${date}. La soumission n'est pas encore déposée.`,
  }),
  URGENTE: (ref, date) => ({
    title: `Dépôt ${ref} sous 48 h`,
    body: `Dernière ligne droite : la date limite de dépôt du marché ${ref} est le ${date}, et la soumission n'est pas déposée.`,
  }),
  DEPASSEE: (ref, date) => ({
    title: `Échéance de dépôt ${ref} dépassée`,
    body: `La date limite de dépôt du marché ${ref} (${date}) est passée sans dépôt enregistré — vérifier, ou consigner le dépôt / l'abandon.`,
  }),
};

export interface PchDeadlineSweepResult {
  reminded: number;
  notified: number;
}

/** Un passage. Ne lève jamais : le planificateur ne doit pas mourir d'un rappel. */
export async function runPchDeadlineSweep(now: Date = new Date()): Promise<PchDeadlineSweepResult> {
  const out: PchDeadlineSweepResult = { reminded: 0, notified: 0 };
  try {
    // On ne charge QUE ce qui peut sonner : échéance posée entrant dans la première zone,
    // dépôt non fait, marché encore sur le chemin nominal.
    const horizon = new Date(now.getTime() + 7 * 86_400_000);
    const tenders = await prisma.pchTender.findMany({
      where: {
        submissionDeadline: { not: null, lte: horizon },
        submittedAt: null,
        status: { notIn: ["CANCELLED", "SUSPENDED", "LOST", "COMPLETED"] },
      },
      select: {
        id: true, reference: true, title: true, submissionDeadline: true,
        deadlineRemindedAt: true, responsibleId: true, createdById: true, companyId: true,
      },
      orderBy: { submissionDeadline: "asc" },
      take: MAX_TENDERS_PER_RUN,
    });
    if (tenders.length === 0) return out;

    const managers = await prisma.user.findMany({
      where: { isActive: true, ...anyRoleFilter(rolesWithModule("PCH", "UPDATE")) },
      select: { id: true },
    });
    // LES GESTIONNAIRES DE LA SOCIÉTÉ DU MARCHÉ, pas tous (§118.184 — audit 360°, S11) : le rappel portait
    // la référence et l'intitulé d'un marché à tous les gestionnaires PCH du groupe, y compris ceux d'une
    // société dont ils ne peuvent pas ouvrir la fiche. Le responsable et l'auteur restent prévenus — la
    // fiche leur est ouverte (`clauseMarchesPchVisibles`, « fiche »). La règle est calculée UNE fois par
    // personne, pas une fois par marché.
    const societes = new Map(await Promise.all(managers.map(async (m) => [m.id, await predicatEntitePermise(m.id)] as const)));

    for (const t of tenders) {
      const zone = doitRappelerDepot(t.submissionDeadline!, t.deadlineRemindedAt, now);
      if (!zone) continue;

      // LE VERROU : marquer AVANT d'envoyer, et seulement si personne ne l'a fait entre
      // temps — deux instances qui balayent ensemble n'enverront pas deux fois.
      const claimed = await prisma.pchTender.updateMany({
        where: { id: t.id, deadlineRemindedAt: t.deadlineRemindedAt },
        data: { deadlineRemindedAt: now },
      });
      if (claimed.count === 0) continue;
      out.reminded++;

      const dateFr = t.submissionDeadline!.toLocaleDateString("fr-FR");
      const message = MESSAGES[zone](t.reference, dateFr);
      const recipients = [...new Set(
        [t.responsibleId, t.createdById, ...managers.filter((m) => societes.get(m.id)?.(t.companyId)).map((m) => m.id)]
          .filter((id): id is string => Boolean(id)),
      )];
      for (const userId of recipients) {
        await notifyUser({
          userId,
          type: zone === "DEPASSEE" ? "LATE" : "DEADLINE_NEAR",
          title: message.title,
          body: t.title ? `${message.body} (${t.title})` : message.body,
          link: `/pch/${t.id}`,
        }).catch(sansBloquer("deadline-sweep.runPchDeadlineSweep.notifyUser"));
        out.notified++;
      }
    }
  } catch (err) {
    console.error("[pch] balayage des échéances de dépôt échoué", err);
  }
  return out;
}
