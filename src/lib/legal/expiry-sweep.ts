import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { anyRoleFilter, rolesWithModule } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import { predicatEntitePermise } from "@/lib/company";
import { expiryLevel, daysLeft, shouldRemind, expiryMessage, REMIND_SOON_DAYS } from "./lifecycle";
import { sansBloquer } from "@/lib/journal";

/**
 * LE BALAYAGE DES ÉCHÉANCES — ce qui fait que la règle sert à quelque chose.
 *
 * `lifecycle.ts` sait dire, pour un document et un jour donnés, s'il faut rappeler et quoi dire.
 * Tant que personne ne le lui demande, un contrat arrive à terme dans l'indifférence générale.
 * Ce module est celui qui pose la question, tous les jours, pour toute la base.
 *
 * Il fait deux choses, et pas une de plus :
 *  1. il ALIGNE le statut — un contrat dont le terme est passé devient EXPIRED en base, sans
 *     attendre que quelqu'un rouvre la fiche (le statut effectif était déjà calculé à la lecture ;
 *     ici on l'écrit, pour que les filtres et les compteurs disent la même chose) ;
 *  2. il PRÉVIENT, à l'entrée dans une zone d'urgence et pas tous les jours — c'est `shouldRemind`
 *     qui tranche, et `lastRemindedAt` qui s'en souvient.
 *
 * QUI est prévenu : ceux qui peuvent AGIR (droit d'écriture sur le module Legal) et celui qui a
 * enregistré le document. Prévenir tout le monde reviendrait à ne prévenir personne.
 */

/** Bornes de sécurité : un passage ne doit jamais monopoliser la base ni la file de notifications. */
const MAX_DOCS_PER_RUN = 300;

/** Combien de documents ont été traités — utile aux tests et au journal. */
export interface LegalSweepResult {
  expired: number;
  reminded: number;
  notified: number;
}

/**
 * Un passage. Ne lève jamais : une échéance non annoncée est un problème, un planificateur
 * arrêté par une exception en est un plus grave.
 */
export async function runLegalExpirySweep(now: Date = new Date()): Promise<LegalSweepResult> {
  const out: LegalSweepResult = { expired: 0, reminded: 0, notified: 0 };
  try {
    // On ne charge QUE ce qui peut bouger : un document sans terme, annulé ou déjà renouvelé
    // n'a rien à dire, et un terme au-delà de la première zone de rappel non plus.
    const horizon = new Date(now.getTime() + REMIND_SOON_DAYS * 86_400_000);
    const docs = await prisma.legalDocument.findMany({
      where: {
        endDate: { not: null, lte: horizon },
        status: { in: ["ACTIVE", "EXPIRED"] },
      },
      select: {
        id: true, title: true, reference: true, status: true, endDate: true,
        lastRemindedAt: true, createdById: true, companyId: true,
        readers: { select: { userId: true } },
      },
      orderBy: { endDate: "asc" },
      take: MAX_DOCS_PER_RUN,
    });
    if (docs.length === 0) return out;

    // Les destinataires « métier » sont les mêmes pour tout le passage : une seule requête.
    const managers = await prisma.user.findMany({
      where: { isActive: true, ...anyRoleFilter(rolesWithModule("LEGAL", "UPDATE")) },
      select: { id: true, role: true },
    });
    // LA SOCIÉTÉ DE CHAQUE GESTIONNAIRE, lue une fois pour tout le passage (audit 360°, S7) : le rappel
    // donnait le titre et la référence d'un contrat à tous les gestionnaires Legal du groupe — ceux
    // d'une autre société, et ceux qu'un document RESTREINT n'a pas désignés.
    const societes = new Map(await Promise.all(managers.map(async (m) => [m.id, await predicatEntitePermise(m.id)] as const)));

    for (const doc of docs) {
      const level = expiryLevel(doc, now);
      const remind = shouldRemind(doc, now);

      // 1. ALIGNEMENT DU STATUT — le terme est passé, la base doit le dire.
      if (level === "OVERDUE" && doc.status === "ACTIVE") {
        const claimed = await prisma.legalDocument.updateMany({
          where: { id: doc.id, status: "ACTIVE" },
          data: { status: "EXPIRED" },
        });
        if (claimed.count > 0) {
          out.expired++;
          await recordAudit({
            action: "UPDATE", module: "Legal", entityId: doc.id,
            field: "status", oldValue: "ACTIVE", newValue: "EXPIRED",
            summary: `« ${doc.title} » est arrivé à terme — statut aligné automatiquement`,
          });
        }
      }

      if (!remind) continue;
      const message = expiryMessage(level, daysLeft(doc, now), doc.title);
      if (!message) continue;

      // 2. LE VERROU : on marque AVANT d'envoyer, et seulement si personne ne l'a fait entre
      // temps. Deux instances qui balayent en même temps n'enverront pas deux notifications.
      const claimed = await prisma.legalDocument.updateMany({
        where: { id: doc.id, lastRemindedAt: doc.lastRemindedAt },
        data: { lastRemindedAt: now },
      });
      if (claimed.count === 0) continue;
      out.reminded++;

      const lecteurs = new Set(doc.readers.map((r) => r.userId));
      const peutLire = (m: { id: string; role: string }) =>
        // Restreint : ses lecteurs désignés (et le Super Admin, qui lit tout) ; ouvert : tout gestionnaire.
        (lecteurs.size === 0 || lecteurs.has(m.id) || m.role === "SUPER_ADMIN")
        && (societes.get(m.id)?.(doc.companyId) ?? false);
      const recipients = [...new Set([...managers.filter(peutLire).map((m) => m.id), doc.createdById].filter((id): id is string => Boolean(id)))];
      for (const userId of recipients) {
        await notifyUser({
          userId,
          type: level === "OVERDUE" ? "LATE" : "DEADLINE_NEAR",
          title: message.title,
          body: doc.reference ? `${message.body} (réf. ${doc.reference})` : message.body,
          // Le module n'a pas (encore) de fiche par document : on renvoie sur la liste, avec le
          // filtre « échéances » déjà posé. Mieux vaut une destination qui existe qu'un lien mort.
          link: "/legal?echeances=1",
        }).catch(sansBloquer("expiry-sweep.runLegalExpirySweep.notifyUser"));
        out.notified++;
      }
    }
  } catch (err) {
    console.error("[legal] balayage des échéances échoué", err);
  }
  return out;
}
