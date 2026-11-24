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

/**
 * LA TAILLE D'UN LOT — une borne de sécurité PAR LOT, pas par passage : le balayage reprend après le dernier
 * document lu jusqu'à épuisement. L'ancienne borne (300 documents par passage, les plus anciens termes d'abord,
 * expirés compris) se remplissait d'expirés : au-delà de 300 documents arrivés à terme, plus aucun rappel ne
 * partait pour ce qui ARRIVAIT à échéance (audit des manques, F10 — corrigé le 24/11/2026).
 */
export const TAILLE_LOT_BALAYAGE = 300;

/** Combien de documents ont été traités — utile aux tests et au journal. */
export interface LegalSweepResult {
  expired: number;
  reminded: number;
  notified: number;
}

const STATUTS_BALAYES = ["ACTIVE", "EXPIRED"] as const;
const CHAMPS = {
  id: true, title: true, reference: true, status: true, endDate: true,
  lastRemindedAt: true, createdById: true, companyId: true,
  readers: { select: { userId: true } },
} as const;

type DocBalaye = {
  id: string; title: string; reference: string | null; status: "ACTIVE" | "EXPIRED" | "RENEWED" | "CANCELLED"; endDate: Date | null;
  lastRemindedAt: Date | null; createdById: string | null; companyId: string | null; readers: { userId: string }[];
};

/** Minuit (heure du serveur) — la frontière que `lifecycle.daysBetween` utilise : avant, le terme est dépassé. */
function debutDuJour(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * Un passage. Ne lève jamais : une échéance non annoncée est un problème, un planificateur
 * arrêté par une exception en est un plus grave.
 *
 * DEUX TEMPS, dans cet ordre :
 *  1. CE QUI ARRIVE À ÉCHÉANCE (terme aujourd'hui ou dans la première zone de rappel) — l'urgent, qui ne doit
 *     jamais attendre derrière l'historique ;
 *  2. LES TERMES PASSÉS — alignement du statut et rappel de dépassement, chacun une seule fois.
 * Chaque temps lit par lots de `TAILLE_LOT_BALAYAGE`, en reprenant après le dernier identifiant lu : la lecture
 * avance toujours, se termine toujours, et n'oublie rien. Idempotent : `updateMany` conditionnels (statut,
 * `lastRemindedAt`) — deux passages, ou deux instances, ne doublent ni l'alignement ni le rappel.
 */
export async function runLegalExpirySweep(now: Date = new Date(), opts: { tailleLot?: number } = {}): Promise<LegalSweepResult> {
  const out: LegalSweepResult = { expired: 0, reminded: 0, notified: 0 };
  const taille = Math.max(1, opts.tailleLot ?? TAILLE_LOT_BALAYAGE);
  try {
    // On ne charge QUE ce qui peut bouger : un document sans terme, annulé ou déjà renouvelé
    // n'a rien à dire, et un terme au-delà de la première zone de rappel non plus.
    const horizon = new Date(now.getTime() + REMIND_SOON_DAYS * 86_400_000);
    const minuit = debutDuJour(now);
    const destinataires = destinatairesDuPassage();

    const temps = [
      { endDate: { gte: minuit, lte: horizon } }, // 1. ce qui arrive à échéance
      { endDate: { lt: minuit } }, // 2. les termes passés
    ];
    for (const fenetre of temps) {
      let apres: string | null = null;
      for (;;) {
        const docs: DocBalaye[] = await prisma.legalDocument.findMany({
          where: { ...fenetre, status: { in: [...STATUTS_BALAYES] }, ...(apres ? { id: { gt: apres } } : {}) },
          select: CHAMPS,
          orderBy: { id: "asc" },
          take: taille,
        });
        for (const doc of docs) await traiterDocument(doc, now, destinataires, out);
        if (docs.length < taille) break;
        apres = docs[docs.length - 1].id;
      }
    }
  } catch (err) {
    console.error("[legal] balayage des échéances échoué", err);
  }
  return out;
}

type Gestionnaire = { id: string; role: string };
type Destinataires = () => Promise<{ managers: Gestionnaire[]; societes: Map<string, (companyId: string | null | undefined) => boolean> }>;

/** Les destinataires « métier » sont les mêmes pour tout le passage : lus une fois, et seulement si un rappel part. */
function destinatairesDuPassage(): Destinataires {
  let lus: ReturnType<Destinataires> | null = null;
  return () => {
    lus ??= (async () => {
      const managers = await prisma.user.findMany({
        where: { isActive: true, ...anyRoleFilter(rolesWithModule("LEGAL", "UPDATE")) },
        select: { id: true, role: true },
      });
      // LA SOCIÉTÉ DE CHAQUE GESTIONNAIRE, lue une fois pour tout le passage (audit 360°, S7) : le rappel
      // donnait le titre et la référence d'un contrat à tous les gestionnaires Legal du groupe — ceux
      // d'une autre société, et ceux qu'un document RESTREINT n'a pas désignés.
      const societes = new Map(await Promise.all(managers.map(async (m) => [m.id, await predicatEntitePermise(m.id)] as const)));
      return { managers, societes };
    })();
    return lus;
  };
}

/** Un document : aligner son statut si le terme est passé, puis rappeler si la zone a changé depuis le dernier rappel. */
async function traiterDocument(doc: DocBalaye, now: Date, destinataires: Destinataires, out: LegalSweepResult): Promise<void> {
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

  if (!remind) return;
  const message = expiryMessage(level, daysLeft(doc, now), doc.title);
  if (!message) return;

  // 2. LE VERROU : on marque AVANT d'envoyer, et seulement si personne ne l'a fait entre
  // temps. Deux instances qui balayent en même temps n'enverront pas deux notifications.
  const claimed = await prisma.legalDocument.updateMany({
    where: { id: doc.id, lastRemindedAt: doc.lastRemindedAt },
    data: { lastRemindedAt: now },
  });
  if (claimed.count === 0) return;
  out.reminded++;

  const { managers, societes } = await destinataires();
  const lecteurs = new Set(doc.readers.map((r) => r.userId));
  const peutLire = (m: Gestionnaire) =>
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
      // La liste, filtre « échéances » déjà posé (`list-view.ts`) : on y voit aussi les termes voisins.
      link: "/legal?echeances=1",
    }).catch(sansBloquer("expiry-sweep.runLegalExpirySweep.notifyUser"));
    out.notified++;
  }
}
